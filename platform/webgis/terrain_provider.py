"""本地 DEM 地形瓦片。

启动时把 `data/input/04_dem/` 下的 GeoTIFF 合并到内存,运行时按
Cesium CustomHeightmapTerrainProvider 的 (level, x, y) 插值出 65x65
Float32 小端高程瓦片。

`_parse_extent` 默认支持 ASTER GDEM v2 命名:
    ASTGTM2_N{lat}E{lon}_dem.tif  →  [lat, lat+1] × [lon, lon+1]
其它来源需按此扩展。
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

try:
    import tifffile
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "DEM 地形功能需要 tifffile，请运行 pip install tifffile"
    ) from e

TILE_SIZE = 65

_DEM_TILES: list[dict] = []
_merged: Optional[np.ndarray] = None
_merged_west: float = 0.0
_merged_south: float = 0.0
_merged_east: float = 0.0
_merged_north: float = 0.0


def _parse_extent(name: str) -> Optional[tuple[int, int]]:
    """从 DEM 文件名里解析 1x1 度瓦片的西南角 (lat, lon),失败返回 None。"""
    base = Path(name).stem.upper()
    parts = base.split("_")
    if len(parts) < 2:
        return None
    coord = parts[1]
    if not coord or coord[0] not in ("N", "S"):
        return None
    try:
        lat_idx = coord.index("E") if "E" in coord[1:] else coord.index("W", 1)
        lat = int(coord[1:lat_idx])
        lon = int(coord[lat_idx + 1:])
    except (ValueError, IndexError):
        return None
    if coord[0] == "S":
        lat = -lat
    if coord[lat_idx] == "W":
        lon = -lon
    return lat, lon


def load_dem(dem_dir: str | Path) -> bool:
    """加载 dem_dir 下所有 1x1 度 GeoTIFF,并拼成覆盖全部输入范围的单数组。
    相邻瓦片共享一圈边缘像素(rows-1/cols-1 的拼接步长)。"""
    global _merged, _merged_west, _merged_south, _merged_east, _merged_north, _DEM_TILES

    dem_path = Path(dem_dir)
    if not dem_path.exists():
        print(f"[DEM] 目录不存在: {dem_dir}")
        return False

    files = sorted(dem_path.glob("*_dem.tif"))
    if not files:
        files = sorted(dem_path.glob("*.tif"))
    if not files:
        print(f"[DEM] 未在 {dem_dir} 找到任何 .tif 文件")
        return False

    tiles = []
    for f in files:
        ext = _parse_extent(f.name)
        if not ext:
            print(f"[DEM] 跳过无法识别的文件名: {f.name}")
            continue
        lat, lon = ext
        data = tifffile.imread(str(f)).astype(np.float32)
        tiles.append({"lat": lat, "lon": lon, "data": data, "file": f.name})
        print(
            f"[DEM] 加载 {f.name}: {data.shape}, "
            f"范围 N{lat}-N{lat+1} E{lon}-E{lon+1}, "
            f"高程 {data.min():.0f}~{data.max():.0f}m"
        )

    if not tiles:
        return False

    _DEM_TILES = tiles

    lats = [t["lat"] for t in tiles]
    lons = [t["lon"] for t in tiles]
    _merged_south = min(lats)
    _merged_north = max(lats) + 1
    _merged_west = min(lons)
    _merged_east = max(lons) + 1

    lat_range = _merged_north - _merged_south
    lon_range = _merged_east - _merged_west
    rows_per_tile, cols_per_tile = tiles[0]["data"].shape

    total_rows = lat_range * (rows_per_tile - 1) + 1
    total_cols = lon_range * (cols_per_tile - 1) + 1
    _merged = np.zeros((total_rows, total_cols), dtype=np.float32)

    for t in tiles:
        row_offset = (_merged_north - t["lat"] - 1) * (rows_per_tile - 1)
        col_offset = (t["lon"] - _merged_west) * (cols_per_tile - 1)
        r0, r1 = row_offset, row_offset + rows_per_tile
        c0, c1 = col_offset, col_offset + cols_per_tile
        _merged[r0:r1, c0:c1] = t["data"]

    print(
        f"[DEM] 合并完成: {_merged.shape}, "
        f"范围 N{_merged_south}-N{_merged_north} E{_merged_west}-E{_merged_east}, "
        f"高程 {_merged.min():.0f}~{_merged.max():.0f}m"
    )
    return True


def _geo_tile_bounds(level: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Cesium GeographicTilingScheme: level 0 是 2x1 个 180 度大小的瓦片,
    每提升一级瓦片数翻倍、边长减半。"""
    num_x = 2 * (1 << level)
    num_y = 1 << level
    tile_w = 360.0 / num_x
    tile_h = 180.0 / num_y
    west = -180.0 + x * tile_w
    south = 90.0 - (y + 1) * tile_h
    return west, south, west + tile_w, south + tile_h


def get_tile_heights_fast(level: int, x: int, y: int) -> Optional[bytes]:
    """双线性采样 _merged,产出 65x65 Float32 小端字节流。
    瓦片完全在 DEM 覆盖范围外返回 None(交由上层返回 404)。"""
    if _merged is None:
        return None

    west, south, east, north = _geo_tile_bounds(level, x, y)
    if east <= _merged_west or west >= _merged_east or north <= _merged_south or south >= _merged_north:
        return None

    rows, cols = _merged.shape
    res_lat = (_merged_north - _merged_south) / (rows - 1)
    res_lon = (_merged_east - _merged_west) / (cols - 1)

    lat_arr = np.linspace(north, south, TILE_SIZE)
    lon_arr = np.linspace(west, east, TILE_SIZE)
    lon_grid, lat_grid = np.meshgrid(lon_arr, lat_arr)

    fr = (_merged_north - lat_grid) / res_lat
    fc = (lon_grid - _merged_west) / res_lon
    fr = np.clip(fr, 0, rows - 1)
    fc = np.clip(fc, 0, cols - 1)

    r0 = np.floor(fr).astype(int)
    c0 = np.floor(fc).astype(int)
    r1 = np.minimum(r0 + 1, rows - 1)
    c1 = np.minimum(c0 + 1, cols - 1)
    r0 = np.minimum(r0, rows - 1)
    c0 = np.minimum(c0, cols - 1)

    dr = fr - r0
    dc = fc - c0

    h = (
        _merged[r0, c0] * (1 - dr) * (1 - dc)
        + _merged[r0, c1] * (1 - dr) * dc
        + _merged[r1, c0] * dr * (1 - dc)
        + _merged[r1, c1] * dr * dc
    )

    outside = (
        (lat_grid < _merged_south) | (lat_grid > _merged_north)
        | (lon_grid < _merged_west) | (lon_grid >= _merged_east)
    )
    h[outside] = 0.0
    h = np.maximum(h, 0.0).astype(np.float32)

    return h.tobytes()
