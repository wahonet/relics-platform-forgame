"""统一坐标转换服务（pure functions, 无 IO 无依赖）。

支持的 CRS:
    wgs84            : WGS84 经纬度 (°), 内部存储和瓦片渲染基准
    cgcs2000         : CGCS2000 经纬度 (°), 与 WGS84 实际差异 < 1m
    cgcs2000_gk_3    : CGCS2000 高斯-克吕格 3°带投影 (m)
    cgcs2000_gk_6    : CGCS2000 高斯-克吕格 6°带投影 (m)
    gcj02            : 火星坐标 (°), 高德/腾讯地图
    bd09             : 百度坐标 (°)
    web_mercator     : Web Mercator EPSG:3857 (m), 瓦片底图基准

精度策略:
    1. 默认 wgs84 ↔ cgcs2000 走 identity (米级近似, 工程实用足够);
       想要 cm 级时可在 set_helmert_params 里注入 7 参数 Helmert 变换。
    2. 高斯-克吕格正反算用椭球级数展开, 全国范围 < 1mm 精度。
    3. GCJ-02 / BD-09 复用 _common.py 已有的火星算法。

约定:
    - 经纬度顺序 (lng, lat) (与 GeoJSON、step02 文物点位一致)
    - 投影坐标顺序 (x, y) 即 (东向 East, 北向 North)
    - GK 的 x 默认含带号 (例: 38500000.0 表 38 带, 中央 114°),
      读出时按 zone_prefix 参数判断是否剥离

参考:
    - GB/T 17159  大地测量术语
    - GB/T 22260  CGCS2000 坐标参数
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

# 复用 _common.py 的 GCJ 函数
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from _common import gcj02_to_wgs84, wgs84_to_gcj02  # noqa: E402

__all__ = [
    "SUPPORTED_CRS",
    "transform_point",
    "transform_geojson",
    # GK
    "gk_forward",
    "gk_inverse",
    "gk_zone_for_lng",
    "gk_central_meridian",
    # CGCS2000
    "wgs84_to_cgcs2000",
    "cgcs2000_to_wgs84",
    "set_helmert_params",
    "get_helmert_params",
    # Web Mercator
    "wgs84_to_web_mercator",
    "web_mercator_to_wgs84",
    # GCJ / BD
    "gcj02_to_wgs84",
    "wgs84_to_gcj02",
    "wgs84_to_bd09",
    "bd09_to_wgs84",
]


# ── CRS 注册表 ────────────────────────────────────────────────
SUPPORTED_CRS: dict[str, dict] = {
    "wgs84": {
        "name": "WGS84 经纬度",
        "epsg": 4326,
        "unit": "degree",
        "axes": ["lng", "lat"],
        "category": "geographic",
        "description": "全球 GPS / 瓦片 / GeoJSON 通用基准",
    },
    "cgcs2000": {
        "name": "CGCS2000 经纬度",
        "epsg": 4490,
        "unit": "degree",
        "axes": ["lng", "lat"],
        "category": "geographic",
        "description": "国家 2000 大地坐标系，工程上与 WGS84 差异 < 1m",
    },
    "cgcs2000_gk_3": {
        "name": "CGCS2000 高斯 3°带",
        "epsg": None,  # EPSG 4513..4533 按带分配
        "unit": "meter",
        "axes": ["x", "y"],
        "category": "projected",
        "description": "测绘行业主流，需指定中央子午线（默认按经度自动选）",
    },
    "cgcs2000_gk_6": {
        "name": "CGCS2000 高斯 6°带",
        "epsg": None,  # EPSG 4491..4501
        "unit": "meter",
        "axes": ["x", "y"],
        "category": "projected",
        "description": "老规范小比例尺常用",
    },
    "gcj02": {
        "name": "GCJ-02 火星坐标",
        "epsg": None,
        "unit": "degree",
        "axes": ["lng", "lat"],
        "category": "geographic",
        "description": "高德 / 腾讯地图加密坐标",
    },
    "bd09": {
        "name": "BD-09 百度坐标",
        "epsg": None,
        "unit": "degree",
        "axes": ["lng", "lat"],
        "category": "geographic",
        "description": "百度地图加密坐标",
    },
    "web_mercator": {
        "name": "Web Mercator (EPSG:3857)",
        "epsg": 3857,
        "unit": "meter",
        "axes": ["x", "y"],
        "category": "projected",
        "description": "瓦片底图内部坐标",
    },
}


# ── 椭球参数 (CGCS2000 / WGS84 数值上视为同一椭球) ─────────────
_A = 6378137.0
_F = 1 / 298.257222101  # CGCS2000 扁率
_B = _A * (1 - _F)
_E2 = (_A ** 2 - _B ** 2) / _A ** 2
_EP2 = (_A ** 2 - _B ** 2) / _B ** 2


# ── 高斯-克吕格 ───────────────────────────────────────────────
def gk_zone_for_lng(lng: float, zone_width: int = 3) -> int:
    """根据经度自动判断 GK 带号。
    zone_width=3: 带号 = round(lng/3), 中央经线 = 带号*3
    zone_width=6: 带号 = int((lng+6)/6) ≈ int(lng/6)+1, 中央经线 = 带号*6 - 3
    """
    if zone_width == 6:
        return int(lng / 6) + 1
    return int(round(lng / 3))


def gk_central_meridian(zone: int, zone_width: int = 3) -> float:
    if zone_width == 6:
        return zone * 6 - 3
    return zone * 3


def gk_forward(
    lng: float,
    lat: float,
    central_meridian: float,
    zone_prefix: bool = True,
    zone_width: int = 3,
) -> tuple[float, float]:
    """WGS84/CGCS2000 经纬度 → 高斯-克吕格投影 (x, y) 单位米。
    zone_prefix=True 时 x 前缀加带号 (例: 38500000.0 表 38 带), 否则只给本地 x。"""
    lng_rad = math.radians(lng)
    lat_rad = math.radians(lat)
    cm_rad = math.radians(central_meridian)
    L = lng_rad - cm_rad

    sf = math.sin(lat_rad)
    cf = math.cos(lat_rad)
    tf = math.tan(lat_rad)
    N = _A / math.sqrt(1 - _E2 * sf * sf)
    T = tf * tf
    C = _EP2 * cf * cf
    A = L * cf

    M = _A * (
        (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256) * lat_rad
        - (3 * _E2 / 8 + 3 * _E2 ** 2 / 32 + 45 * _E2 ** 3 / 1024) * math.sin(2 * lat_rad)
        + (15 * _E2 ** 2 / 256 + 45 * _E2 ** 3 / 1024) * math.sin(4 * lat_rad)
        - (35 * _E2 ** 3 / 3072) * math.sin(6 * lat_rad)
    )

    x_local = N * (
        A
        + (1 - T + C) * A ** 3 / 6
        + (5 - 18 * T + T * T + 72 * C - 58 * _EP2) * A ** 5 / 120
    )
    y = M + N * tf * (
        A * A / 2
        + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
        + (61 - 58 * T + T * T + 600 * C - 330 * _EP2) * A ** 6 / 720
    )

    x = x_local + 500_000  # 东向假偏移
    if zone_prefix:
        zone = gk_zone_for_lng(central_meridian, zone_width=zone_width) if zone_width == 6 else int(round(central_meridian / 3))
        x += zone * 1_000_000

    return round(x, 4), round(y, 4)


def gk_inverse(
    x: float,
    y: float,
    central_meridian: float,
    zone_prefix: bool = True,
    zone_width: int = 3,
) -> tuple[float, float]:
    """高斯-克吕格 (x, y, m) → 经纬度。zone_prefix=True 时自动剥离带号。"""
    if zone_prefix and x > 1_000_000:
        zone = int(x / 1_000_000)
        x_local = x - zone * 1_000_000 - 500_000
    else:
        x_local = x - 500_000
    y_local = y

    mu = y_local / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    fp = (
        mu
        + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
        + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
    )
    sf, cf, tf = math.sin(fp), math.cos(fp), math.tan(fp)
    N1 = _A / math.sqrt(1 - _E2 * sf * sf)
    T1 = tf * tf
    C1 = _EP2 * cf * cf
    R1 = _A * (1 - _E2) / (1 - _E2 * sf * sf) ** 1.5
    D = x_local / N1

    lat = fp - (N1 * tf / R1) * (
        D ** 2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * _EP2) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * _EP2 - 3 * C1 ** 2) * D ** 6 / 720
    )
    lng = (
        D
        - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * _EP2 + 24 * T1 ** 2) * D ** 5 / 120
    ) / cf

    return (
        round(math.degrees(lng) + central_meridian, 8),
        round(math.degrees(lat), 8),
    )


# ── CGCS2000 ↔ WGS84 ─────────────────────────────────────────
# 默认采用 identity 近似:工程上 < 1m 精度足够。
# 想要 cm 级精度可调用 set_helmert_params() 注入 7 参 Bursa-Wolf 参数。
_HELMERT: dict | None = None


def set_helmert_params(params: dict | None) -> None:
    """注入 7 参 Bursa-Wolf 变换参数 (CGCS2000 → WGS84)。
    params 字段: dx, dy, dz (m), rx, ry, rz (角秒), ds (ppm)。
    传 None 即关闭, 退化为 identity。"""
    global _HELMERT
    if params is None:
        _HELMERT = None
        return
    keys = ("dx", "dy", "dz", "rx", "ry", "rz", "ds")
    if not all(k in params for k in keys):
        raise ValueError(f"Helmert 参数缺字段, 需要 {keys}")
    _HELMERT = {k: float(params[k]) for k in keys}


def get_helmert_params() -> dict | None:
    return dict(_HELMERT) if _HELMERT else None


def _llh_to_xyz(lng: float, lat: float, h: float = 0.0) -> tuple[float, float, float]:
    lng_r, lat_r = math.radians(lng), math.radians(lat)
    sf, cf = math.sin(lat_r), math.cos(lat_r)
    N = _A / math.sqrt(1 - _E2 * sf * sf)
    x = (N + h) * cf * math.cos(lng_r)
    y = (N + h) * cf * math.sin(lng_r)
    z = (N * (1 - _E2) + h) * sf
    return x, y, z


def _xyz_to_llh(x: float, y: float, z: float) -> tuple[float, float, float]:
    lng = math.atan2(y, x)
    p = math.sqrt(x * x + y * y)
    lat = math.atan2(z, p * (1 - _E2))
    for _ in range(8):
        sf = math.sin(lat)
        N = _A / math.sqrt(1 - _E2 * sf * sf)
        h = p / math.cos(lat) - N
        lat_new = math.atan2(z, p * (1 - _E2 * N / (N + h)))
        if abs(lat_new - lat) < 1e-12:
            lat = lat_new
            break
        lat = lat_new
    sf = math.sin(lat)
    N = _A / math.sqrt(1 - _E2 * sf * sf)
    h = p / math.cos(lat) - N
    return math.degrees(lng), math.degrees(lat), h


def _helmert_apply(x: float, y: float, z: float, inverse: bool = False) -> tuple[float, float, float]:
    """对地心直角坐标做 7 参 Bursa-Wolf 变换。inverse=True 时反向。"""
    if not _HELMERT:
        return x, y, z
    p = _HELMERT
    sec_to_rad = math.pi / 648000.0
    rx = p["rx"] * sec_to_rad
    ry = p["ry"] * sec_to_rad
    rz = p["rz"] * sec_to_rad
    ds = p["ds"] * 1e-6
    sign = -1.0 if inverse else 1.0
    s = 1 + sign * ds
    x2 = sign * p["dx"] + s * (x + sign * (-rz * y + ry * z))
    y2 = sign * p["dy"] + s * (sign * rz * x + y + sign * (-rx * z))
    z2 = sign * p["dz"] + s * (sign * (-ry * x) + sign * rx * y + z)
    return x2, y2, z2


def wgs84_to_cgcs2000(lng: float, lat: float) -> tuple[float, float]:
    """WGS84 经纬度 → CGCS2000 经纬度。无 Helmert 时退化为 identity。"""
    if not _HELMERT:
        return round(lng, 9), round(lat, 9)
    x, y, z = _llh_to_xyz(lng, lat, 0.0)
    x2, y2, z2 = _helmert_apply(x, y, z, inverse=True)
    lng2, lat2, _ = _xyz_to_llh(x2, y2, z2)
    return round(lng2, 9), round(lat2, 9)


def cgcs2000_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    if not _HELMERT:
        return round(lng, 9), round(lat, 9)
    x, y, z = _llh_to_xyz(lng, lat, 0.0)
    x2, y2, z2 = _helmert_apply(x, y, z, inverse=False)
    lng2, lat2, _ = _xyz_to_llh(x2, y2, z2)
    return round(lng2, 9), round(lat2, 9)


# ── Web Mercator ──────────────────────────────────────────────
_WM_R = 6378137.0  # 球形墨卡托半径
_WM_LIMIT = 85.05112878


def wgs84_to_web_mercator(lng: float, lat: float) -> tuple[float, float]:
    lat_c = max(min(lat, _WM_LIMIT), -_WM_LIMIT)
    x = math.radians(lng) * _WM_R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat_c) / 2)) * _WM_R
    return round(x, 4), round(y, 4)


def web_mercator_to_wgs84(x: float, y: float) -> tuple[float, float]:
    lng = math.degrees(x / _WM_R)
    lat = math.degrees(2 * math.atan(math.exp(y / _WM_R)) - math.pi / 2)
    return round(lng, 9), round(lat, 9)


# ── BD-09 ↔ WGS84 (经 GCJ-02 中转) ────────────────────────────
_BD_X_PI = math.pi * 3000.0 / 180.0


def gcj02_to_bd09(lng: float, lat: float) -> tuple[float, float]:
    z = math.sqrt(lng * lng + lat * lat) + 0.00002 * math.sin(lat * _BD_X_PI)
    theta = math.atan2(lat, lng) + 0.000003 * math.cos(lng * _BD_X_PI)
    return (
        round(z * math.cos(theta) + 0.0065, 8),
        round(z * math.sin(theta) + 0.006, 8),
    )


def bd09_to_gcj02(lng: float, lat: float) -> tuple[float, float]:
    x = lng - 0.0065
    y = lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _BD_X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _BD_X_PI)
    return round(z * math.cos(theta), 8), round(z * math.sin(theta), 8)


def wgs84_to_bd09(lng: float, lat: float) -> tuple[float, float]:
    return gcj02_to_bd09(*wgs84_to_gcj02(lng, lat))


def bd09_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    return gcj02_to_wgs84(*bd09_to_gcj02(lng, lat))


# ── 统一入口: transform_point ─────────────────────────────────
def transform_point(
    src_crs: str,
    dst_crs: str,
    a: float,
    b: float,
    *,
    central_meridian: float | None = None,
    zone_width: int = 3,
    zone_prefix: bool = True,
) -> tuple[float, float]:
    """统一坐标点转换。
    a, b 解释取决于 src_crs:
        geographic CRS  → (lng, lat)
        projected  CRS  → (x, y)
    返回值同理由 dst_crs 决定。

    central_meridian 仅当源或目标是 GK 时使用; None 时按几何经度自动选带。
    """
    if src_crs == dst_crs:
        return a, b
    if src_crs not in SUPPORTED_CRS:
        raise ValueError(f"unsupported src_crs: {src_crs}")
    if dst_crs not in SUPPORTED_CRS:
        raise ValueError(f"unsupported dst_crs: {dst_crs}")

    # 第一步: 任何 CRS → WGS84 lng/lat
    lng, lat = _to_wgs84(src_crs, a, b, central_meridian, zone_width, zone_prefix)
    # 第二步: WGS84 lng/lat → 目标 CRS
    return _from_wgs84(dst_crs, lng, lat, central_meridian, zone_width, zone_prefix)


def _to_wgs84(crs, a, b, cm, zw, zp):
    if crs == "wgs84":
        return a, b
    if crs == "cgcs2000":
        return cgcs2000_to_wgs84(a, b)
    if crs == "gcj02":
        return gcj02_to_wgs84(a, b)
    if crs == "bd09":
        return bd09_to_wgs84(a, b)
    if crs == "web_mercator":
        return web_mercator_to_wgs84(a, b)
    if crs in ("cgcs2000_gk_3", "cgcs2000_gk_6"):
        zone_width = 3 if crs.endswith("3") else 6
        if cm is None:
            # 无中央经线信息时, 按 x 前缀里的带号反推
            if zp and a > 1_000_000:
                zone = int(a / 1_000_000)
                cm = gk_central_meridian(zone, zone_width)
            else:
                raise ValueError(f"{crs} 反算需指定 central_meridian 或带号前缀 x")
        # CGCS2000 GK 反算 → CGCS2000 lng/lat → WGS84 lng/lat
        lng, lat = gk_inverse(a, b, cm, zone_prefix=zp, zone_width=zone_width)
        return cgcs2000_to_wgs84(lng, lat)
    raise ValueError(f"_to_wgs84: 未实现的 CRS {crs}")


def _from_wgs84(crs, lng, lat, cm, zw, zp):
    if crs == "wgs84":
        return lng, lat
    if crs == "cgcs2000":
        return wgs84_to_cgcs2000(lng, lat)
    if crs == "gcj02":
        return wgs84_to_gcj02(lng, lat)
    if crs == "bd09":
        return wgs84_to_bd09(lng, lat)
    if crs == "web_mercator":
        return wgs84_to_web_mercator(lng, lat)
    if crs in ("cgcs2000_gk_3", "cgcs2000_gk_6"):
        zone_width = 3 if crs.endswith("3") else 6
        # WGS84 lng/lat → CGCS2000 lng/lat → GK
        c_lng, c_lat = wgs84_to_cgcs2000(lng, lat)
        if cm is None:
            zone = gk_zone_for_lng(c_lng, zone_width=zone_width)
            cm = gk_central_meridian(zone, zone_width)
        return gk_forward(c_lng, c_lat, cm, zone_prefix=zp, zone_width=zone_width)
    raise ValueError(f"_from_wgs84: 未实现的 CRS {crs}")


# ── GeoJSON 整体转换 ──────────────────────────────────────────
def transform_geojson(
    geojson: dict,
    src_crs: str,
    dst_crs: str,
    *,
    central_meridian: float | None = None,
    zone_width: int = 3,
    zone_prefix: bool = True,
) -> dict:
    """递归遍历 GeoJSON, 把所有坐标做 src_crs → dst_crs 转换。
    在顶层 properties 里写入 _crs 字段记录目标 CRS。"""
    if src_crs == dst_crs:
        return geojson

    def _pt(p):
        if not p or len(p) < 2:
            return p
        x, y = transform_point(
            src_crs, dst_crs, float(p[0]), float(p[1]),
            central_meridian=central_meridian,
            zone_width=zone_width, zone_prefix=zone_prefix,
        )
        if len(p) > 2:
            return [x, y, *p[2:]]
        return [x, y]

    def _ring(r):
        return [_pt(p) for p in r]

    def _geom(g):
        if not g:
            return g
        t = g.get("type")
        c = g.get("coordinates")
        if c is None:
            return g
        if t == "Point":
            new_c = _pt(c)
        elif t in ("MultiPoint", "LineString"):
            new_c = [_pt(p) for p in c]
        elif t in ("MultiLineString", "Polygon"):
            new_c = [_ring(r) for r in c]
        elif t == "MultiPolygon":
            new_c = [[_ring(r) for r in poly] for poly in c]
        elif t == "GeometryCollection":
            return {"type": t, "geometries": [_geom(x) for x in g.get("geometries") or []]}
        else:
            return g
        return {**g, "coordinates": new_c}

    t = geojson.get("type")
    if t == "FeatureCollection":
        out = dict(geojson)
        out["features"] = [
            {**f, "geometry": _geom(f.get("geometry") or {})}
            for f in geojson.get("features") or []
        ]
        out["crs"] = {"type": "name", "properties": {"name": dst_crs}}
        return out
    if t == "Feature":
        return {**geojson, "geometry": _geom(geojson.get("geometry") or {})}
    return _geom(geojson)
