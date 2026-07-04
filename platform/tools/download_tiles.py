"""离线底图瓦片批量下载工具。

按 `config.yaml → geo.bounds` 批量拉取瓦片到
`data/output/tile_cache/<provider>/<z>/<x>/<y>.tile`,后端 `/tiles` 路由
会优先从这里读取。默认同时下载 arcgis_sat + osm,可用 `--provider` 过滤。

用法:
    python platform/tools/download_tiles.py
    python platform/tools/download_tiles.py --provider arcgis_sat --min-zoom 14
"""
from __future__ import annotations

import argparse
import concurrent.futures
import math
import sys
import time
import urllib.request
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from _common import PROJECT_ROOT, load_config  # noqa: E402

CACHE_DIR = PROJECT_ROOT / "data" / "output" / "tile_cache"
WORKERS = 10

PROVIDERS = {
    "arcgis_sat": {
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "name": "ArcGIS 卫星影像",
        "headers": {"User-Agent": "Mozilla/5.0"},
        "max_zoom": 17,
    },
    "osm": {
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "name": "OpenStreetMap 路网",
        "headers": {"User-Agent": "RelicsPlatform/1.0 (offline-cache)"},
        "max_zoom": 17,
    },
}


def _lon_to_x(lon: float, z: int) -> int:
    return int((lon + 180) / 360 * (1 << z))


def _lat_to_y(lat: float, z: int) -> int:
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (1 << z))


def _get_tiles(bbox, min_z: int, max_z: int):
    west, south, east, north = bbox
    tiles = []
    for z in range(min_z, max_z + 1):
        x0, x1 = _lon_to_x(west, z), _lon_to_x(east, z)
        y0, y1 = _lat_to_y(north, z), _lat_to_y(south, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tiles.append((z, x, y))
    return tiles


def download_batch(provider_key: str, bbox, min_z: int, max_z: int) -> None:
    prov = PROVIDERS[provider_key]
    url_tpl = prov["url"]
    headers = prov["headers"]
    max_z = min(max_z, prov["max_zoom"])

    tiles = _get_tiles(bbox, min_z, max_z)
    cached = sum(
        1 for z, x, y in tiles
        if (CACHE_DIR / provider_key / str(z) / str(x) / f"{y}.tile").exists()
    )
    need = len(tiles) - cached

    print(f"\n  [{prov['name']}] z{min_z}-z{max_z}", flush=True)
    print(f"  总计: {len(tiles)} 张  已有: {cached}  待下: {need}", flush=True)
    if need == 0:
        print("  全部已下载！", flush=True)
        return

    def dl(args):
        z, x, y = args
        cp = CACHE_DIR / provider_key / str(z) / str(x) / f"{y}.tile"
        if cp.exists():
            return "skip"
        url = url_tpl.format(z=z, x=x, y=y)
        try:
            req = urllib.request.Request(url, headers=headers)
            data = urllib.request.urlopen(req, timeout=20).read()
            cp.parent.mkdir(parents=True, exist_ok=True)
            cp.write_bytes(data)
            return "ok"
        except Exception:
            return "fail"

    t0 = time.time()
    ok = fail = skip = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(dl, t): t for t in tiles}
        done_n = 0
        for f in concurrent.futures.as_completed(futures):
            r = f.result()
            done_n += 1
            if r == "ok":
                ok += 1
            elif r == "fail":
                fail += 1
            else:
                skip += 1
            if done_n % 200 == 0 or done_n == len(tiles):
                elapsed = time.time() - t0
                speed = ok / elapsed if elapsed > 0 and ok > 0 else 1
                eta = (need - ok - fail) / speed if speed > 0 else 0
                print(f"  [{done_n:>6}/{len(tiles)}] ok:{ok} skip:{skip} fail:{fail} "
                      f"{speed:.1f}/s eta:{eta:.0f}s", flush=True)

    elapsed = time.time() - t0
    print(f"  done in {elapsed:.0f}s — ok:{ok} fail:{fail} skip:{skip}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=list(PROVIDERS.keys()), default=None)
    ap.add_argument("--min-zoom", type=int, default=1)
    ap.add_argument("--max-zoom", type=int, default=17)
    args = ap.parse_args()

    cfg = load_config()
    b = (cfg.get("geo") or {}).get("bounds") or {}
    bbox = (
        float(b.get("west", 73.0)),
        float(b.get("south", 18.0)),
        float(b.get("east", 135.0)),
        float(b.get("north", 54.0)),
    )

    print("=" * 52)
    print("  离线底图下载")
    print(f"  范围: W={bbox[0]} S={bbox[1]} E={bbox[2]} N={bbox[3]}")
    print(f"  保存到: {CACHE_DIR}")
    print("=" * 52)

    providers = [args.provider] if args.provider else list(PROVIDERS.keys())
    for pkey in providers:
        download_batch(pkey, bbox, args.min_zoom, args.max_zoom)

    if CACHE_DIR.exists():
        total_size = sum(f.stat().st_size for f in CACHE_DIR.rglob("*.tile"))
        print(f"\n  缓存总大小: {total_size / 1024 / 1024:.1f} MB", flush=True)
    print("=" * 52, flush=True)


if __name__ == "__main__":
    main()
