from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from _common import PROJECT_ROOT
from terrain_provider import get_tile_heights_fast

TERRAIN_CACHE_DIR = PROJECT_ROOT / "data" / "output" / "terrain_cache"
TERRAIN_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def register_terrain_routes(app: FastAPI) -> None:
    @app.get("/api/terrain/{level}/{x}/{y}")
    async def terrain_tile(level: int, x: int, y: int):
        """Return Cesium heightmap terrain tile bytes, with disk cache."""
        cache_path = TERRAIN_CACHE_DIR / str(level) / str(x) / f"{y}.bin"
        if cache_path.exists():
            data = await run_in_threadpool(cache_path.read_bytes)
        else:
            data = await run_in_threadpool(get_tile_heights_fast, level, x, y)
            if data:
                try:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    await run_in_threadpool(cache_path.write_bytes, data)
                except Exception as e:
                    print(f"[terrain] cache write failed {level}/{x}/{y}: {e}")
        if data is None:
            return Response(status_code=404)
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "public, max-age=86400",
                "Access-Control-Allow-Origin": "*",
            },
        )

