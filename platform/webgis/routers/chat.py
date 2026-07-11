"""AI 知识库问答 (OpenAI 兼容协议,流式输出)。

启动时分别预烘焙“文保单位 / 全部文物”统计上下文；每次请求再按
当前 scope 做轻量关键词评分,追加 Top-K 相关文物详情。
"""
from __future__ import annotations

import json
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

    header = "编号|名称|年代|类别|级别|现状|乡镇|三维"
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

        cat = f"{r.get('category_main', '')} {r.get('category_sub', '')}"
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
            f"保护范围：{r.get('protection_scope', '') or '—'}\n"
            f"建控地带：{r.get('control_zone', '') or '—'}\n"
            f"简介：{intro}"
        )
    return "\n\n---\n\n".join(parts) if parts else ""


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

    system_content = _build_system_prompt(scope) + "\n\n" + _scope_contexts.get(scope, "")
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
        "context_chars": len(_full_context),
        "default_model": _default_model,
        "project": _project_full_name,
    }
