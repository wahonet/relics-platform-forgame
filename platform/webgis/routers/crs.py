"""坐标转换 API。

前端日常的鼠标坐标读数走 src/utils/crs.ts (TS 镜像) 不打这个接口;
本路由提供:
    GET  /api/crs/list                   支持的 CRS 清单
    POST /api/crs/transform              单点 / 批量点转换
    POST /api/crs/transform-geojson      GeoJSON 整体转换
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from crs import (  # noqa: E402
    SUPPORTED_CRS,
    transform_geojson,
    transform_point,
)

router = APIRouter()


# ── /api/crs/list ─────────────────────────────────────────────
@router.get("/crs/list")
async def list_crs():
    """返回所有支持的 CRS, 给前端下拉选用。"""
    return {
        "items": [
            {"id": k, **v}
            for k, v in SUPPORTED_CRS.items()
        ],
    }


# ── /api/crs/transform ────────────────────────────────────────
class TransformRequest(BaseModel):
    """src_crs 与 dst_crs 必填; coords 是 [[a,b], ...] 列表 (单点也用 list 包一层)。

    central_meridian 仅当源/目标涉及高斯投影时使用; None 时按几何经度自动选带。
    zone_prefix 默认 True, 即 GK 的 x 带号前缀 (例 38500000.0)。
    """
    src_crs: str
    dst_crs: str
    coords: list[list[float]]
    central_meridian: Optional[float] = None
    zone_width: int = 3
    zone_prefix: bool = True


@router.post("/crs/transform")
async def crs_transform(req: TransformRequest):
    if req.src_crs not in SUPPORTED_CRS:
        raise HTTPException(400, f"不支持的 src_crs: {req.src_crs}")
    if req.dst_crs not in SUPPORTED_CRS:
        raise HTTPException(400, f"不支持的 dst_crs: {req.dst_crs}")
    out: list[list[float]] = []
    for c in req.coords:
        if not c or len(c) < 2:
            raise HTTPException(400, f"非法坐标点: {c}")
        try:
            x, y = transform_point(
                req.src_crs, req.dst_crs,
                float(c[0]), float(c[1]),
                central_meridian=req.central_meridian,
                zone_width=req.zone_width,
                zone_prefix=req.zone_prefix,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        out.append([x, y, *c[2:]])
    return {
        "src_crs": req.src_crs,
        "dst_crs": req.dst_crs,
        "count": len(out),
        "coords": out,
    }


# ── /api/crs/transform-geojson ────────────────────────────────
class TransformGeojsonRequest(BaseModel):
    src_crs: str
    dst_crs: str
    geojson: dict
    central_meridian: Optional[float] = None
    zone_width: int = 3
    zone_prefix: bool = True


@router.post("/crs/transform-geojson")
async def crs_transform_geojson(req: TransformGeojsonRequest):
    if req.src_crs not in SUPPORTED_CRS:
        raise HTTPException(400, f"不支持的 src_crs: {req.src_crs}")
    if req.dst_crs not in SUPPORTED_CRS:
        raise HTTPException(400, f"不支持的 dst_crs: {req.dst_crs}")
    try:
        out = transform_geojson(
            req.geojson, req.src_crs, req.dst_crs,
            central_meridian=req.central_meridian,
            zone_width=req.zone_width,
            zone_prefix=req.zone_prefix,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"src_crs": req.src_crs, "dst_crs": req.dst_crs, "geojson": out}
