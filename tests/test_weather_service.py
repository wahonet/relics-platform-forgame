from __future__ import annotations

import asyncio

import httpx
import pytest

from services import weather_service


def _cfg(**weather_overrides):
    weather = {
        "provider": "Open-Meteo",
        "base_url": weather_service.DEFAULT_BASE_URL,
        "key": "${OPEN_METEO_API_KEY}",
        "cache_minutes": 15,
        "stale_hours": 24,
        **weather_overrides,
    }
    return {
        "project": {"name": "测试市"},
        "geo": {"center": {"lng": 116.587, "lat": 35.415}},
        "api": {"weather": weather},
    }


def _payload():
    return {
        "timezone": "Asia/Shanghai",
        "daily": {
            "time": ["2026-07-10", "2026-07-11"],
            "weather_code": [0, 95],
            "temperature_2m_max": [31.2, 29.0],
            "temperature_2m_min": [22.0, 21.5],
            "precipitation_probability_max": [0, 90],
            "precipitation_sum": [0, 52.3],
            "wind_speed_10m_max": [3.0, 18.0],
            "wind_gusts_10m_max": [5.0, 23.0],
        },
        "hourly": {
            "time": [
                "2026-07-10T00:00",
                "2026-07-10T01:00",
                "2026-07-11T00:00",
            ],
            "weather_code": [0, 2, 95],
            "temperature_2m": [0, 23.1, 21.8],
            "relative_humidity_2m": [80, 78, 92],
            "precipitation_probability": [0, 10, 90],
            "precipitation": [0, 0.1, 8.4],
            "wind_speed_10m": [2.0, 2.5, 18.0],
            "wind_gusts_10m": [3.0, 4.0, 23.0],
        },
    }


def test_normalize_groups_hours_and_preserves_zero_values():
    result = weather_service.normalize_forecast(
        _payload(), cfg=_cfg(), latitude=35.415, longitude=116.587
    )

    assert len(result["days"]) == 2
    assert len(result["days"][0]["hours"]) == 2
    assert len(result["days"][1]["hours"]) == 1
    assert result["days"][0]["hours"][0]["temperature_c"] == 0
    assert result["days"][0]["precipitation_probability_max"] == 0
    assert result["days"][1]["risk_level"] == "alert"
    assert set(result["days"][1]["risk_tags"]) == {"雷暴", "暴雨", "大风"}


def test_get_forecast_builds_query_and_uses_fresh_cache(monkeypatch):
    weather_service.clear_cache()
    calls = []

    async def fake_request(url, params, timeout_seconds):
        calls.append((url, params, timeout_seconds))
        return _payload()

    monkeypatch.setattr(weather_service, "_request_json", fake_request)

    async def run_twice():
        first = await weather_service.get_forecast(_cfg())
        second = await weather_service.get_forecast(_cfg())
        return first, second

    first, second = asyncio.run(run_twice())
    assert len(calls) == 1
    _, params, _ = calls[0]
    assert params["forecast_days"] == 7
    assert params["timezone"] == "Asia/Shanghai"
    assert "weather_code" in params["daily"]
    assert "wind_gusts_10m" in params["hourly"]
    assert "apikey" not in params
    assert first["cached"] is False
    assert second["cached"] is True


def test_expired_forecast_falls_back_to_stale_cache(monkeypatch):
    weather_service.clear_cache()
    clock = {"now": 0.0}
    fail = {"value": False}

    monkeypatch.setattr(weather_service.time, "monotonic", lambda: clock["now"])

    async def fake_request(_url, _params, _timeout_seconds):
        if fail["value"]:
            raise httpx.ConnectError("offline")
        return _payload()

    monkeypatch.setattr(weather_service, "_request_json", fake_request)

    async def scenario():
        fresh = await weather_service.get_forecast(_cfg(cache_minutes=1, stale_hours=1))
        clock["now"] = 61.0
        fail["value"] = True
        stale = await weather_service.get_forecast(_cfg(cache_minutes=1, stale_hours=1))
        return fresh, stale

    fresh, stale = asyncio.run(scenario())
    assert fresh["stale"] is False
    assert stale["cached"] is True
    assert stale["stale"] is True
    assert "缓存" in stale["warning"]


def test_normalize_rejects_missing_daily_data():
    with pytest.raises(weather_service.WeatherServiceError, match="逐日预报"):
        weather_service.normalize_forecast(
            {"daily": {}, "hourly": {"time": []}},
            cfg=_cfg(),
            latitude=35.415,
            longitude=116.587,
        )


def test_normalize_rejects_non_object_sections():
    with pytest.raises(weather_service.WeatherServiceError, match="逐日预报格式"):
        weather_service.normalize_forecast(
            {"daily": "invalid", "hourly": {"time": []}},
            cfg=_cfg(),
            latitude=35.415,
            longitude=116.587,
        )


def test_rejects_unofficial_weather_endpoint():
    weather_service.clear_cache()
    assert weather_service.configured(_cfg(base_url="http://127.0.0.1/weather")) is False
    with pytest.raises(weather_service.WeatherServiceError, match="Open-Meteo 官方"):
        asyncio.run(
            weather_service.get_forecast(
                _cfg(base_url="https://example.com/v1/forecast")
            )
        )
