"""AI 知识库问答 (OpenAI 兼容协议,流式输出)。

启动时把全量文物与工作日志预烘焙成 system prompt;每次请求再按 query
做轻量关键词评分,追加 Top-K 相关文物/日志。配置统一来自 config.yaml。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from _common import load_config  # noqa: E402
from data_loader import store  # noqa: E402
from routers import worklog as _wl_mod  # noqa: E402

router = APIRouter()

# 运行时状态,init_chat() 中赋值。
_client = None  # type: ignore[var-annotated]
_full_context: str = ""
_worklog_context: str = ""
_project_name: str = "本县"
_project_full_name: str = "不可移动文物数字档案平台"
_default_model: str = ""
_available_models: list[dict] = []
_top_k_relics: int = 8
_top_k_worklog: int = 10
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


def _build_system_prompt() -> str:
    name = _project_full_name or _project_name
    return f"""你是「{name}」的 AI 助手。你掌握着本项目区域内全部不可移动文物的完整数据库，同时也掌握着完整的外业普查工作日志。

回答规则：
1. **严格基于数据回答** —— 下方提供了完整的文物清单与统计，以及外业工作日志，请据此回答，不要编造
2. 涉及数量统计时，请亲自数一遍数据再回答，确保数字准确
3. 引用文物时务必带上 **名称** 和 **档案编号**（如：某某村古遗址 990101-0001）
4. 回答结构清晰，善用表格、列表和分组
5. 如果数据中没有相关信息，如实说明「档案数据中未找到相关记录」
6. 如果用户问题与文物无关，礼貌引导回文物话题
7. 用中文回答
8. 当用户询问日志相关问题（如「某天去了哪里」「某个文物是哪天去的」「外业工作情况」等），请根据工作日志数据回答

数据字段说明：
- 编号：档案编号
- 级别缩写：国=全国重点文保单位，省=省级，市=市级，县=县级，未=尚未核定
- 现状：保存状况（好/较好/一般/较差/差）
- 三维：是否已完成三维数字化建模（是/否）

## 地图联动标记（非常重要！）
你的回答会渲染在一个带有地图的平台中。请在回答中积极使用以下标记，让用户可以点击查看地图：

### 标记格式
[[显示文本|动作参数]]

### 五种标记类型

**1. 筛选文物结果集（提到数量时）**
筛选参数用&连接：t:乡镇、l:级别、c:类别、s:现状、3d:1、kw:关键词
- "共有[[20处|l:省级]]省级文保单位"
- "保存较差的有[[8处|s:较差]]"

**2. 具体文物名称（提到某个文物时，用fly:编号定位）**
- "[[V01村古窑址|fly:990101-0001]]始建于战汉"

**3. 乡镇名称（提到乡镇时）**
- "位于[[示范街道|t:示范街道]]"

**4. 文物类别（提到类别时）**
- "属于[[古建筑|c:古建筑]]类"

**5. 工作日志（提到某天的日志/路线时，用log:日期打开日志查看器）**
日期格式必须是 YYYY-MM-DD
- "11月8日去了示范街道，[[查看当日日志|log:2024-11-08]]"

### 使用规则
- 每个实体在回答中**首次出现**时标记，后续不重复标记
- 文物名称务必使用fly:编号格式，编号必须准确
- 日志链接务必使用log:YYYY-MM-DD格式，日期必须准确
- 表格中的文物名称也要标记
- 不要在同一句话中过度标记，保持可读性"""


def _build_full_context() -> str:
    """拼出全量文物上下文(总体统计 + 按乡镇分组的清单表格),作为 system prompt 复用。"""
    relics = store.relics
    if not relics:
        return ""

    era_c = Counter(r.get("era_stats", "未知") for r in relics)
    cat_c = Counter(r.get("category_main", "未知") for r in relics)
    cond_c = Counter(r.get("condition_level", "未知") for r in relics)
    lvl_c = Counter(_short_level(r.get("heritage_level", "")) for r in relics)
    n3d = sum(1 for r in relics if r.get("has_3d"))

    twn_groups: dict[str, list] = {}
    for r in relics:
        twn = re.sub(r"^\d+", "", r.get("township", "未知"))
        twn_groups.setdefault(twn, []).append(r)
    twn_summary = ", ".join(
        f"{k}{len(v)}处"
        for k, v in sorted(twn_groups.items(), key=lambda x: -len(x[1]))
    )

    title = f"{_project_name}不可移动文物数据库统计"
    stats = (
        f"## {title}\n"
        f"- 文物总数：{len(relics)}处\n"
        f"- 按年代：{', '.join(f'{k}{v}处' for k, v in era_c.most_common())}\n"
        f"- 按类别：{', '.join(f'{k}{v}处' for k, v in cat_c.most_common())}\n"
        f"- 按乡镇：{twn_summary}\n"
        f"- 按现状：{', '.join(f'{k}{v}处' for k, v in cond_c.most_common())}\n"
        f"- 按级别：{', '.join(f'{k}{v}处' for k, v in lvl_c.most_common())}\n"
        f"- 已三维建模：{n3d}处\n"
    )

    header = "编号|名称|年代|大类|子类|级别|现状|三维|面积"
    sections = []
    for twn in sorted(twn_groups.keys()):
        group = twn_groups[twn]
        cat_breakdown = Counter(r.get("category_main", "") for r in group)
        cat_str = "、".join(f"{k}{v}" for k, v in cat_breakdown.most_common())
        lines = [f"\n### {twn}（共{len(group)}处：{cat_str}）", header]
        for r in sorted(group, key=lambda x: x.get("category_main", "")):
            lines.append("|".join([
                str(r.get("archive_code", "")),
                str(r.get("name", "")),
                str(r.get("era", "")),
                str(r.get("category_main", "")),
                str(r.get("category_sub", "")),
                _short_level(str(r.get("heritage_level", ""))),
                str(r.get("condition_level", "")),
                "是" if r.get("has_3d") else "否",
                str(r.get("area", "")),
            ]))
        sections.append("\n".join(lines))

    return stats + "\n## 完整文物清单（按乡镇分组）\n" + "\n".join(sections)


def _build_worklog_context() -> str:
    _wl_mod._load_ledger()
    cache = _wl_mod._ledger_cache
    if not cache:
        return ""

    lines = [
        "## 外业普查工作日志（按日期）",
        f"共 {len(cache)} 天外业工作记录\n",
        "日期|镇街|村庄|人员|复核数|复核文物|新发现数|新发现线索",
        "---|---|---|---|---|---|---|---",
    ]
    for r in sorted(cache, key=lambda x: x["date"]):
        lines.append("|".join([
            r["date"],
            r.get("township", ""),
            r.get("villages", ""),
            r.get("participants", ""),
            str(r.get("review_count", 0) or 0),
            r.get("review_names", ""),
            str(r.get("new_count", 0) or 0),
            r.get("new_names", ""),
        ]))
    return "\n".join(lines)


def _find_relevant_worklog(query: str) -> str:
    _wl_mod._load_ledger()
    cache = _wl_mod._ledger_cache
    if not cache:
        return ""

    date_patterns = [
        re.compile(r"(\d{4})\s*[-年/]\s*(\d{1,2})\s*[-月/]\s*(\d{1,2})\s*[日号]?"),
        re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?"),
    ]
    target_dates: set[str] = set()
    fallback_year = "2024"
    for pat in date_patterns:
        for m in pat.finditer(query):
            g = m.groups()
            if len(g) == 3:
                y, mo, d = g
                target_dates.add(f"{int(y):04d}-{int(mo):02d}-{int(d):02d}")
            elif len(g) == 2:
                mo, d = g
                target_dates.add(f"{fallback_year}-{int(mo):02d}-{int(d):02d}")

    scored = []
    for r in cache:
        sc = 0
        if r["date"] in target_dates:
            sc += 30
        for field in ("villages", "township", "review_names", "new_names"):
            val = r.get(field, "")
            if not val:
                continue
            for part in re.split(r"[、，,\s]+", val):
                if part and part in query:
                    sc += 15
                elif part and len(part) >= 2:
                    for j in range(len(part) - 1):
                        if part[j:j + 2] in query:
                            sc += 3
        if sc > 0:
            scored.append((r, sc))

    if not scored:
        return ""

    scored.sort(key=lambda x: -x[1])
    parts = []
    for rec, _ in scored[:_top_k_worklog]:
        detail = (
            f"【{rec['date']}】{rec.get('township', '')} — {rec.get('villages', '')}\n"
            f"  人员：{rec.get('participants', '')}\n"
            f"  复核({rec.get('review_count', 0)}处)：{rec.get('review_names', '')}\n"
            f"  新发现线索({rec.get('new_count', 0)}处)：{rec.get('new_names', '')}"
        )
        if rec.get("remark"):
            detail += f"\n  备注：{rec['remark']}"
        parts.append(detail)
    return "## 与本次提问最相关的工作日志\n\n" + "\n\n".join(parts)


def _find_relevant_intros(query: str, top_k: int = 8) -> str:
    relics = store.relics
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
                   "新石器", "商周", "隋唐", "战国", "秦", "南北朝", "两晋"]:
            if kw in ql and kw in era:
                sc += 8

        cat = f"{r.get('category_main', '')} {r.get('category_sub', '')}"
        for kw in ["民居", "寺", "祠", "桥", "墓", "碑", "塔", "城", "古建", "遗址",
                   "石窟", "井", "庙", "石刻", "画像", "阁", "庵", "坊"]:
            if kw in ql and kw in cat:
                sc += 8

        twn = re.sub(r"^\d+", "", r.get("township", "") or "")
        if twn and twn in query:
            sc += 6

        cond = r.get("condition_level", "") or ""
        for c in ["差", "较差", "一般", "较好", "好"]:
            if c in ql and c == cond:
                sc += 6
        if any(w in ql for w in ["修缮", "保护", "修复", "危"]) and cond in ("差", "较差"):
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
            f"年代：{r.get('era', '')} | 类别：{r.get('category_main', '')}/{r.get('category_sub', '')} | "
            f"乡镇：{re.sub(r'^[0-9]+', '', r.get('township', '') or '')} | "
            f"级别：{r.get('heritage_level', '')} | 现状：{r.get('condition_level', '')}\n"
            f"地址：{r.get('address', '')}\n"
            f"面积：{r.get('area', '')} | 所有权：{r.get('ownership_type', '')} | "
            f"风险因素：{r.get('risk_factors', '')} | 风险评分：{r.get('risk_score', '')}\n"
            f"简介：{intro}"
        )
    return "\n\n---\n\n".join(parts) if parts else ""


def init_chat() -> None:
    """在 lifespan 中调用:读配置、建客户端、预烘上下文。
    API Key 缺失或仍为 ${VAR} 占位时 _client=None,/chat 返回友好提示。"""
    global _client, _full_context, _worklog_context
    global _project_name, _project_full_name
    global _default_model, _available_models
    global _top_k_relics, _top_k_worklog, _history_turns, _temperature

    cfg = load_config()
    proj = cfg.get("project", {})
    _project_name = proj.get("name") or "本县"
    _project_full_name = proj.get("full_name") or f"{_project_name}不可移动文物数字档案平台"

    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    api_key = sf.get("key", "")
    base_url = sf.get("base_url", "https://api.siliconflow.cn/v1")
    _default_model = sf.get("default_model", "")
    _available_models = sf.get("available_models", []) or []
    _top_k_relics = int(sf.get("top_k_relics", 8))
    _top_k_worklog = int(sf.get("top_k_worklog", 10))
    _history_turns = int(sf.get("history_turns", 10))
    _temperature = float(sf.get("temperature", 0.2))

    invalid = (not api_key) or (api_key.startswith("${") and api_key.endswith("}"))
    if invalid:
        print("[AI] 未配置 SiliconFlow API Key，AI 问答功能已禁用")
        _client = None
    else:
        try:
            from openai import OpenAI
            _client = OpenAI(api_key=api_key, base_url=base_url)
        except ImportError:
            print("[AI] 未安装 openai，跳过初始化")
            _client = None

    _full_context = _build_full_context()
    if _full_context:
        ctx_len = len(_full_context)
        print(f"[AI] 全量上下文 {ctx_len} 字 ≈ {ctx_len // 2} tokens "
              f"({len(store.relics)} 条文物)")

    _worklog_context = _build_worklog_context()
    if _worklog_context:
        print(f"[AI] 工作日志上下文 {len(_worklog_context)} 字")


class ChatRequest(BaseModel):
    message: str
    history: list = []
    model: Optional[str] = ""


@router.post("/chat")
async def chat(req: ChatRequest):
    if not _client:
        return StreamingResponse(
            iter(["data: " + json.dumps({"error": "AI 服务未启用或未配置 API Key"}, ensure_ascii=False) + "\n\n"]),
            media_type="text/event-stream",
        )

    detail = _find_relevant_intros(req.message, top_k=_top_k_relics)
    wl_detail = _find_relevant_worklog(req.message)

    system_content = _build_system_prompt() + "\n\n" + _full_context
    if _worklog_context:
        system_content += "\n\n" + _worklog_context
    if detail:
        system_content += "\n\n## 与本次提问最相关的文物详情\n" + detail
    if wl_detail:
        system_content += "\n\n" + wl_detail

    use_model = req.model or _default_model

    messages = [{"role": "system", "content": system_content}]
    for h in (req.history or [])[-_history_turns:]:
        messages.append({
            "role": h.get("role", "user"),
            "content": h.get("content", ""),
        })
    messages.append({"role": "user", "content": req.message})

    def generate():
        try:
            stream = _client.chat.completions.create(
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
        "ready": _client is not None,
        "relics_count": len(store.relics),
        "context_chars": len(_full_context),
        "default_model": _default_model,
        "project": _project_full_name,
    }
