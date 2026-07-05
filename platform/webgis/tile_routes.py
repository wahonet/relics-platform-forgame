from __future__ import annotations

import asyncio
import base64
import json
import math
import sys
import threading
import time
import urllib.request
import uuid as _uuid
from collections import OrderedDict
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from _common import PROJECT_ROOT

ConfigGetter = Callable[[], dict]

TILE_CACHE_DIR = PROJECT_ROOT / "data" / "output" / "tile_cache"
TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_EMPTY_TILE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg=="
)

_TDT_WMTS = (
    "https://t{{s}}.tianditu.gov.cn/{layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
    "&LAYER={layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles"
    "&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}&tk={{tk}}"
)

TILE_URLS = {
    "arcgis_sat": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "gaode_anno": "https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8",
    # 卫星影像走 wprd 域名:webst0X 在部分网络环境不可达,会导致只显示路网标注
    "gaode_sat": "https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=6",
    "gaode_vec": "https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}",
    # 天地图 WMTS(需 config.api.tianditu.key,建议申请"服务端"类型 key)
    # img=影像底图 cia=影像注记 vec=矢量底图 cva=矢量注记
    "tianditu_img": _TDT_WMTS.format(layer="img"),
    "tianditu_cia": _TDT_WMTS.format(layer="cia"),
    "tianditu_vec": _TDT_WMTS.format(layer="vec"),
    "tianditu_cva": _TDT_WMTS.format(layer="cva"),
}

OFFLINE_ONLY_PROVIDERS = {"arcgis_sat", "osm"}

TILE_UPSTREAM_SEMAPHORE = asyncio.Semaphore(16)
TILE_MEM_CACHE: OrderedDict[str, bytes] = OrderedDict()
TILE_MEM_CACHE_MAX = 1000
TILE_INFLIGHT: dict[str, asyncio.Future] = {}

DOWNLOAD_JOBS: dict[str, dict] = {}
DOWNLOAD_JOBS_LOCK = threading.Lock()
DOWNLOAD_JOB_TTL = 30 * 60
DOWNLOAD_HISTORY_FILE = TILE_CACHE_DIR / "_download_history.jsonl"
DOWNLOAD_HISTORY_MAX = 200
TILE_MIN_ZOOM = 1
TILE_MAX_ZOOM = 17

_get_config: ConfigGetter = lambda: {}


def _parse_provider_list(providers: str) -> list[str]:
    """Keep only known tile providers while preserving user-selected order."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in providers.split(","):
        provider = raw.strip()
        if provider in TILE_URLS and provider not in seen:
            out.append(provider)
            seen.add(provider)
    return out


def _parse_zoom_list(zooms: str) -> list[int]:
    """Parse and clamp user supplied zooms.

    The UI accepts a free-form text field, so malformed values such as
    "12,13,1415,16" must never reach tile math. Invalid/out-of-range tokens are
    ignored; if nothing valid remains the caller returns a normal API error.
    """
    parsed: set[int] = set()
    for raw in zooms.split(","):
        token = raw.strip()
        if not token or not token.isdigit():
            continue
        z = int(token)
        if TILE_MIN_ZOOM <= z <= TILE_MAX_ZOOM:
            parsed.add(z)
    return sorted(parsed)


def _tile_mem_get(key: str) -> bytes | None:
    data = TILE_MEM_CACHE.get(key)
    if data is not None:
        TILE_MEM_CACHE.move_to_end(key)
    return data


def _tile_mem_put(key: str, data: bytes) -> None:
    TILE_MEM_CACHE[key] = data
    TILE_MEM_CACHE.move_to_end(key)
    while len(TILE_MEM_CACHE) > TILE_MEM_CACHE_MAX:
        TILE_MEM_CACHE.popitem(last=False)


def _offline_only() -> bool:
    features = (_get_config().get("features") or {})
    return bool(features.get("offline_only"))


def _tianditu_key() -> str:
    """config.api.tianditu.key;未配置或仍是 ${VAR} 占位时返回空串。"""
    api = (_get_config().get("api") or {})
    key = ((api.get("tianditu") or {}).get("key") or "").strip()
    if key.startswith("${") and key.endswith("}"):
        return ""
    return key


def _fetch_tile(provider: str, z: int, x: int, y: int) -> bytes | None:
    tpl = TILE_URLS.get(provider)
    if not tpl:
        return None
    if provider.startswith("gaode"):
        s = str((x % 4) + 1)
    elif provider.startswith("tianditu"):
        s = str((x + y) % 8)  # 天地图子域 t0-t7
    else:
        s = str(x % 4)
    tk = ""
    if provider.startswith("tianditu"):
        tk = _tianditu_key()
        if not tk:
            return None
    url = tpl.format(s=s, x=x, y=y, z=z, tk=tk)
    if provider.startswith("tianditu"):
        # 服务端类型 key 会拒绝浏览器 UA(Mozilla/*),必须用非浏览器 UA 访问
        headers = {"User-Agent": "RelicsPlatform/2.0"}
    else:
        headers = {"User-Agent": "Mozilla/5.0"}
    if provider.startswith("gaode"):
        headers["Referer"] = "https://www.amap.com/"
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=20).read()


async def _fetch_and_cache_tile(
    provider: str,
    z: int,
    x: int,
    y: int,
    key: str,
    cache_path: Path,
    fut: asyncio.Future,
) -> None:
    try:
        async with TILE_UPSTREAM_SEMAPHORE:
            data = await run_in_threadpool(_fetch_tile, provider, z, x, y)
        if data:
            _tile_mem_put(key, data)
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                await run_in_threadpool(cache_path.write_bytes, data)
            except Exception as e:
                print(f"[tile] cache write failed {key}: {e}")
        if not fut.done():
            fut.set_result(data)
    except Exception as e:
        print(f"[tile] upstream fetch failed {key}: {e}")
        if not fut.done():
            fut.set_result(None)
    finally:
        TILE_INFLIGHT.pop(key, None)


def _lon_to_tile_x(lon: float, z: int) -> int:
    lon = max(-180.0, min(180.0, lon))
    n = 1 << z
    return max(0, min(n - 1, int((lon + 180) / 360 * n)))


def _lat_to_tile_y(lat: float, z: int) -> int:
    lat = max(-85.05112878, min(85.05112878, lat))
    lat_rad = math.radians(lat)
    n = 1 << z
    return max(0, min(n - 1, int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)))


def _bounds_from_config() -> tuple[float, float, float, float]:
    geo = _get_config().get("geo") or {}
    b = geo.get("bounds") or {}
    return (
        float(b.get("west", 73.0)),
        float(b.get("south", 18.0)),
        float(b.get("east", 135.0)),
        float(b.get("north", 54.0)),
    )


def _tiles_for_bounds(west, south, east, north, z):
    if not (TILE_MIN_ZOOM <= z <= TILE_MAX_ZOOM):
        return []
    x0 = _lon_to_tile_x(west, z)
    x1 = _lon_to_tile_x(east, z)
    y0 = _lat_to_tile_y(north, z)
    y1 = _lat_to_tile_y(south, z)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def _count_tiles_in_area(providers: list[str], bbox, zooms: list[int]) -> dict:
    west, south, east, north = bbox
    total = cached = 0
    for z in zooms:
        for tz, tx, ty in _tiles_for_bounds(west, south, east, north, z):
            for prov in providers:
                total += 1
                if (TILE_CACHE_DIR / prov / str(tz) / str(tx) / f"{ty}.tile").exists():
                    cached += 1
    return {"total": total, "cached": cached, "need": max(0, total - cached)}


def _job_create(prov_list, z_list, total, skipped, need, bbox=None, label=None):
    jid = _uuid.uuid4().hex[:12]
    with DOWNLOAD_JOBS_LOCK:
        DOWNLOAD_JOBS[jid] = {
            "id": jid,
            "status": "running",
            "providers": prov_list,
            "zooms": z_list,
            "total": total,
            "skipped": skipped,
            "need": need,
            "downloaded": 0,
            "failed": 0,
            "bytes": 0,
            "bbox": bbox,
            "label": label,
            "started_at": time.time(),
            "finished_at": None,
            "error": None,
        }
    return jid


def _append_download_history(entry: dict) -> None:
    try:
        DOWNLOAD_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with DOWNLOAD_HISTORY_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        try:
            with DOWNLOAD_HISTORY_FILE.open("r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > DOWNLOAD_HISTORY_MAX * 2:
                lines = lines[-DOWNLOAD_HISTORY_MAX:]
                DOWNLOAD_HISTORY_FILE.write_text("".join(lines), encoding="utf-8")
        except Exception:
            pass
    except Exception as e:
        print(f"[tile] history write failed: {e}")


def _read_download_history(limit: int = 50) -> list[dict]:
    if not DOWNLOAD_HISTORY_FILE.exists():
        return []
    try:
        lines = DOWNLOAD_HISTORY_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    out: list[dict] = []
    for line in reversed(lines[-limit:]):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _job_update(jid, **kwargs):
    with DOWNLOAD_JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(jid)
        if job is not None:
            job.update(kwargs)


def _job_gc():
    now = time.time()
    with DOWNLOAD_JOBS_LOCK:
        for jid in list(DOWNLOAD_JOBS.keys()):
            j = DOWNLOAD_JOBS[jid]
            ft = j.get("finished_at") or 0
            if ft and (now - ft) > DOWNLOAD_JOB_TTL:
                DOWNLOAD_JOBS.pop(jid, None)


def _run_download_job(jid: str, tasks: list):
    import concurrent.futures

    def _dl_one(args):
        prov, z, x, y, cp = args
        try:
            data = _fetch_tile(prov, z, x, y)
            if data:
                cp.parent.mkdir(parents=True, exist_ok=True)
                cp.write_bytes(data)
                return True, len(data)
        except Exception:
            pass
        return False, 0

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            for ok, nbytes in pool.map(_dl_one, tasks):
                with DOWNLOAD_JOBS_LOCK:
                    job = DOWNLOAD_JOBS.get(jid)
                    if job is None:
                        return
                    if ok:
                        job["downloaded"] += 1
                        job["bytes"] += nbytes
                    else:
                        job["failed"] += 1
        _job_update(jid, status="done", finished_at=time.time())
    except Exception as e:
        _job_update(jid, status="error", error=str(e), finished_at=time.time())

    with DOWNLOAD_JOBS_LOCK:
        snap = dict(DOWNLOAD_JOBS.get(jid) or {})
    if snap:
        _append_download_history({
            "id": snap.get("id"),
            "status": snap.get("status"),
            "label": snap.get("label"),
            "providers": snap.get("providers"),
            "zooms": snap.get("zooms"),
            "bbox": snap.get("bbox"),
            "total": snap.get("total"),
            "skipped": snap.get("skipped"),
            "need": snap.get("need"),
            "downloaded": snap.get("downloaded"),
            "failed": snap.get("failed"),
            "bytes": snap.get("bytes"),
            "started_at": snap.get("started_at"),
            "finished_at": snap.get("finished_at"),
            "error": snap.get("error"),
        })


def _collect_cache_info() -> dict:
    info: dict[str, dict] = {}
    for prov_dir in TILE_CACHE_DIR.iterdir() if TILE_CACHE_DIR.exists() else []:
        if not prov_dir.is_dir():
            continue
        count = 0
        size = 0
        for p in prov_dir.rglob("*.tile"):
            try:
                count += 1
                size += p.stat().st_size
            except Exception:
                pass
        info[prov_dir.name] = {"count": count, "bytes": size}
    return {"cache_dir": str(TILE_CACHE_DIR), "providers": info}


def register_tile_routes(app: FastAPI, get_config: ConfigGetter) -> None:
    global _get_config
    _get_config = get_config

    @app.get("/tiles/{provider}/{z}/{x}/{y}")
    async def tile_proxy(provider: str, z: int, x: int, y: int, request: Request):
        key = f"{provider}/{z}/{x}/{y}"

        mem = _tile_mem_get(key)
        if mem is not None:
            return Response(
                content=mem,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=31536000"},
            )

        cache_path = TILE_CACHE_DIR / provider / str(z) / str(x) / f"{y}.tile"
        if cache_path.exists():
            data = await run_in_threadpool(cache_path.read_bytes)
            _tile_mem_put(key, data)
            return Response(
                content=data,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=31536000"},
            )

        wants_offline = request.query_params.get("offline") in ("1", "true", "yes")
        if (
            wants_offline
            or provider in OFFLINE_ONLY_PROVIDERS
            or _offline_only()
            or provider not in TILE_URLS
        ):
            return Response(content=_EMPTY_TILE, media_type="image/png")

        fut = TILE_INFLIGHT.get(key)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            TILE_INFLIGHT[key] = fut
            asyncio.create_task(_fetch_and_cache_tile(provider, z, x, y, key, cache_path, fut))

        try:
            data = await asyncio.wait_for(fut, timeout=25)
        except Exception:
            data = None
        if data:
            return Response(
                content=data,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=31536000"},
            )
        return Response(content=_EMPTY_TILE, media_type="image/png")

    @app.get("/api/tiles/cache-status")
    async def cache_status(provider: str = "arcgis_sat"):
        bbox = _bounds_from_config()
        total, cached_n = 0, 0
        for z in range(1, 16):
            tiles = _tiles_for_bounds(*bbox, z)
            total += len(tiles)
            for tz, tx, ty in tiles:
                if (TILE_CACHE_DIR / provider / str(tz) / str(tx) / f"{ty}.tile").exists():
                    cached_n += 1
        return {"total": total, "cached": cached_n}

    @app.post("/api/tiles/precache")
    async def precache_tiles(provider: str = "arcgis_sat", min_zoom: int = 1, max_zoom: int = 15):
        import concurrent.futures

        if provider not in TILE_URLS:
            provider = "arcgis_sat"

        bbox = _bounds_from_config()
        tasks, skipped = [], 0
        zm = min(max_zoom + 1, 17)
        for z in range(max(1, min_zoom), zm):
            for tz, tx, ty in _tiles_for_bounds(*bbox, z):
                cp = TILE_CACHE_DIR / provider / str(tz) / str(tx) / f"{ty}.tile"
                if cp.exists():
                    skipped += 1
                else:
                    tasks.append((provider, tz, tx, ty, cp))

        def _dl_one(args):
            prov, z, x, y, cp = args
            try:
                data = _fetch_tile(prov, z, x, y)
                if data:
                    cp.parent.mkdir(parents=True, exist_ok=True)
                    cp.write_bytes(data)
                    return True
            except Exception:
                return False

        def _run():
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                return list(pool.map(_dl_one, tasks))

        results = await run_in_threadpool(_run) if tasks else []
        downloaded = sum(1 for r in results if r)
        failed = sum(1 for r in results if not r)
        return {"downloaded": downloaded, "failed": failed, "skipped": skipped}

    @app.get("/api/tiles/area-estimate")
    async def tiles_area_estimate(
        west: float,
        south: float,
        east: float,
        north: float,
        providers: str = "arcgis_sat,osm",
        zooms: str = "12,13,14,15",
    ):
        if not (west < east and south < north):
            return {"error": "invalid bbox"}
        prov_list = _parse_provider_list(providers)
        if not prov_list:
            return {"error": "no valid provider"}
        z_list = _parse_zoom_list(zooms)
        if not z_list:
            return {"error": "no zoom"}
        stat = _count_tiles_in_area(prov_list, (west, south, east, north), z_list)
        return {
            "bbox": {"west": west, "south": south, "east": east, "north": north},
            "providers": prov_list,
            "zooms": z_list,
            **stat,
        }

    @app.post("/api/tiles/download-area")
    async def download_area_tiles(
        west: float,
        south: float,
        east: float,
        north: float,
        providers: str = "arcgis_sat,osm",
        zooms: str = "12,13,14,15",
        label: str = "",
    ):
        if not (west < east and south < north):
            return {"error": "invalid bbox"}
        prov_list = _parse_provider_list(providers)
        if not prov_list:
            return {"error": "no valid provider"}
        z_list = _parse_zoom_list(zooms)
        if not z_list:
            return {"error": "no zoom"}

        tasks, skipped = [], 0
        for prov in prov_list:
            for z in z_list:
                for tz, tx, ty in _tiles_for_bounds(west, south, east, north, z):
                    cp = TILE_CACHE_DIR / prov / str(tz) / str(tx) / f"{ty}.tile"
                    if cp.exists():
                        skipped += 1
                    else:
                        tasks.append((prov, tz, tx, ty, cp))

        total = len(tasks) + skipped
        bbox_tuple = [west, south, east, north]
        jid = _job_create(
            prov_list,
            z_list,
            total=total,
            skipped=skipped,
            need=len(tasks),
            bbox=bbox_tuple,
            label=(label or None),
        )
        if not tasks:
            now = time.time()
            _job_update(jid, status="done", finished_at=now)
            _append_download_history({
                "id": jid,
                "status": "done",
                "label": (label or None),
                "providers": prov_list,
                "zooms": z_list,
                "bbox": bbox_tuple,
                "total": total,
                "skipped": skipped,
                "need": 0,
                "downloaded": 0,
                "failed": 0,
                "bytes": 0,
                "started_at": now,
                "finished_at": now,
                "error": None,
            })
            return {"job_id": jid, "total": total, "skipped": skipped, "need": 0}

        threading.Thread(target=_run_download_job, args=(jid, tasks), daemon=True).start()

        return {
            "job_id": jid,
            "providers": prov_list,
            "zooms": z_list,
            "total": total,
            "skipped": skipped,
            "need": len(tasks),
        }

    @app.get("/api/tiles/download-progress/{job_id}")
    async def download_progress(job_id: str):
        _job_gc()
        with DOWNLOAD_JOBS_LOCK:
            job = DOWNLOAD_JOBS.get(job_id)
            if job is None:
                return {"error": "job not found"}
            return dict(job)

    @app.get("/api/tiles/cache-info")
    async def cache_info():
        return _collect_cache_info()

    @app.get("/api/tiles/history")
    async def download_history(limit: int = 50):
        if limit < 1:
            limit = 1
        if limit > DOWNLOAD_HISTORY_MAX:
            limit = DOWNLOAD_HISTORY_MAX
        return {"items": _read_download_history(limit=limit)}

    @app.get("/api/admin/tiles/summary")
    async def admin_tiles_summary(limit: int = 20):
        cache = _collect_cache_info()
        provs = cache.get("providers") or {}
        total_count = sum(p.get("count", 0) for p in provs.values())
        total_bytes = sum(p.get("bytes", 0) for p in provs.values())

        hist = _read_download_history(limit=max(limit, 1))
        last_finished = None
        for h in hist:
            if h.get("finished_at"):
                last_finished = h["finished_at"]
                break

        return {
            "cache_dir": cache.get("cache_dir"),
            "providers": provs,
            "totals": {"count": total_count, "bytes": total_bytes},
            "last_finished_at": last_finished,
            "recent": hist[:limit],
        }

    @app.post("/api/tiles/open-cache-folder")
    async def open_cache_folder():
        import subprocess

        TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path_str = str(TILE_CACHE_DIR)
        try:
            if sys.platform.startswith("win"):
                import os as _os

                _os.startfile(path_str)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path_str])
            else:
                subprocess.Popen(["xdg-open", path_str])
            return {"ok": True, "path": path_str}
        except Exception as e:
            return {"ok": False, "path": path_str, "error": str(e)}

    @app.post("/api/tiles/clear-cache")
    async def clear_cache(providers: str = "", clear_history: bool = True):
        import shutil

        target_names = [p.strip() for p in providers.split(",") if p.strip()] if providers else None
        clear_all = target_names is None

        removed: dict[str, int] = {}

        def _do_remove():
            if not TILE_CACHE_DIR.exists():
                return
            for prov_dir in list(TILE_CACHE_DIR.iterdir()):
                if not prov_dir.is_dir():
                    continue
                if target_names is not None and prov_dir.name not in target_names:
                    continue
                count = sum(1 for _ in prov_dir.rglob("*.tile"))
                try:
                    shutil.rmtree(prov_dir)
                    removed[prov_dir.name] = count
                except Exception as e:
                    removed[prov_dir.name] = -1
                    print(f"[tile] cache clear failed {prov_dir}: {e}")

        def _do_history():
            if not clear_history or not DOWNLOAD_HISTORY_FILE.exists():
                return
            if clear_all:
                try:
                    DOWNLOAD_HISTORY_FILE.unlink()
                except Exception as e:
                    print(f"[tile] history clear failed: {e}")
                return
            try:
                kept: list[str] = []
                with DOWNLOAD_HISTORY_FILE.open("r", encoding="utf-8") as f:
                    for line in f:
                        s = line.strip()
                        if not s:
                            continue
                        try:
                            obj = json.loads(s)
                        except Exception:
                            kept.append(line if line.endswith("\n") else line + "\n")
                            continue
                        provs = obj.get("providers") or []
                        if any(p in (target_names or []) for p in provs):
                            continue
                        kept.append(line if line.endswith("\n") else line + "\n")
                DOWNLOAD_HISTORY_FILE.write_text("".join(kept), encoding="utf-8")
            except Exception as e:
                print(f"[tile] history rewrite failed: {e}")

        await run_in_threadpool(_do_remove)
        await run_in_threadpool(_do_history)
        TILE_MEM_CACHE.clear()
        return {"cleared": removed, "history_cleared": clear_history}
