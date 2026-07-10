"""天气预报服务：Open-Meteo 兼容接口、统一字段与短时缓存。"""
from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx


DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast"
DEFAULT_PROVIDER = "Open-Meteo"
ALLOWED_API_HOSTS = frozenset({"api.open-meteo.com", "customer-api.open-meteo.com"})

_HOURLY_VARS = (
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation_probability",
    "precipitation",
    "weather_code",
    "wind_speed_10m",
    "wind_gusts_10m",
)
_DAILY_VARS = (
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "precipitation_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
)

_CACHE: dict[str, Any] = {
    "key": None,
    "expires": 0.0,
    "stale_expires": 0.0,
    "value": None,
}
_CACHE_LOCK = asyncio.Lock()


class WeatherServiceError(RuntimeError):
    """天气服务配置、请求或数据格式异常。"""


def _resolved(value: Any) -> str:
    text = str(value or "").strip()
    if text.startswith("${") and text.endswith("}"):
        return ""
    return text


def _weather_cfg(cfg: dict) -> dict:
    return ((cfg.get("api") or {}).get("weather") or {})


def configured(cfg: dict) -> bool:
    base_url = _resolved(_weather_cfg(cfg).get("base_url")) or DEFAULT_BASE_URL
    return valid_base_url(base_url)


def valid_base_url(base_url: str) -> bool:
    """天气适配器只允许 Open-Meteo 官方 HTTPS 端点，避免配置项成为 SSRF 跳板。"""
    parsed = urlparse(base_url)
    return parsed.scheme == "https" and (parsed.hostname or "").lower() in ALLOWED_API_HOSTS


def clear_cache() -> None:
    _CACHE.update(key=None, expires=0.0, stale_expires=0.0, value=None)


def weather_text(code: int | None) -> str:
    if code == 0:
        return "晴"
    if code == 1:
        return "大部晴朗"
    if code == 2:
        return "多云"
    if code == 3:
        return "阴"
    if code in (45, 48):
        return "雾"
    if code in (51, 53, 55):
        return "毛毛雨"
    if code in (56, 57):
        return "冻毛毛雨"
    if code in (61, 63, 65):
        return "小雨" if code == 61 else "中雨" if code == 63 else "大雨"
    if code in (66, 67):
        return "冻雨"
    if code in (71, 73, 75):
        return "小雪" if code == 71 else "中雪" if code == 73 else "大雪"
    if code == 77:
        return "米雪"
    if code in (80, 81, 82):
        return "阵雨"
    if code in (85, 86):
        return "阵雪"
    if code in (95, 96, 99):
        return "雷暴"
    return "未知天气"


def _series_value(series: dict, name: str, index: int) -> Any:
    values = series.get(name)
    if not isinstance(values, list) or index >= len(values):
        return None
    return values[index]


def _number(value: Any, digits: int = 1) -> float | int | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    rounded = round(number, digits)
    return int(rounded) if rounded.is_integer() else rounded


def _risk_tags(code: int | None, precipitation: Any, wind: Any, gusts: Any) -> tuple[str, list[str]]:
    rain = float(precipitation or 0)
    max_wind = float(wind or 0)
    max_gusts = float(gusts or 0)
    tags: list[str] = []
    level = "normal"

    if code in (95, 96, 99):
        tags.append("雷暴")
        level = "alert"
    if rain >= 50:
        tags.append("暴雨")
        level = "alert"
    elif rain >= 25:
        tags.append("大雨")
        if level == "normal":
            level = "watch"
    if max(max_wind, max_gusts) >= 17.2:
        tags.append("大风")
        level = "alert"
    elif max(max_wind, max_gusts) >= 10.8:
        tags.append("强风")
        if level == "normal":
            level = "watch"
    return level, tags


def normalize_forecast(raw: dict, *, cfg: dict, latitude: float, longitude: float) -> dict:
    """把 Open-Meteo 数组结构整理为前端直接消费的 7 日嵌套结构。"""
    daily = raw.get("daily")
    hourly = raw.get("hourly")
    if not isinstance(daily, dict):
        raise WeatherServiceError("天气接口逐日预报格式错误")
    if not isinstance(hourly, dict):
        raise WeatherServiceError("天气接口分时预报格式错误")
    dates = daily.get("time")
    hourly_times = hourly.get("time")
    if not isinstance(dates, list) or not dates:
        raise WeatherServiceError("天气接口未返回逐日预报")
    if not isinstance(hourly_times, list):
        raise WeatherServiceError("天气接口未返回分时预报")

    hours_by_date: dict[str, list[dict]] = {str(d): [] for d in dates[:7]}
    for index, timestamp in enumerate(hourly_times):
        stamp = str(timestamp)
        date = stamp[:10]
        if date not in hours_by_date:
            continue
        code_value = _number(_series_value(hourly, "weather_code", index), 0)
        code = int(code_value) if code_value is not None else None
        hours_by_date[date].append({
            "time": stamp,
            "weather_code": code,
            "text": weather_text(code),
            "temperature_c": _number(_series_value(hourly, "temperature_2m", index)),
            "humidity_percent": _number(_series_value(hourly, "relative_humidity_2m", index), 0),
            "precipitation_probability": _number(
                _series_value(hourly, "precipitation_probability", index), 0
            ),
            "precipitation_mm": _number(_series_value(hourly, "precipitation", index)),
            "wind_speed_ms": _number(_series_value(hourly, "wind_speed_10m", index)),
            "wind_gusts_ms": _number(_series_value(hourly, "wind_gusts_10m", index)),
        })

    days: list[dict] = []
    for index, date_value in enumerate(dates[:7]):
        date = str(date_value)
        code_value = _number(_series_value(daily, "weather_code", index), 0)
        code = int(code_value) if code_value is not None else None
        precipitation = _number(_series_value(daily, "precipitation_sum", index))
        max_wind = _number(_series_value(daily, "wind_speed_10m_max", index))
        max_gusts = _number(_series_value(daily, "wind_gusts_10m_max", index))
        risk_level, risk_tags = _risk_tags(code, precipitation, max_wind, max_gusts)
        days.append({
            "date": date,
            "weather_code": code,
            "text": weather_text(code),
            "temp_max_c": _number(_series_value(daily, "temperature_2m_max", index)),
            "temp_min_c": _number(_series_value(daily, "temperature_2m_min", index)),
            "precipitation_probability_max": _number(
                _series_value(daily, "precipitation_probability_max", index), 0
            ),
            "precipitation_mm": precipitation,
            "wind_speed_max_ms": max_wind,
            "wind_gusts_max_ms": max_gusts,
            "risk_level": risk_level,
            "risk_tags": risk_tags,
            "hours": hours_by_date.get(date, []),
        })

    weather_cfg = _weather_cfg(cfg)
    provider = _resolved(weather_cfg.get("provider")) or DEFAULT_PROVIDER
    project_name = str((cfg.get("project") or {}).get("name") or "项目所在地")
    return {
        "provider": provider,
        "source_url": "https://open-meteo.com/",
        "license": "CC BY 4.0",
        "location": {
            "name": project_name,
            "latitude": latitude,
            "longitude": longitude,
        },
        "timezone": str(raw.get("timezone") or "Asia/Shanghai"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "days": days,
    }


async def _request_json(url: str, params: dict, timeout_seconds: float) -> dict:
    async with httpx.AsyncClient(
        timeout=timeout_seconds,
        headers={"User-Agent": "Relics-Platform/2.0 weather-forecast"},
    ) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise WeatherServiceError("天气接口返回格式错误")
    if payload.get("error"):
        raise WeatherServiceError(str(payload.get("reason") or "天气接口请求失败"))
    return payload


async def get_forecast(cfg: dict) -> dict:
    weather_cfg = _weather_cfg(cfg)
    base_url = _resolved(weather_cfg.get("base_url")) or DEFAULT_BASE_URL
    if not valid_base_url(base_url):
        raise WeatherServiceError(
            "天气 API 仅支持 Open-Meteo 官方 HTTPS 地址"
        )

    center = ((cfg.get("geo") or {}).get("center") or {})
    try:
        latitude = float(center.get("lat"))
        longitude = float(center.get("lng"))
    except (TypeError, ValueError) as exc:
        raise WeatherServiceError("config.geo.center 缺少有效经纬度") from exc
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise WeatherServiceError("config.geo.center 经纬度超出范围")

    key = _resolved(weather_cfg.get("key"))
    try:
        timeout_seconds = max(3.0, min(float(weather_cfg.get("timeout_seconds", 12)), 60.0))
        cache_seconds = max(60.0, min(float(weather_cfg.get("cache_minutes", 15)) * 60, 3600.0))
        stale_seconds = max(300.0, min(float(weather_cfg.get("stale_hours", 24)) * 3600, 172800.0))
    except (TypeError, ValueError):
        timeout_seconds, cache_seconds, stale_seconds = 12.0, 900.0, 86400.0

    cache_key = f"{base_url}|{key}|{latitude:.6f}|{longitude:.6f}"
    now = time.monotonic()
    if _CACHE["key"] == cache_key and _CACHE["value"] and now < _CACHE["expires"]:
        return {**_CACHE["value"], "cached": True, "stale": False}

    async with _CACHE_LOCK:
        now = time.monotonic()
        if _CACHE["key"] == cache_key and _CACHE["value"] and now < _CACHE["expires"]:
            return {**_CACHE["value"], "cached": True, "stale": False}

        params: dict[str, Any] = {
            "latitude": latitude,
            "longitude": longitude,
            "timezone": "Asia/Shanghai",
            "forecast_days": 7,
            "wind_speed_unit": "ms",
            "hourly": ",".join(_HOURLY_VARS),
            "daily": ",".join(_DAILY_VARS),
        }
        if key:
            params["apikey"] = key

        try:
            raw = await _request_json(base_url, params, timeout_seconds)
            value = normalize_forecast(raw, cfg=cfg, latitude=latitude, longitude=longitude)
            stored_at = time.monotonic()
            _CACHE.update(
                key=cache_key,
                expires=stored_at + cache_seconds,
                stale_expires=stored_at + stale_seconds,
                value=value,
            )
            return {**value, "cached": False, "stale": False}
        except (httpx.HTTPError, ValueError, WeatherServiceError) as exc:
            if (
                _CACHE["key"] == cache_key
                and _CACHE["value"]
                and time.monotonic() < _CACHE["stale_expires"]
            ):
                return {
                    **_CACHE["value"],
                    "cached": True,
                    "stale": True,
                    "warning": "天气服务暂时不可用，当前显示最近一次缓存",
                }
            if isinstance(exc, WeatherServiceError):
                raise
            raise WeatherServiceError(
                "天气服务暂时不可用，请检查系统管理中的 API 地址与网络连接"
            ) from exc
