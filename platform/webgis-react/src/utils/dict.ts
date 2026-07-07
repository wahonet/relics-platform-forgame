/**
 * 国标 / 四普编码字典 (TS port of dict.js).
 * 与后端 platform/scripts/codes.py 保持同步。
 */

export type CategoryCode = "0100" | "0200" | "0300" | "0400" | "0500" | "0600";
export type RankCode = "1" | "2" | "3" | "4" | "5";

export interface CategoryEntry {
  label: string;
  color: string;
  icon: string | null;
}

export interface RankEntry {
  label: string;
  short: string;
  size: number;
  prominent: boolean;
}

export const CATEGORY_MAP: Record<string, CategoryEntry> = {
  "0100": { label: "古遗址", color: "#f16a5e", icon: "/static/古文化遗址.png" },
  "0200": { label: "古墓葬", color: "#e3b95e", icon: "/static/古墓葬.png" },
  "0300": { label: "古建筑", color: "#4cc38a", icon: "/static/古建筑.png" },
  "0400": { label: "石窟寺及石刻", color: "#5ea3f7", icon: "/static/石窟寺及石刻.png" },
  "0500": {
    label: "近现代重要史迹及代表性建筑",
    color: "#b79bf5",
    icon: "/static/近现代重要史迹及代表性建筑.png",
  },
  "0600": { label: "其他", color: "#8b99ad", icon: null },
};

export const RANK_MAP: Record<string, RankEntry> = {
  "1": { label: "全国重点文物保护单位", short: "国保", size: 3.5, prominent: true },
  "2": { label: "省级文物保护单位", short: "省保", size: 3, prominent: true },
  "3": { label: "市级文物保护单位", short: "市保", size: 3, prominent: false },
  "4": { label: "县级文物保护单位", short: "县保", size: 2.5, prominent: false },
  "5": {
    label: "尚未核定公布为文物保护单位的不可移动文物",
    short: "未定级",
    size: 2,
    prominent: false,
  },
};

const CATEGORY_ALIAS: Record<string, string> = {
  古遗址: "0100",
  古文化遗址: "0100",
  古墓葬: "0200",
  古建筑: "0300",
  石窟寺及石刻: "0400",
  近现代重要史迹及代表性建筑: "0500",
  近现代史迹: "0500",
  其他: "0600",
};

const RANK_ALIAS: Record<string, string> = {
  全国重点文物保护单位: "1",
  省级文物保护单位: "2",
  市级文物保护单位: "3",
  县级文物保护单位: "4",
  尚未核定公布为文物保护单位的不可移动文物: "5",
  未核定: "5",
  未认定: "5",
  未定级: "5",
};

export function categoryCode(value: string | null | undefined): string {
  if (!value) return "0600";
  const v = String(value).trim();
  if (CATEGORY_MAP[v]) return v;
  return CATEGORY_ALIAS[v] || "0600";
}

export function rankCode(value: string | null | undefined): string {
  if (!value) return "5";
  const v = String(value).trim();
  if (RANK_MAP[v]) return v;
  return RANK_ALIAS[v] || "5";
}

export const categoryLabel = (code: string) =>
  (CATEGORY_MAP[code] || CATEGORY_MAP["0600"]).label;
export const categoryColor = (code: string) =>
  (CATEGORY_MAP[code] || CATEGORY_MAP["0600"]).color;
export const categoryIcon = (code: string) =>
  (CATEGORY_MAP[code] || CATEGORY_MAP["0600"]).icon;

export const rankLabel = (code: string) => (RANK_MAP[code] || RANK_MAP["5"]).label;
export const rankShort = (code: string) => (RANK_MAP[code] || RANK_MAP["5"]).short;
export const rankSize = (code: string) => (RANK_MAP[code] || RANK_MAP["5"]).size;
export const rankProminent = (code: string) =>
  (RANK_MAP[code] || RANK_MAP["5"]).prominent;

const RANK_LABEL_DISTANCE: Record<string, number> = {
  "1": Number.MAX_VALUE,
  "2": 30000,
  "3": 15000,
  "4": 8000,
  "5": 4000,
};
export const rankLabelMaxDistance = (code: string) => RANK_LABEL_DISTANCE[code] || 4000;

export const DEF_COLOR = "#8b99ad";
export const PALETTE = [
  "#f16a5e", "#e3b95e", "#4cc38a", "#5ea3f7", "#b79bf5",
  "#ff8f85", "#f0975c", "#7ee0a3", "#8cc2ff", "#a5d6ff",
  "#d2a8ff", "#f2d491", "#56d4dd", "#f778ba", "#c6d0de",
];

export const ERA_MAP: Record<string, string> = {
  清代: "清", 明代: "明", 民国: "民国", 近现代: "现代",
  宋金辽元: "宋元", 宋金元: "宋元",
  战国至两汉: "战汉", 战汉: "战汉",
  隋唐: "隋唐", 隋唐五代: "隋唐", "隋唐（五代）": "隋唐",
  两晋南北朝: "两晋南北朝", 魏晋南北朝: "两晋南北朝",
  新石器时代: "先秦", 先秦: "先秦", 商周: "先秦",
};
export const ERA_ORDER = [
  "先秦", "战汉", "两晋南北朝", "隋唐", "宋元", "明", "清", "民国", "现代",
];

export const COND_CLS: Record<string, string> = {
  好: "lv-g", 较好: "lv-f", 一般: "lv-a", 较差: "lv-p", 差: "lv-p",
};

export interface DimDef {
  id: string;
  label: string;
  field: string;
  multi?: boolean;
  order?: string[];
  remap?: (v: string) => string;
  transform?: (v: string) => string;
}

/** tier 字段的展示名。 */
export const TIER_MAP: Record<string, string> = {
  city: "市级基础层",
  full: "嘉祥全量层",
};

export const DIMS: DimDef[] = [
  {
    id: "category_main",
    label: "文物类别",
    field: "category_main",
    transform: (v) => (v === "近现代重要史迹及代表性建筑" ? "近现代史迹" : v),
  },
  { id: "county", label: "县区分布", field: "county" },
  {
    id: "township",
    label: "乡镇分布",
    field: "township",
    transform: (v) => v.replace(/^\d+/, ""),
  },
  {
    id: "era",
    label: "年代分布",
    field: "era_stats",
    remap: (v) => {
      for (const [k, mv] of Object.entries(ERA_MAP)) {
        if (v && v.includes(k)) return mv;
      }
      return v || "未知";
    },
    order: ERA_ORDER,
  },
  {
    id: "heritage_level",
    label: "文物级别",
    field: "heritage_level",
    transform: (v) =>
      v === "尚未核定公布为文物保护单位的不可移动文物" || v === "未认定" ? "未核定" : v,
    // 按保护级别从高到低排列(国保 → 未核定)
    order: [
      "全国重点文物保护单位",
      "省级文物保护单位",
      "市级文物保护单位",
      "县级文物保护单位",
      "未核定",
    ],
  },
  {
    id: "condition_level",
    label: "保存状况",
    field: "condition_level",
    order: ["好", "较好", "一般", "较差", "差"],
  },
];

export function dimValue(r: Record<string, unknown>, dim: DimDef): string {
  const raw = r[dim.field];
  const v = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (dim.remap) return dim.remap(v);
  if (dim.transform) return dim.transform(v);
  return v || "未知";
}

export function dimValues(r: Record<string, unknown>, dim: DimDef): string[] {
  if (!dim.multi) return [dimValue(r, dim)];
  const raw = r[dim.field];
  const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const parts = text.replace(/[,，]/g, "、").split("、").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : ["未知"];
}

export function buildColorMap(
  relics: Record<string, unknown>[],
  dim: DimDef,
): Record<string, string> {
  const counts: Record<string, number> = {};
  relics.forEach((r) => {
    dimValues(r, dim).forEach((v) => {
      counts[v] = (counts[v] || 0) + 1;
    });
  });
  const keys = dim.order
    ? dim.order.filter((k) => counts[k])
    : Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const map: Record<string, string> = {};
  keys.forEach((k, i) => {
    if (dim.id === "category_main") {
      map[k] = CATEGORY_MAP[categoryCode(k)]?.color || PALETTE[i % PALETTE.length];
    } else if (dim.id === "heritage_level") {
      map[k] = ["#f16a5e", "#e3b95e", "#b79bf5", "#5ea3f7", "#8b99ad"][Math.min(i, 4)];
    } else {
      map[k] = PALETTE[i % PALETTE.length];
    }
  });
  return map;
}
