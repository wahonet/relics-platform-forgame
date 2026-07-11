"""文物语音讲解 TTS API。

POST /api/tts/narrate  { code, lang: "zh" | "en" }
    → 按文物档案组装导览词(英文版先用文本模型翻译成英文解说词,结果缓存)
    → 调 SiliconFlow CosyVoice2(OpenAI 兼容 /audio/speech)合成情感语音
    → 返回 audio/mpeg 二进制

未配置 SiliconFlow Key 或合成失败时返回 503,前端回退浏览器本地 TTS。
"""
from __future__ import annotations

import logging
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from _common import load_config  # noqa: E402

from data_loader import store  # noqa: E402
from services import ai_service  # noqa: E402

router = APIRouter(tags=["语音讲解"])
log = logging.getLogger("uvicorn.error")

DEFAULT_TTS_MODEL = "FunAudioLLM/CosyVoice2-0.5B"
# CosyVoice2 预置音色白名单(男:alex/benjamin/charles/david,女:anna/bella/claire/diana)
ALLOWED_VOICES = {"alex", "anna", "bella", "benjamin", "charles", "claire", "david", "diana"}
DEFAULT_VOICE = {"zh": "anna", "en": "charles"}
# 导览词长度上限(字符),控制合成时长与接口负载
MAX_NARRATION_CHARS = 600

# 关键要求:文物名称/地名等专有名词保留中文原文(CosyVoice2 中英混读,
# 名称保持中文发音),不得意译或转写为英文。
_EN_SYSTEM = (
    "You are a professional bilingual heritage-site narrator. Rewrite the given "
    "Chinese cultural-relic narration into fluent, natural spoken English suitable "
    "for an audio guide. IMPORTANT: keep all proper nouns (the relic's name, place "
    "names, dynasty names may be translated, but relic names and place names must "
    "stay in their original Chinese characters, NOT translated and NOT romanized), "
    "embedded directly in the English sentences, e.g. \"周公庙, located in 曲阜市, "
    "is a national key cultural relic site.\" Output only the narration text, with "
    "no preamble, titles or notes."
)

# (code, lang) → 英文导览词 / 音频字节 的 LRU 缓存
_text_cache: OrderedDict[tuple[str, str], str] = OrderedDict()
_audio_cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()
_TEXT_CACHE_MAX = 200
_AUDIO_CACHE_MAX = 60


def _cache_put(cache: OrderedDict, key, value, limit: int) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > limit:
        cache.popitem(last=False)


def _truncate(text: str, limit: int = MAX_NARRATION_CHARS) -> str:
    """超长时截到句号/句点,保持朗读收尾自然。"""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in ("。", ". ", "！", "？", "; "):
        pos = cut.rfind(sep)
        if pos > limit * 0.6:
            return cut[: pos + len(sep)].rstrip()
    return cut


def _narration_zh(relic: dict, intro: str, scope: str) -> str:
    """scope: full=信息+简介 / brief=仅基础信息 / intro=名称+简介。"""
    parts: list[str] = []
    location = f"{relic.get('county') or ''}{relic.get('township') or ''}"
    parts.append(f"{relic.get('name') or ''}{f'，位于{location}' if location else ''}。")
    if scope in ("full", "brief"):
        facts: list[str] = []
        level = relic.get("heritage_level") or ""
        if level and len(level) < 20:
            facts.append(f"是{level}")
        if relic.get("era"):
            facts.append(f"年代为{relic['era']}")
        if relic.get("category_main"):
            facts.append(f"属{relic['category_main']}类")
        if facts:
            parts.append("，".join(facts) + "。")
        if relic.get("condition_level"):
            parts.append(f"目前保存状况{relic['condition_level']}。")
    if scope in ("full", "intro"):
        text = (intro or "").strip()
        parts.append(text if text else "暂无详细简介。")
    return _truncate("".join(parts))


def _narration_en(code: str, scope: str, zh_text: str) -> str:
    key = (f"{code}|{scope}", "en")
    cached = _text_cache.get(key)
    if cached:
        return cached
    translated = ai_service.complete_text(
        zh_text, system=_EN_SYSTEM, max_tokens=1200,
    ).strip()
    if not translated:
        raise HTTPException(503, "英文讲解生成失败,请确认 AI 服务已配置")
    translated = _truncate(translated, 900)
    _cache_put(_text_cache, key, translated, _TEXT_CACHE_MAX)
    return translated


def _tts_model() -> str:
    try:
        sf = (load_config().get("api") or {}).get("siliconflow") or {}
        return str(sf.get("tts_model") or DEFAULT_TTS_MODEL)
    except Exception:
        return DEFAULT_TTS_MODEL


def _synthesize(text: str, voice: str, speed: float) -> bytes:
    client = ai_service.get_client()
    if client is None:
        raise HTTPException(503, "未配置 SiliconFlow API Key,无法使用 AI 语音")
    model = _tts_model()
    try:
        resp = client.audio.speech.create(
            model=model,
            voice=f"{model}:{voice}",
            input=text,
            response_format="mp3",
            speed=speed,
        )
        audio = resp.content
        if not audio:
            raise ValueError("TTS 返回空音频")
        return audio
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("[TTS] 语音合成失败: %s", e)
        raise HTTPException(503, f"语音合成失败: {e}") from e


def _sanitize(lang: str, voice: str | None, speed: float | None) -> tuple[str, float]:
    v = (voice or "").strip()
    if v not in ALLOWED_VOICES:
        v = DEFAULT_VOICE.get(lang, "anna")
    s = max(0.5, min(2.0, float(speed or 1.0)))
    return v, s


class NarrateBody(BaseModel):
    code: str
    lang: Literal["zh", "en"] = "zh"
    voice: str | None = None
    speed: float | None = None
    scope: Literal["full", "brief", "intro"] = "full"


@router.post("/tts/narrate")
async def narrate(body: NarrateBody):
    """合成指定文物的导览语音。结果按 (code, lang, voice, speed, scope) 缓存。"""
    voice, speed = _sanitize(body.lang, body.voice, body.speed)
    key = (f"{body.code}|{voice}|{speed}|{body.scope}", body.lang)
    cached = _audio_cache.get(key)
    if cached:
        return Response(content=cached, media_type="audio/mpeg")

    relic = store.get_relic_full(body.code) if store._use_db else store.get_relic(body.code)
    if not relic:
        raise HTTPException(404, f"文物 {body.code} 不存在")

    def _build() -> bytes:
        zh_text = _narration_zh(relic, str(relic.get("intro") or ""), body.scope)
        text = zh_text if body.lang == "zh" else _narration_en(body.code, body.scope, zh_text)
        return _synthesize(text, voice, speed)

    audio = await run_in_threadpool(_build)
    _cache_put(_audio_cache, key, audio, _AUDIO_CACHE_MAX)
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/tts/narrate")
async def narrate_get(
    code: str,
    lang: Literal["zh", "en"] = "zh",
    voice: str | None = None,
    speed: float | None = None,
    scope: Literal["full", "brief", "intro"] = "full",
):
    """GET 版音频直链(与 POST 同逻辑)。

    移动端浏览器要求 audio.play() 必须在用户手势内同步调用,
    无法先 POST 拿 blob 再播;名片页把本接口 URL 直接赋给 <audio src>。
    """
    return await narrate(NarrateBody(code=code, lang=lang, voice=voice, speed=speed, scope=scope))


_PREVIEW_TEXT = {
    "zh": "欢迎使用文物保护利用平台，这是当前音色与语速的试听效果。",
    "en": "Welcome to the heritage platform. 这是 preview voice, reading English with Chinese names like 周公庙.",
}


class PreviewBody(BaseModel):
    lang: Literal["zh", "en"] = "zh"
    voice: str | None = None
    speed: float | None = None


@router.post("/tts/preview")
async def preview(body: PreviewBody):
    """固定文本试听(设置页选音色/语速用)。"""
    voice, speed = _sanitize(body.lang, body.voice, body.speed)
    key = (f"__preview__|{voice}|{speed}", body.lang)
    cached = _audio_cache.get(key)
    if cached:
        return Response(content=cached, media_type="audio/mpeg")
    audio = await run_in_threadpool(_synthesize, _PREVIEW_TEXT[body.lang], voice, speed)
    _cache_put(_audio_cache, key, audio, _AUDIO_CACHE_MAX)
    return Response(content=audio, media_type="audio/mpeg")


@router.get("/tts/config")
async def tts_config():
    """语音讲解的运行配置(设置页展示:所用模型/可用音色)。"""
    return {
        "ready": ai_service.ready(),
        "tts_model": _tts_model(),
        "translate_model": ai_service.default_model() or "",
        "voices": sorted(ALLOWED_VOICES),
    }
