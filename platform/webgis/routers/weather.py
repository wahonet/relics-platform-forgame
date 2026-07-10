"""地图总览天气预报接口。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from _common import load_config
from services import weather_service


router = APIRouter()


@router.get("/weather/forecast")
async def weather_forecast():
    try:
        return await weather_service.get_forecast(load_config())
    except weather_service.WeatherServiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
