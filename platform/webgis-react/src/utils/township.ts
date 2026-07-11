/**
 * 镇街名新旧写法归一。
 *
 * 台账与标准边界对同一乡镇常有不同写法:
 *   - 撤乡设镇/撤镇设街道后只有一方更新:卧龙山街道 ↔ 卧龙山镇、满硐镇 ↔ 满硐乡
 *   - 台账偶带数字前缀:01鲁城街道
 *   - 异体字混用:次邱镇 ↔ 次丘镇、傅村街道 ↔ 付村街道、驩城镇 ↔ 欢城镇
 *
 * 统一按"词干"(去数字前缀、迭代剥掉 街道/镇/乡 后缀、异体字归一)比对,
 * 地图下钻、统计图、筛选器、后端查询参数展开共用这一套规则。
 */

const VARIANT_CHARS: Record<string, string> = { 邱: "丘", 傅: "付", 驩: "欢", 歡: "欢" };

export function normalizeTownship(name: string): string {
  return (name || "")
    .replace(/^\d+/, "")
    .trim()
    .replace(/[邱傅驩歡]/g, (ch) => VARIANT_CHARS[ch] || ch);
}

/** 词干:归一后迭代剥掉行政后缀(嘉祥镇街道 → 嘉祥、夏镇街道 → 夏)。 */
export function townshipStem(name: string): string {
  let out = normalizeTownship(name);
  for (;;) {
    const next = out.replace(/(街道|镇|乡)$/, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 是否同一镇街(容忍新旧名/异体字/数字前缀差异)。 */
export function sameTownship(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeTownship(a) === normalizeTownship(b)) return true;
  const stem = townshipStem(a);
  return !!stem && stem === townshipStem(b);
}

/**
 * 按词干合并镇街写法变体,返回 [展示名(最常见写法), 数量] 列表,数量降序。
 * 统计图与筛选下拉共用,保证两处展示的名称一致。
 */
export function mergeTownshipVariants(names: string[]): { name: string; value: number }[] {
  const byStem = new Map<string, Map<string, number>>();
  names.forEach((raw) => {
    const norm = normalizeTownship(raw);
    if (!norm) return;
    const stem = townshipStem(norm) || norm;
    const variants = byStem.get(stem) || new Map<string, number>();
    variants.set(norm, (variants.get(norm) || 0) + 1);
    byStem.set(stem, variants);
  });
  return [...byStem.values()]
    .map((variants) => {
      const sorted = [...variants.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      return {
        name: sorted[0][0],
        value: sorted.reduce((sum, [, n]) => sum + n, 0),
      };
    })
    .sort((a, b) => b.value - a.value);
}
