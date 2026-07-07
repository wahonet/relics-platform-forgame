"""大模型统一接入层(SiliconFlow / OpenAI 兼容)。

- 文本模型: AI 问答、巡查意图解析、报告润色
- 视觉模型: 巡查照片与档案基准照对比,评估保存状况

未配置 API Key 时全部函数安全降级(返回 None / ""),
调用方须自备规则兜底,保证离线可演示。
"""
from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Optional

log = logging.getLogger("uvicorn.error")

_client = None
_default_model: str = ""
_vision_model: str = ""
_temperature: float = 0.2


def init(cfg: dict) -> None:
    global _client, _default_model, _vision_model, _temperature
    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    api_key = sf.get("key", "") or ""
    base_url = sf.get("base_url", "https://api.siliconflow.cn/v1")
    _default_model = sf.get("default_model", "")
    _vision_model = sf.get("vision_model", "") or "Qwen/Qwen2.5-VL-72B-Instruct"
    _temperature = float(sf.get("temperature", 0.2))

    invalid = (not api_key) or (api_key.startswith("${") and api_key.endswith("}"))
    if invalid:
        log.info("[AI] 未配置 SiliconFlow API Key,AI 能力降级为规则模式")
        _client = None
        return
    try:
        import httpx
        from openai import OpenAI
        # 国内 API 强制直连:trust_env=False 忽略系统/环境代理,
        # 避免代理软件开关导致连接指向已失效的本地代理
        _client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            http_client=httpx.Client(trust_env=False, timeout=120),
        )
        log.info("[AI] 文本模型 %s / 视觉模型 %s 就绪(直连)", _default_model, _vision_model)
    except ImportError:
        log.warning("[AI] 未安装 openai 库,AI 能力降级为规则模式")
        _client = None


def get_client():
    return _client


def ready() -> bool:
    return _client is not None


def default_model() -> str:
    return _default_model


def temperature() -> float:
    return _temperature


def _extract_json(text: str) -> Optional[dict]:
    """从模型输出中鲁棒地抠出第一个 JSON 对象。"""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def complete_json(prompt: str, *, system: str = "", model: str = "",
                  max_tokens: int = 800) -> Optional[dict]:
    """一次性(非流式)请求并解析 JSON。失败返回 None。"""
    if not _client:
        return None
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    try:
        resp = _client.chat.completions.create(
            model=model or _default_model,
            messages=messages,
            temperature=0.1,
            max_tokens=max_tokens,
        )
        text = resp.choices[0].message.content or ""
        return _extract_json(text)
    except Exception as e:
        log.warning("[AI] complete_json 失败: %s", e)
        return None


def complete_text(prompt: str, *, system: str = "", model: str = "",
                  max_tokens: int = 2000) -> str:
    """一次性文本补全。失败返回空串。"""
    if not _client:
        return ""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    try:
        resp = _client.chat.completions.create(
            model=model or _default_model,
            messages=messages,
            temperature=0.3,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        log.warning("[AI] complete_text 失败: %s", e)
        return ""


# ── 巡查意图解析 ─────────────────────────────────────────────
_INTENT_SYSTEM = """你是文物巡查路线规划助手。把用户的自然语言巡查需求解析成 JSON,只输出 JSON,不要多余文字。

JSON 结构:
{
  "type": "near" | "monthly" | "county" | "condition" | "list",
  "anchor": "锚点文物名称(type=near 时)",
  "count": 数字(仅当用户明确提到数量时才输出,否则省略此字段),
  "county": "县区名(可选,用户提到的行政区,如 嘉祥县/任城区)",
  "township": "乡镇名(可选)",
  "condition": "保存状况筛选,取值 差/较差/一般/较好/好(可选)",
  "level": "保护级别筛选,取值 国保/省保/市保/县保/未定级(可选。全国重点文物保护单位=国保,省级=省保,市级=市保,县级=县保)",
  "origin": "出发地名称(可选。用户说「从XX出发/由XX开始」时,XX 就是出发地,可以是任意地名/单位,不一定是文物)",
  "names": ["明确点名的文物名称"(type=list 时)]
}

重要:用户提到的县区、保护级别、保存状况、出发地都必须解析出来,不能遗漏。
出发地(origin)只是路线起点,不参与文物筛选。

示例:
"巡查武氏墓群石刻附近的大约5处文物" → {"type":"near","anchor":"武氏墓群石刻","count":5}
"规划本月的巡查路线" → {"type":"monthly"}
"帮我安排嘉祥县保存较差的文物巡查" → {"type":"condition","county":"嘉祥县","condition":"较差"}
"巡查嘉祥县的全国重点文物保护单位" → {"type":"condition","county":"嘉祥县","level":"国保"}
"巡查任城区的3处省级文物保护单位" → {"type":"condition","county":"任城区","level":"省保","count":3}
"从嘉祥县为民服务中心出发去武氏祠附近巡察5个点" → {"type":"near","anchor":"武氏祠","count":5,"origin":"嘉祥县为民服务中心"}
"从县文旅局出发巡查保存较差的文物" → {"type":"condition","condition":"较差","origin":"县文旅局"}
"巡查青山寺、曾庙和武氏墓群" → {"type":"list","names":["青山寺","曾庙","武氏墓群"]}
"""

# 级别关键词 → 统一别名(供规则解析和 LLM 结果兜底)
_LEVEL_PATTERNS: list[tuple[str, str]] = [
    ("全国重点文物保护单位", "国保"),
    ("全国重点", "国保"),
    ("国家级", "国保"),
    ("国保", "国保"),
    ("省级文物保护单位", "省保"),
    ("省级", "省保"),
    ("省保", "省保"),
    ("市级文物保护单位", "市保"),
    ("市级", "市保"),
    ("市保", "市保"),
    ("县级文物保护单位", "县保"),
    ("县级", "县保"),
    ("县保", "县保"),
    ("未定级", "未定级"),
    ("未核定", "未定级"),
]


def detect_level(text: str, county: str = "") -> str:
    """从文本中识别保护级别关键词,返回 国保/省保/市保/县保/未定级 或空串。
    先剥掉县区名,避免「嘉祥县保存较差」里的"县保"被误判为县保级别。"""
    t = text.replace(county, "") if county else text
    for pat, label in _LEVEL_PATTERNS:
        if pat in t:
            return label
    return ""


_VERB_PREFIX = re.compile(r"^(请|帮我|帮忙|麻烦)?(安排|规划|巡查|巡察|巡视|检查)?")


def detect_county(text: str) -> str:
    """从文本中识别县区名。先剥掉开头动词,避免把「巡查嘉祥县」整体当县名。"""
    t = _VERB_PREFIX.sub("", (text or "").strip())
    m = re.search(r"([\u4e00-\u9fa5]{1,4}?(?:县|区|市))", t)
    if m and m.group(1) not in ("济宁市",):
        return m.group(1)
    return ""


def parse_patrol_intent_llm(text: str) -> Optional[dict]:
    return complete_json(text, system=_INTENT_SYSTEM, max_tokens=300)


def parse_patrol_intent_rules(text: str) -> dict:
    """无 Key 时的规则兜底解析。"""
    t = (text or "").strip()
    # count 只在用户明确提到数量时设置,便于上游区分"默认值"和"用户要求"
    out: dict[str, Any] = {"type": "list", "names": []}

    # 出发地:「从XX出发/由XX开始」,XX 可为任意地名。先摘出来避免干扰后续解析
    m = re.search(r"[从由]\s*([\u4e00-\u9fa5A-Za-z0-9（）()]+?)\s*(?:出发|开始|起步|走)", t)
    if m:
        out["origin"] = m.group(1)
        t = t.replace(m.group(0), "")

    m = re.search(r"(大约|约|附近的?)?(\d+|[一二两三四五六七八九十]+)\s*[处个]", t)
    if m:
        num_map = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
                   "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
        raw = m.group(2)
        out["count"] = int(raw) if raw.isdigit() else num_map.get(raw, 5)

    if re.search(r"本月|这个月|月度|下月", t):
        out["type"] = "monthly"
        return out

    m = re.search(r"(?:巡[查察]|去|到)\s*([\u4e00-\u9fa5A-Za-z0-9（）()]+?)\s*(?:附近|周边|周围)", t)
    if m:
        out["type"] = "near"
        out["anchor"] = m.group(1)
        return out

    for cond in ("较差", "较好", "一般", "差", "好"):
        if f"保存{cond}" in t or f"状况{cond}" in t or f"现状{cond}" in t:
            out["type"] = "condition"
            out["condition"] = cond
            break

    county = detect_county(t)
    if county:
        out["county"] = county
        if out["type"] == "list":
            out["type"] = "county"

    # 级别识别要先剥掉县区名,防止「嘉祥县保存」误命中"县保"
    level = detect_level(t, county)
    if level:
        out["level"] = level
        if out["type"] in ("list", "county"):
            out["type"] = "condition"

    if out["type"] == "list":
        # 顿号/逗号分隔的点名清单
        m = re.search(r"巡查([\u4e00-\u9fa5、，,()（）0-9A-Za-z]+)", t)
        if m:
            names = [n.strip() for n in re.split(r"[、，,和及]", m.group(1)) if len(n.strip()) >= 2]
            out["names"] = names[:20]
        if not out["names"]:
            out["type"] = "condition"  # 最后兜底:按状况差的排
            out["condition"] = ""
    return out


def parse_patrol_intent(text: str) -> dict:
    intent = parse_patrol_intent_llm(text) if ready() else None
    if not intent or not isinstance(intent, dict) or "type" not in intent:
        intent = parse_patrol_intent_rules(text)
        intent["_parser"] = "rules"
    else:
        intent["_parser"] = "llm"
        # LLM 偶尔漏掉县区/级别筛选,用规则识别兜底补齐,
        # 避免"巡查嘉祥县的国保单位"被规划到别的县区/级别。
        if not intent.get("county"):
            county = detect_county(text)
            if county:
                intent["county"] = county
        if not intent.get("level"):
            level = detect_level(text, str(intent.get("county") or ""))
            if level:
                intent["level"] = level
        if not intent.get("origin"):
            m = re.search(r"[从由]\s*([\u4e00-\u9fa5A-Za-z0-9（）()]+?)\s*(?:出发|开始|起步)", text)
            if m:
                intent["origin"] = m.group(1)
    return intent


# ── 巡查照片 AI 评估 ─────────────────────────────────────────
_VISION_SYSTEM = """你是文物保护工程师。对比同一处不可移动文物的「档案基准照片」与「本次巡查照片」,评估保存状况变化。只输出 JSON:
{
  "same_site": true/false,        // 两张照片是否为同一处文物/场景
  "condition": "好|较好|一般|较差|差",  // 依据巡查照片评估的当前保存状况
  "changes": "对比基准照片观察到的变化(50字内)",
  "risks": "发现的病害或风险点(50字内,无则写'未见明显病害')",
  "suggestion": "处置建议(30字内)"
}"""


def _img_part(image_bytes: bytes, mime: str = "image/jpeg") -> dict:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def assess_patrol_photo(
    new_photo: bytes,
    baseline_photo: Optional[bytes],
    relic_meta: dict,
) -> Optional[dict]:
    """视觉模型评估。无 Key / 失败返回 None(调用方降级)。"""
    if not _client:
        return None
    content: list[dict] = []
    prompt = (
        f"文物: {relic_meta.get('name', '')} ({relic_meta.get('archive_code', '')})\n"
        f"类别: {relic_meta.get('category_main', '')} 年代: {relic_meta.get('era', '')}\n"
        f"档案记录保存状况: {relic_meta.get('condition_level', '')}\n"
    )
    if baseline_photo:
        prompt += "第一张为档案基准照片,第二张为本次巡查照片。"
        content.append({"type": "text", "text": prompt})
        content.append(_img_part(baseline_photo))
        content.append(_img_part(new_photo))
    else:
        prompt += "仅有本次巡查照片(无基准照),same_site 输出 true。"
        content.append({"type": "text", "text": prompt})
        content.append(_img_part(new_photo))

    try:
        resp = _client.chat.completions.create(
            model=_vision_model,
            messages=[
                {"role": "system", "content": _VISION_SYSTEM},
                {"role": "user", "content": content},
            ],
            temperature=0.1,
            max_tokens=500,
        )
        return _extract_json(resp.choices[0].message.content or "")
    except Exception as e:
        log.warning("[AI] 视觉评估失败: %s", e)
        return None
