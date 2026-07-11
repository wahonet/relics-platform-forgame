"""AI 知识库问答 (OpenAI 兼容协议,流式输出)。

启动时分别预烘焙“文保单位 / 全部文物”统计上下文；每次请求再按
当前 scope 做轻量关键词评分,追加 Top-K 相关文物详情。
问题中出现河流/湖泊名时,另做水系空间检索(点到水系几何的距离),
支持「泗河上的桥类文物有哪些」这类沿线问题。
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from _common import load_config  # noqa: E402
from data_loader import store  # noqa: E402
from relic_scope import SCOPE_PROTECTED, normalize_relic_scope  # noqa: E402
from services import ai_service  # noqa: E402

router = APIRouter()

# 运行时状态,init_chat() 中赋值。
_scope_contexts: dict[str, str] = {}
_project_name: str = "本市"
_project_full_name: str = "文物保护利用平台"
_default_model: str = ""
_available_models: list[dict] = []
_top_k_relics: int = 8
_history_turns: int = 10
_temperature: float = 0.2


def _short_level(level: str) -> str:
    if not level:
        return "未"
    if "全国" in level:
        return "国"
    if "省级" in level:
        return "省"
    if "市级" in level:
        return "市"
    if "县级" in level:
        return "县"
    return "未"


def _build_system_prompt(scope: str = SCOPE_PROTECTED) -> str:
    name = _project_full_name or _project_name
    scope_label = "全部文物（包含未定级不可移动文物）" if scope == "all" else "文物保护单位"
    return f"""你是「{name}」的 AI 助手。当前用户选择的数据口径是“{scope_label}”，回答和地图联动都必须严格限制在此口径内。

数据口径与资料层级是两个独立概念:
- protected 口径:仅国、省、市、县四级文物保护单位
- all 口径:在 protected 基础上再包含未定级不可移动文物
- tier=city/full 只表示资料丰富度,不能用来判断是否为文保单位

回答规则：
1. **严格基于数据回答** —— 下方提供了当前口径的统计与检索结果，请据此回答，不要编造
2. 涉及数量统计时，请亲自数一遍数据再回答，确保数字准确
3. 引用文物时务必带上 **名称** 和 **编号**（如：武氏墓群石刻 JN-JX-0001）
4. 回答结构清晰，善用表格、列表和分组
5. 如果数据中没有相关信息，如实说明「数据库中未找到相关记录」
6. 如果用户问题与文物无关，礼貌引导回文物话题
7. 用中文回答
8. 用户询问巡查建议时,可结合保存状况给出巡查优先级建议(状况差的应更频繁巡查)

数据字段说明：
- 编号：平台数据编号
- 级别缩写：国=全国重点文保单位，省=省级，市=市级，县=县级，未=尚未核定
- 现状：保存状况（好/较好/一般/较差/差）
- 三维：是否已完成三维数字化建模（是/否）
- 附属文物：登记表「文物构成」中的附属项(如碑刻、牌坊、古树),名称后括号是其类别。
  用户按类别问文物时(如"牌坊类文物"),除主体类别外也要检查附属文物栏,
  并明确区分"本体即牌坊"与"附属文物中含牌坊"两类情况

## 地图联动标记（非常重要！）
你的回答会渲染在一个带有地图的平台中。请在回答中积极使用以下标记，让用户可以点击查看地图：

### 标记格式
[[显示文本|动作参数]]

### 标记类型

**1. 筛选文物结果集（提到数量时）**
筛选参数用&连接：cty:县区、t:乡镇、l:级别、c:类别、s:现状、3d:1、kw:关键词
- "共有[[247处|l:省级]]省级文保单位"
- "曲阜市有[[211处|cty:曲阜市]]文物"
- "保存较差的有[[8处|s:较差]]"
- "邹城市的省保有[[12处|cty:邹城市&l:省级]]"
(县区一律用 cty:,乡镇才用 t:)

**2. 具体文物名称（提到某个文物时，用fly:编号定位）**
- "[[武氏墓群石刻|fly:JN-JX-0001]]为东汉石刻"

**3. 县区/乡镇名称（提到时）**
- "位于[[嘉祥县|cty:嘉祥县]]"
- "位于[[纸坊镇|t:纸坊镇]]"

**4. 文物类别（提到类别时）**
- "属于[[古建筑|c:古建筑]]类"

### 使用规则
- 每个实体在回答中**首次出现**时标记，后续不重复标记
- 文物名称务必使用fly:编号格式，编号必须准确
- 表格中的文物名称也要标记
- 不要在同一句话中过度标记，保持可读性"""


def _build_full_context(scope: str = SCOPE_PROTECTED) -> str:
    """拼出全量文物上下文(总体统计 + 按县区分组的清单表格),作为 system prompt 复用。"""
    relics = store.scoped_relics(scope)
    if not relics:
        return ""

    era_c = Counter(r.get("era_stats", "未知") for r in relics)
    cat_c = Counter(r.get("category_main", "未知") for r in relics)
    cond_c = Counter(r.get("condition_level", "未知") for r in relics)
    lvl_c = Counter(_short_level(r.get("heritage_level", "")) for r in relics)
    n3d = sum(1 for r in relics if r.get("has_3d"))
    n_full = sum(1 for r in relics if (r.get("tier") or "city") == "full")

    cnty_groups: dict[str, list] = {}
    for r in relics:
        cnty = r.get("county") or "未知"
        cnty_groups.setdefault(cnty, []).append(r)
    cnty_summary = ", ".join(
        f"{k}{len(v)}处"
        for k, v in sorted(cnty_groups.items(), key=lambda x: -len(x[1]))
    )

    title = f"{_project_name}文物数据库统计"
    stats = (
        f"## {title}\n"
        f"- 记录总数：{len(relics)}处(其中嘉祥县全量层 {n_full} 处)\n"
        f"- 按级别：{', '.join(f'{k}{v}处' for k, v in lvl_c.most_common())}\n"
        f"- 按县区：{cnty_summary}\n"
        f"- 按类别：{', '.join(f'{k}{v}处' for k, v in cat_c.most_common())}\n"
        f"- 按年代：{', '.join(f'{k}{v}处' for k, v in era_c.most_common(15))}\n"
        f"- 按现状：{', '.join(f'{k}{v}处' for k, v in cond_c.most_common())}\n"
        f"- 已三维建模：{n3d}处\n"
    )

    # 扩容后全部文物约 4,800 条，继续把完整清单塞进每次请求会超过
    # 常见上下文预算。大数据口径保留确定性统计，具体记录由 top-k 检索补充。
    if len(relics) > 2000:
        return (
            stats
            + "\n## 检索说明\n"
            + "当前数据量较大，完整清单未注入模型；系统会按本次问题追加最相关记录。"
        )

    header = "编号|名称|年代|类别|级别|现状|乡镇|三维|附属文物"
    sections = []
    for cnty in sorted(cnty_groups.keys()):
        group = cnty_groups[cnty]
        lvl_breakdown = Counter(_short_level(r.get("heritage_level", "")) for r in group)
        lvl_str = "、".join(f"{k}{v}" for k, v in lvl_breakdown.most_common())
        lines = [f"\n### {cnty}（共{len(group)}处：{lvl_str}）", header]
        for r in sorted(group, key=lambda x: (x.get("_rank_code") or "5", x.get("category_main", ""))):
            lines.append("|".join([
                str(r.get("archive_code", "")),
                str(r.get("name", "")),
                str(r.get("era", "")),
                str(r.get("category_main", "")),
                _short_level(str(r.get("heritage_level", ""))),
                str(r.get("condition_level", "")),
                str(r.get("township", "")),
                "是" if r.get("has_3d") else "否",
                str(r.get("attachments", "") or "无"),
            ]))
        sections.append("\n".join(lines))

    return stats + "\n## 完整文物清单（按县区分组）\n" + "\n".join(sections)


def _find_relevant_intros(
    query: str,
    top_k: int = 8,
    scope: str = SCOPE_PROTECTED,
) -> str:
    relics = store.scoped_relics(scope)
    if not relics:
        return ""

    ql = query.lower()
    scored = []
    for i, r in enumerate(relics):
        sc = 0
        name = r.get("name", "") or ""
        if name and name in query:
            sc += 20
        elif name:
            for j in range(len(name) - 1):
                if name[j:j + 2] in query:
                    sc += 3

        era = f"{r.get('era', '')} {r.get('era_stats', '')}"
        for kw in ["民国", "清", "明", "宋", "元", "唐", "汉", "近现代", "魏晋", "先秦",
                   "新石器", "商周", "隋唐", "战国", "秦", "南北朝", "两晋", "龙山", "北魏"]:
            if kw in ql and kw in era:
                sc += 8

        # 附属文物一并参与类别关键词匹配("牌坊类文物,包括附属文物"这类问题)
        cat = f"{r.get('category_main', '')} {r.get('category_sub', '')} {r.get('attachments', '')}"
        for kw in ["民居", "寺", "祠", "桥", "墓", "碑", "塔", "城", "古建", "遗址",
                   "石窟", "井", "庙", "石刻", "画像", "阁", "庵", "坊"]:
            if kw in ql and kw in cat:
                sc += 8

        cnty = r.get("county", "") or ""
        if cnty and cnty in query:
            sc += 8
        twn = re.sub(r"^\d+", "", r.get("township", "") or "")
        if twn and twn in query:
            sc += 6

        cond = r.get("condition_level", "") or ""
        for c in ["差", "较差", "一般", "较好", "好"]:
            if c in ql and c == cond:
                sc += 6
        if any(w in ql for w in ["修缮", "保护", "修复", "危", "巡查"]) and cond in ("差", "较差"):
            sc += 5

        level = r.get("heritage_level", "") or ""
        for lv in ["国家级", "全国重点", "省级", "市级", "县级"]:
            if lv in ql and lv in level:
                sc += 6

        if any(w in ql for w in ["三维", "模型", "3d"]) and r.get("has_3d"):
            sc += 5

        if sc > 0:
            scored.append((i, sc))

    if not scored:
        return ""

    scored.sort(key=lambda x: -x[1])
    parts = []
    for idx, _ in scored[:top_k]:
        r = relics[idx]
        intro = r.get("intro") or ""
        if not intro:
            continue
        parts.append(
            f"【{r.get('name', '')}（{r.get('archive_code', '')}）】\n"
            f"年代：{r.get('era', '')} | 类别：{r.get('category_main', '')} | "
            f"县区：{r.get('county', '')} | 乡镇：{re.sub(r'^[0-9]+', '', r.get('township', '') or '')} | "
            f"级别：{r.get('heritage_level', '')} | 现状：{r.get('condition_level', '')}\n"
            f"地址：{r.get('address', '')}\n"
            f"附属文物：{r.get('attachments', '') or '无'}\n"
            f"保护范围：{r.get('protection_scope', '') or '—'}\n"
            f"建控地带：{r.get('control_zone', '') or '—'}\n"
            f"简介：{intro}"
        )
    return "\n\n---\n\n".join(parts) if parts else ""


# ── 附属文物检索 ─────────────────────────────────────────────
# 问题按类别问("牌坊类文物,包括附属文物")时,主类别之外还要查附属栏;
# all 口径不注入完整清单,必须靠这里把附属命中的记录喂给模型。
_ATT_KEYWORDS = [
    "牌坊", "石刻", "画像", "碑", "桥", "塔", "井", "庙", "殿", "楼",
    "亭", "阁", "坊", "古树", "钟", "鼓", "俑", "石狮", "供案",
]
_ATT_MAX_HITS = 60


def _find_attachment_context(query: str, scope: str) -> str:
    """检索附属文物栏,返回命中清单(空串表示与本问题无关)。"""
    kws = [kw for kw in _ATT_KEYWORDS if kw in query]
    # 长词优先:命中"牌坊"就不再单算"坊"
    kept: list[str] = []
    for kw in sorted(kws, key=len, reverse=True):
        if not any(kw in k for k in kept):
            kept.append(kw)
    ask_attachment = "附属" in query
    if not kept and not ask_attachment:
        return ""

    hits: list[dict] = []
    for r in store.scoped_relics(scope):
        att = str(r.get("attachments") or "")
        if not att:
            continue
        if kept and not any(kw in att for kw in kept):
            continue
        hits.append(r)
    if not hits:
        return ""

    shown = hits[:_ATT_MAX_HITS]
    title = "、".join(kept) if kept else "全部"
    lines = [
        f"### 附属文物栏命中「{title}」的文物(共 {len(hits)} 处"
        + (f",下表列出前 {len(shown)} 处)" if len(hits) > len(shown) else ")"),
        "编号|名称|类别|级别|县区|附属文物",
    ]
    for r in shown:
        lines.append("|".join([
            str(r.get("archive_code", "")),
            str(r.get("name", "")),
            str(r.get("category_main", "")),
            _short_level(str(r.get("heritage_level", ""))),
            str(r.get("county", "")),
            str(r.get("attachments", "")),
        ]))
    return (
        "## 附属文物检索\n"
        "以下文物的「附属文物」栏含相关内容。它们的主体类别可能不同,"
        "回答时请注明是附属文物命中。\n\n" + "\n".join(lines)
    )


# ── 水系空间检索(泗河上的桥类文物 这类沿线问题) ──────────────
_WATER_DIR = Path(__file__).resolve().parents[1] / "static" / "vector_basemap"
# 沿线判定半径:水系轮廓是制图级简化线,留出容差
_WATER_NEAR_M = 1500.0
_WATER_MAX_HITS = 40
_water_index: list[dict] | None = None


def _load_water_index() -> list[dict]:
    """离线矢量底图的河流(线)/湖泊水库(面),惰性加载并缓存。"""
    global _water_index
    if _water_index is not None:
        return _water_index
    out: list[dict] = []
    for fname, kind in (("rivers.json", "河"), ("lakes.json", "湖")):
        try:
            data = json.loads((_WATER_DIR / fname).read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        for item in data.get("items") or []:
            name = str(item.get("name") or "").strip()
            pts = item.get("pts") or []
            if len(name) < 2 or len(pts) < 2:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            out.append({
                "name": name,
                "kind": kind,
                "pts": pts,
                "bbox": (min(xs), min(ys), max(xs), max(ys)),
            })
    _water_index = out
    return out


def _water_names_in_query(query: str, names: set[str]) -> list[str]:
    """问题中出现的水系名。排除"泗河街道"这类行政区/道路语境的误命中。"""
    admin_suffixes = ("街道", "镇", "乡", "村", "社区", "路", "小区")
    matched = []
    for name in names:
        idx = query.find(name)
        hit = False
        while idx != -1:
            tail = query[idx + len(name):]
            if not tail.startswith(admin_suffixes):
                hit = True
                break
            idx = query.find(name, idx + 1)
        if hit:
            matched.append(name)
    # 命中"小泗河"时不再单独算其中的"泗河"
    matched.sort(key=len, reverse=True)
    kept: list[str] = []
    for n in matched:
        if not any(n in k for k in kept):
            kept.append(n)
    return kept


def _point_in_ring(px: float, py: float, pts: list) -> bool:
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i][0], pts[i][1]
        xj, yj = pts[j][0], pts[j][1]
        if (yi > py) != (yj > py):
            x_cross = (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi
            if px < x_cross:
                inside = not inside
        j = i
    return inside


def _dist_to_path_m(lng: float, lat: float, pts: list, kx: float, ky: float) -> float:
    """点到折线的最小距离(等距圆柱近似,米)。"""
    px, py = lng * kx, lat * ky
    best = float("inf")
    for i in range(len(pts) - 1):
        x1, y1 = pts[i][0] * kx, pts[i][1] * ky
        x2, y2 = pts[i + 1][0] * kx, pts[i + 1][1] * ky
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg2))
        d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
        if d < best:
            best = d
    return best


def _find_water_context(query: str, scope: str) -> str:
    """问题涉及河流/湖泊时,检索沿线(1.5km 内)文物,拼成上下文表格。"""
    waters = _load_water_index()
    if not waters:
        return ""
    names = _water_names_in_query(query, {w["name"] for w in waters})
    if not names:
        return ""

    relics = store.scoped_relics(scope)
    pad_deg = _WATER_NEAR_M / 100_000  # ~1.5km 的经纬度粗略缓冲
    sections = []
    for name in names[:3]:
        geoms = [w for w in waters if w["name"] == name]
        kind = geoms[0]["kind"]
        boxes = [
            (b[0] - pad_deg, b[1] - pad_deg, b[2] + pad_deg, b[3] + pad_deg)
            for b in (g["bbox"] for g in geoms)
        ]
        hits: list[tuple[float, dict]] = []
        for r in relics:
            lng, lat = r.get("center_lng"), r.get("center_lat")
            if lng is None or lat is None:
                continue
            lng, lat = float(lng), float(lat)
            best = float("inf")
            for g, b in zip(geoms, boxes):
                if not (b[0] <= lng <= b[2] and b[1] <= lat <= b[3]):
                    continue
                mid_lat = (b[1] + b[3]) / 2
                kx = 111_320.0 * math.cos(math.radians(mid_lat))
                ky = 110_540.0
                if kind == "湖" and _point_in_ring(lng, lat, g["pts"]):
                    best = 0.0
                    break
                d = _dist_to_path_m(lng, lat, g["pts"], kx, ky)
                if d < best:
                    best = d
            if best <= _WATER_NEAR_M:
                hits.append((best, r))
        hits.sort(key=lambda x: x[0])
        label = "沿线" if kind == "河" else "周边"
        if not hits:
            sections.append(f"### {name}\n{label} {int(_WATER_NEAR_M)} 米内未检索到文物。")
            continue
        # 桥/闸/坝等涉水设施是这类问题的核心,即使距离排序靠后也保证入选
        selected = hits[:_WATER_MAX_HITS]
        chosen = {id(r) for _, r in selected}
        water_related = re.compile(r"[桥闸坝涵渡堤]")
        for d, r in hits[_WATER_MAX_HITS:]:
            if water_related.search(str(r.get("name", ""))) and id(r) not in chosen:
                selected.append((d, r))
        selected.sort(key=lambda x: x[0])
        lines = [
            f"### {name} {label} {int(_WATER_NEAR_M)} 米内的文物(按距离升序,共 {len(hits)} 处"
            + (f",下表列出最近 {_WATER_MAX_HITS} 处及全部桥闸坝类设施)" if len(hits) > len(selected) or len(selected) > _WATER_MAX_HITS else ")"),
            "编号|名称|类别|级别|现状|距离|县区|乡镇",
        ]
        for d, r in selected:
            dist_text = "水域内" if d == 0 else f"约{max(10, int(round(d / 10) * 10))}米"
            lines.append("|".join([
                str(r.get("archive_code", "")),
                str(r.get("name", "")),
                str(r.get("category_main", "")),
                _short_level(str(r.get("heritage_level", ""))),
                str(r.get("condition_level", "")),
                dist_text,
                str(r.get("county", "")),
                re.sub(r"^\d+", "", str(r.get("township", "") or "")),
            ]))
        sections.append("\n".join(lines))

    return (
        "## 水系空间检索\n"
        "以下由系统按文物中心点到水系几何的距离计算得出。"
        "水系轮廓为制图级简化线,距离是近似值;请结合类别/名称判断文物与水系的实际关系"
        "(如「桥涵」「闸」「渡口」多为跨河/临河设施)。\n\n"
        + "\n\n".join(sections)
    )


def init_chat() -> None:
    """在 lifespan 中调用:读配置、预烘上下文。客户端由 ai_service 统一管理。"""
    global _scope_contexts
    global _project_name, _project_full_name
    global _default_model, _available_models
    global _top_k_relics, _history_turns, _temperature

    cfg = load_config()
    proj = cfg.get("project", {})
    _project_name = proj.get("name") or "本市"
    _project_full_name = proj.get("full_name") or f"{_project_name}文物保护利用平台"

    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    _default_model = sf.get("default_model", "")
    _available_models = sf.get("available_models", []) or []
    _top_k_relics = int(sf.get("top_k_relics", 8))
    _history_turns = int(sf.get("history_turns", 10))
    _temperature = float(sf.get("temperature", 0.2))

    _scope_contexts = {
        "protected": _build_full_context("protected"),
        "all": _build_full_context("all"),
    }
    for scope, context in _scope_contexts.items():
        if context:
            ctx_len = len(context)
            print(f"[AI] {scope} 上下文 {ctx_len} 字 ≈ {ctx_len // 2} tokens "
                  f"({len(store.scoped_relics(scope))} 条文物)")


class ChatRequest(BaseModel):
    message: str
    history: list = []
    scope: str = SCOPE_PROTECTED


@router.post("/chat")
async def chat(req: ChatRequest):
    try:
        scope = normalize_relic_scope(req.scope)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    client = ai_service.get_client()
    if not client:
        return StreamingResponse(
            iter(["data: " + json.dumps({"error": "AI 服务未启用或未配置 API Key"}, ensure_ascii=False) + "\n\n"]),
            media_type="text/event-stream",
        )

    detail = _find_relevant_intros(
        req.message,
        top_k=_top_k_relics,
        scope=scope,
    )
    water_detail = _find_water_context(req.message, scope)
    attachment_detail = _find_attachment_context(req.message, scope)

    system_content = _build_system_prompt(scope) + "\n\n" + _scope_contexts.get(scope, "")
    if water_detail:
        system_content += "\n\n" + water_detail
    if attachment_detail:
        system_content += "\n\n" + attachment_detail
    if detail:
        system_content += "\n\n## 与本次提问最相关的文物详情\n" + detail

    # 模型统一由系统管理页配置(config.siliconflow.default_model),
    # ai_service 在配置保存时热更新,这里实时取值
    use_model = ai_service.default_model() or _default_model

    messages = [{"role": "system", "content": system_content}]
    for h in (req.history or [])[-_history_turns:]:
        messages.append({
            "role": h.get("role", "user"),
            "content": h.get("content", ""),
        })
    messages.append({"role": "user", "content": req.message})

    def generate():
        try:
            stream = client.chat.completions.create(
                model=use_model,
                messages=messages,
                stream=True,
                temperature=_temperature,
                max_tokens=4096,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    yield "data: " + json.dumps({"content": delta.content}, ensure_ascii=False) + "\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": f"请求失败: {e}"}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/chat/models")
async def chat_models():
    return {"models": _available_models, "default": _default_model}


@router.get("/chat/test")
async def chat_test():
    return {
        "ready": ai_service.ready(),
        "relics_count": len(store.relics),
        "context_chars": {k: len(v) for k, v in _scope_contexts.items()},
        "default_model": _default_model,
        "project": _project_full_name,
    }
