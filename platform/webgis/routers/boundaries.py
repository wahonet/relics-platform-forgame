"""行政边界在线下载 API。

数据源:
  • 县/区级及以上 — 阿里云 DataV.GeoAtlas (高德 2021.5,免费,GCJ-02)
        https://geo.datav.aliyun.com/areas_v3/bound/{adcode}.json
        https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json

  • 镇/街道 (admin_level=8) — OpenStreetMap Overpass API
        https://overpass-api.de/api/interpreter
    DataV 对绝大多数县区的乡镇都返回 404,因此本平台默认用 OSM 拉取镇街。
    OSM 数据本身就是 WGS-84,无需坐标转换;但覆盖率不完整,部分县只能拿到
    一部分镇街,缺的需走 step06 离线 SHP 流程补齐。

DataV 返回的坐标是 GCJ-02,本模块统一反算到 WGS-84,与 step02 文物点位一致。
村界 (五级) DataV / OSM 都不公开,本模块不支持自动下载,UI 上提示用户走
step06 离线流程。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from _common import gcj02_to_wgs84, get_paths  # noqa: E402
from crs import SUPPORTED_CRS, transform_geojson  # noqa: E402

router = APIRouter()

_PATHS = get_paths()
_OUT_DIR: Path = _PATHS.output_boundaries

DATAV_BASE = "https://geo.datav.aliyun.com/areas_v3/bound"

# Overpass 镜像。按顺序尝试,前一个失败/限流就切下一个。
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

_UA = "Mozilla/5.0 RelicsPlatform/1.0 boundaries-fetcher"
_TIMEOUT = 30.0
_OVERPASS_TIMEOUT = 120.0


# ── DataV HTTP ────────────────────────────────────────────────
def _http_get(url: str) -> bytes:
    """同步 GET。urllib 默认遵守 HTTP_PROXY / HTTPS_PROXY 环境变量。
    超时 / 404 / 5xx 全部转成 HTTPException 抛给上层。"""
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"上游 DataV 返回 HTTP {e.code}: {url}",
        ) from e
    except urllib.error.URLError as e:
        raise HTTPException(
            status_code=502,
            detail=f"无法连接 DataV: {e.reason} (URL={url})",
        ) from e


def _fetch_datav(adcode: int, full: bool = False) -> dict:
    suffix = "_full.json" if full else ".json"
    url = f"{DATAV_BASE}/{adcode}{suffix}"
    raw = _http_get(url)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=502, detail=f"DataV 响应不是合法 JSON: {e}") from e


# ── 坐标系转换 (GCJ-02 → WGS-84) ───────────────────────────────
def _convert_ring_gcj_to_wgs(ring: list) -> list:
    out = []
    for pt in ring:
        if not pt or len(pt) < 2:
            continue
        lng, lat = gcj02_to_wgs84(float(pt[0]), float(pt[1]))
        out.append([lng, lat])
    return out


def _convert_geometry_gcj_to_wgs(geom: dict) -> dict:
    """支持 Polygon / MultiPolygon。其它类型原样返回。"""
    t = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return geom
    if t == "Polygon":
        new_coords = [_convert_ring_gcj_to_wgs(ring) for ring in coords]
    elif t == "MultiPolygon":
        new_coords = [
            [_convert_ring_gcj_to_wgs(ring) for ring in poly]
            for poly in coords
        ]
    else:
        return geom
    return {"type": t, "coordinates": new_coords}


def _flatten_to_polygons(features: list[dict]) -> list[dict]:
    """把 MultiPolygon 拆成多个 Polygon Feature,保持与 step06 输出一致 (BoundaryLayer
    目前只渲染 Polygon.coordinates -> ring)。"""
    out: list[dict] = []
    for feat in features:
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        # 让前端 BoundaryLayer 能用相同的字段名读到名称
        name = props.get("name") or props.get("XZQMC") or ""
        props.setdefault("XZQMC", name)
        props.setdefault("_township_name", name)
        props.setdefault("ZLDWMC", name)

        if geom.get("type") == "Polygon":
            out.append({
                "type": "Feature",
                "properties": props,
                "geometry": geom,
            })
        elif geom.get("type") == "MultiPolygon":
            for poly_rings in geom.get("coordinates") or []:
                out.append({
                    "type": "Feature",
                    "properties": dict(props),
                    "geometry": {"type": "Polygon", "coordinates": poly_rings},
                })
        else:
            out.append(feat)
    return out


def _save_geojson(filename: str, features: list[dict]) -> Path:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = _OUT_DIR / filename
    payload = {"type": "FeatureCollection", "features": features}
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return out


# ── OSM Overpass ──────────────────────────────────────────────
def _overpass_query(q: str) -> dict:
    """轮询 Overpass 镜像,任一成功即返回。全部失败抛 HTTPException。"""
    payload = urllib.parse.urlencode({"data": q}).encode("utf-8")
    last_err: Optional[str] = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(
                url, data=payload,
                headers={
                    "User-Agent": _UA,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            with urllib.request.urlopen(req, timeout=_OVERPASS_TIMEOUT) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 429 / 503 多半是限流,换镜像继续
            last_err = f"HTTP {e.code} from {url}"
            continue
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = f"{type(e).__name__}: {e} from {url}"
            continue
    raise HTTPException(status_code=502, detail=f"Overpass 全部镜像失败: {last_err}")


def _stitch_ways(way_geoms: list[list[list[float]]]) -> list[list[list[float]]]:
    """把若干 way 段拼成闭合 ring。OSM 边界 relation 的 outer/inner 通常被打散
    成多段 way,需要按起止点接龙(且 way 方向可能反向)。无法闭合的段直接丢弃。"""
    if not way_geoms:
        return []
    EPS = 1e-7

    def _eq(a: list[float], b: list[float]) -> bool:
        return abs(a[0] - b[0]) < EPS and abs(a[1] - b[1]) < EPS

    remaining: list[list[list[float]]] = [list(g) for g in way_geoms if g and len(g) >= 2]
    rings: list[list[list[float]]] = []

    while remaining:
        cur = remaining.pop(0)
        # 自己已经是闭合环
        if _eq(cur[0], cur[-1]) and len(cur) >= 4:
            rings.append(cur)
            continue
        changed = True
        while changed and not _eq(cur[0], cur[-1]):
            changed = False
            for i, w in enumerate(remaining):
                if not w:
                    continue
                if _eq(cur[-1], w[0]):
                    cur.extend(w[1:]); remaining.pop(i); changed = True; break
                if _eq(cur[-1], w[-1]):
                    cur.extend(reversed(w[:-1])); remaining.pop(i); changed = True; break
                if _eq(cur[0], w[-1]):
                    cur = w + cur[1:]; remaining.pop(i); changed = True; break
                if _eq(cur[0], w[0]):
                    cur = list(reversed(w))[:-1] + cur; remaining.pop(i); changed = True; break
        if _eq(cur[0], cur[-1]) and len(cur) >= 4:
            rings.append(cur)
        # 否则丢弃残段(OSM 数据偶尔不闭合)
    return rings


def _osm_relation_to_features(rel: dict) -> list[dict]:
    """把一个 OSM admin_level=8 relation 转成 GeoJSON Polygon Features。
    每个 outer 闭合环导出为单独的 Polygon Feature(忽略 inner 的归属问题,
    BoundaryLayer 也只渲染 Polygon.coordinates[0])。"""
    tags = rel.get("tags") or {}
    name = tags.get("name") or tags.get("name:zh") or tags.get("name:zh-Hans") or ""

    outer_ways: list[list[list[float]]] = []
    for m in rel.get("members") or []:
        if m.get("type") != "way" or m.get("role") != "outer":
            continue
        g = m.get("geometry") or []
        coords = [[float(pt["lon"]), float(pt["lat"])] for pt in g if "lon" in pt and "lat" in pt]
        if len(coords) >= 2:
            outer_ways.append(coords)

    rings = _stitch_ways(outer_ways)
    if not rings:
        return []

    base_props = {
        "name": name,
        "XZQMC": name,
        "_township_name": name,
        "ZLDWMC": name,
        "osm_id": rel.get("id"),
        "admin_level": tags.get("admin_level"),
        "admin_type": tags.get("admin_type:CN") or tags.get("place") or "",
        "source": "osm",
    }
    feats = []
    for ring in rings:
        feats.append({
            "type": "Feature",
            "properties": dict(base_props),
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return feats


# ── 县轮廓 / 点在多边形内 ─────────────────────────────────────
def _county_outline_wgs84(adcode: int) -> tuple[list[list[list[float]]], tuple[float, float, float, float]]:
    """拉取单个县的边界 (DataV 单层 .json),转 WGS-84 后返回 (rings, bbox)。"""
    data = _fetch_datav(adcode, False)
    rings: list[list[list[float]]] = []
    minx, miny, maxx, maxy = 180.0, 90.0, -180.0, -90.0
    for f in data.get("features") or []:
        geom = _convert_geometry_gcj_to_wgs(f.get("geometry") or {})
        t = geom.get("type")
        polys = []
        if t == "Polygon":
            polys = [geom.get("coordinates") or []]
        elif t == "MultiPolygon":
            polys = geom.get("coordinates") or []
        for poly in polys:
            if not poly:
                continue
            ring = poly[0]  # outer ring
            if len(ring) < 3:
                continue
            rings.append(ring)
            for pt in ring:
                if pt[0] < minx: minx = pt[0]
                if pt[0] > maxx: maxx = pt[0]
                if pt[1] < miny: miny = pt[1]
                if pt[1] > maxy: maxy = pt[1]
    return rings, (minx, miny, maxx, maxy)


def _point_in_ring(pt: list[float], ring: list[list[float]]) -> bool:
    """射线法判点在多边形内。ring 必须是闭合环。"""
    x, y = pt[0], pt[1]
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / (yj - yi if yj != yi else 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _ring_centroid(ring: list[list[float]]) -> list[float]:
    if not ring:
        return [0.0, 0.0]
    xs = sum(p[0] for p in ring) / len(ring)
    ys = sum(p[1] for p in ring) / len(ring)
    return [xs, ys]


def _fetch_townships_osm(county_adcode: int) -> tuple[list[dict], list[str]]:
    """通过 OSM Overpass 拉取某县下属 admin_level=8 镇街,并按县轮廓做空间筛选。
    返回 (features, warnings)。"""
    warnings: list[str] = []

    # 1. 县轮廓 + bbox(用于 Overpass bbox 查询和后续空间筛选)
    try:
        county_rings, bbox = _county_outline_wgs84(county_adcode)
    except HTTPException as e:
        warnings.append(f"取县轮廓失败({e.detail}),OSM 镇街将不做空间筛选")
        county_rings = []
        bbox = None

    # 2. Overpass 查询。没县轮廓就只能放弃 — bbox 都拿不到的话 OSM 数据没法精确过滤。
    if bbox is None:
        warnings.append("无县轮廓 bbox,跳过 OSM 查询")
        return [], warnings

    minx, miny, maxx, maxy = bbox
    pad = 0.005
    q = (
        f'[out:json][timeout:90];'
        f'rel["admin_level"="8"]({miny - pad},{minx - pad},'
        f'{maxy + pad},{maxx + pad});'
        f'out geom;'
    )
    data = _overpass_query(q)

    # 3. relation → features
    raw_feats: list[dict] = []
    for el in data.get("elements") or []:
        if el.get("type") != "relation":
            continue
        raw_feats.extend(_osm_relation_to_features(el))

    if not raw_feats:
        warnings.append("OSM 没找到该县任何 admin_level=8 边界(覆盖空白)")
        return [], warnings

    # 4. 按县轮廓做空间筛选 — 镇的形心需落在县轮廓内才保留
    if county_rings:
        kept: list[dict] = []
        dropped = 0
        for f in raw_feats:
            ring = (f.get("geometry") or {}).get("coordinates", [[]])[0]
            c = _ring_centroid(ring)
            if any(_point_in_ring(c, cr) for cr in county_rings):
                kept.append(f)
            else:
                dropped += 1
        if dropped:
            warnings.append(f"剔除 {dropped} 个落在县外的相邻县乡镇")
        return kept, warnings

    # 没县轮廓做不了筛选,全量返回
    warnings.append("县轮廓缺失,OSM 镇街未做县级裁剪,可能含相邻县要素")
    return raw_feats, warnings


def _fetch_townships_datav(county_adcode: int) -> tuple[list[dict], list[str]]:
    """老的 DataV 镇街路径 — 留作 fallback,绝大多数县会 404。"""
    warnings: list[str] = []
    try:
        data = _fetch_datav(county_adcode, True)
    except HTTPException as e:
        if "404" in str(e.detail) or "502" in str(e.detail):
            warnings.append("DataV 不提供该县的乡镇边界数据 (404)")
        else:
            warnings.append(f"DataV 下载乡镇失败: {e.detail}")
        return [], warnings

    feats = []
    for f in data.get("features") or []:
        f["geometry"] = _convert_geometry_gcj_to_wgs(f.get("geometry") or {})
        f.setdefault("properties", {}).setdefault("source", "datav")
        feats.append(f)
    if not feats:
        warnings.append("DataV 返回了 0 个乡镇要素")
    return feats, warnings


# ── /api/boundaries/admin-tree ────────────────────────────────
@router.get("/boundaries/admin-tree")
async def admin_tree(adcode: int = Query(370000, ge=100000, le=999999)):
    """返回 adcode 下属一级行政区,用于前端级联下拉。

    示例:adcode=370000 (山东省) → 16 个市;adcode=370800 (济宁市) → 11 个区县。
    """
    data = await run_in_threadpool(_fetch_datav, adcode, True)
    items = []
    for f in data.get("features") or []:
        p = f.get("properties") or {}
        items.append({
            "adcode": p.get("adcode"),
            "name": p.get("name"),
            "level": p.get("level"),
            "center": p.get("center"),
            "children_num": p.get("childrenNum", 0),
        })
    return {"parent_adcode": adcode, "items": items}


# ── /api/boundaries/list ──────────────────────────────────────
@router.get("/boundaries/list")
async def list_boundaries():
    """返回当前 data/output/boundaries/ 下已有的边界文件信息。"""
    files = []
    for name in ("county.geojson", "townships.geojson", "villages.geojson"):
        p = _OUT_DIR / name
        if p.exists():
            try:
                gj = json.loads(p.read_text(encoding="utf-8"))
                feats = gj.get("features") or []
                files.append({
                    "name": name,
                    "feature_count": len(feats),
                    "size": p.stat().st_size,
                    "mtime": int(p.stat().st_mtime),
                })
            except Exception:
                files.append({"name": name, "feature_count": -1, "error": "parse_failed"})
        else:
            files.append({"name": name, "feature_count": 0, "missing": True})
    return {"dir": str(_OUT_DIR), "files": files}


# ── /api/boundaries/download ──────────────────────────────────
class BoundaryDownloadRequest(BaseModel):
    """county_adcode 为 6 位县区级编码 (如嘉祥县 370829)。

    include_county_outline:    下载 {county_adcode}.json 作为 county.geojson
                               (单个县轮廓)
    include_city_counties:     下载 {city_adcode}_full.json 作为 county.geojson
                               (整个地市的所有区县,与本平台一直叫的"县界"一致)
    include_townships:         按 township_source 拉取 townships.geojson
    township_source:
        - "auto": 默认。先用 OSM Overpass(覆盖更全),失败再退 DataV。
        - "osm":  仅用 OSM Overpass。
        - "datav": 仅用 DataV(基本都会 404,留作回归对比)。
    """
    city_adcode: Optional[int] = None
    county_adcode: Optional[int] = None
    include_county_outline: bool = False
    include_city_counties: bool = True
    include_townships: bool = True
    township_source: Literal["auto", "osm", "datav"] = "auto"


@router.post("/boundaries/download")
async def download_boundaries(req: BoundaryDownloadRequest):
    if not req.city_adcode and not req.county_adcode:
        raise HTTPException(status_code=400, detail="city_adcode 或 county_adcode 至少给一个")
    if req.include_townships and not req.county_adcode:
        raise HTTPException(status_code=400, detail="下载乡镇必须指定 county_adcode")
    if req.include_city_counties and not req.city_adcode:
        raise HTTPException(status_code=400, detail="下载下属区县必须指定 city_adcode")
    if req.include_county_outline and not req.county_adcode:
        raise HTTPException(status_code=400, detail="下载县轮廓必须指定 county_adcode")

    result: dict = {"ok": True, "files": [], "warnings": []}

    # 1. county.geojson 来源:县轮廓 OR 市下属所有区县(二选一,后者优先)
    county_features: list[dict] = []
    if req.include_city_counties:
        try:
            data = await run_in_threadpool(_fetch_datav, req.city_adcode, True)
            for f in data.get("features") or []:
                f["geometry"] = _convert_geometry_gcj_to_wgs(f.get("geometry") or {})
                county_features.append(f)
        except HTTPException as e:
            result["warnings"].append(f"下载市下属区县失败: {e.detail}")
    elif req.include_county_outline:
        try:
            data = await run_in_threadpool(_fetch_datav, req.county_adcode, False)
            for f in data.get("features") or []:
                f["geometry"] = _convert_geometry_gcj_to_wgs(f.get("geometry") or {})
                county_features.append(f)
        except HTTPException as e:
            result["warnings"].append(f"下载县轮廓失败: {e.detail}")

    if county_features:
        flat = _flatten_to_polygons(county_features)
        out = await run_in_threadpool(_save_geojson, "county.geojson", flat)
        result["files"].append({
            "name": "county.geojson",
            "path": str(out),
            "feature_count": len(flat),
        })

    # 2. townships.geojson — 按 source 选择来源
    if req.include_townships:
        src = req.township_source
        town_feats: list[dict] = []
        warns: list[str] = []

        async def _try_osm():
            return await run_in_threadpool(_fetch_townships_osm, req.county_adcode)

        async def _try_datav():
            return await run_in_threadpool(_fetch_townships_datav, req.county_adcode)

        try:
            if src == "datav":
                town_feats, warns = await _try_datav()
            elif src == "osm":
                town_feats, warns = await _try_osm()
            else:  # auto
                town_feats, warns = await _try_osm()
                if not town_feats:
                    warns.append("OSM 未取到数据,回退尝试 DataV")
                    fb_feats, fb_warns = await _try_datav()
                    town_feats = fb_feats
                    warns.extend(fb_warns)
        except HTTPException as e:
            warns.append(f"下载乡镇异常: {e.detail}")

        result["warnings"].extend(warns)
        if town_feats:
            flat = _flatten_to_polygons(town_feats)
            out = await run_in_threadpool(_save_geojson, "townships.geojson", flat)
            result["files"].append({
                "name": "townships.geojson",
                "path": str(out),
                "feature_count": len(flat),
                "source": (flat[0].get("properties") or {}).get("source", src),
            })
        else:
            result["warnings"].append(
                "未取到任何镇街要素;若 OSM 也没数据,只能走 step06 离线 SHP 流程"
            )

    if not result["files"]:
        result["ok"] = False
        result["warnings"].append("未生成任何边界文件,请检查 adcode 或网络/代理设置")

    return result


# ── /api/boundaries/export ────────────────────────────────────
@router.get("/boundaries/export")
async def export_boundary(
    file: str = Query(..., regex="^(county|townships|villages)$"),
    crs: str = Query("wgs84"),
    central_meridian: Optional[float] = None,
    zone_width: int = Query(3, ge=3, le=6),
    zone_prefix: bool = True,
):
    """以指定 CRS 导出已下载的某层边界 GeoJSON。
    后端存储一律是 WGS-84,这里按需做一次坐标转换返回,不改盘上文件。

    参数:
        file: county / townships / villages
        crs:  目标 CRS (见 /api/crs/list)
        central_meridian: GK 投影时的中央经线;不传按数据中心自动选带
    """
    if crs not in SUPPORTED_CRS:
        raise HTTPException(400, f"不支持的 CRS: {crs}")
    src = _OUT_DIR / f"{file}.geojson"
    if not src.exists():
        raise HTTPException(404, f"{file}.geojson 尚未生成")

    def _convert() -> bytes:
        gj = json.loads(src.read_text(encoding="utf-8"))
        out = transform_geojson(
            gj, "wgs84", crs,
            central_meridian=central_meridian,
            zone_width=zone_width,
            zone_prefix=zone_prefix,
        )
        return json.dumps(out, ensure_ascii=False).encode("utf-8")

    body = await run_in_threadpool(_convert)
    fname = f"{file}.{crs}.geojson"
    return Response(
        content=body,
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── /api/boundaries/clear ─────────────────────────────────────
@router.delete("/boundaries/clear")
async def clear_boundaries(targets: str = Query("county,townships")):
    """删除指定边界文件;village 文件保留(它通常需要本地 SHP)。"""
    names = {t.strip() for t in targets.split(",") if t.strip()}
    removed = []
    for name in names:
        path = _OUT_DIR / f"{name}.geojson"
        if path.exists():
            try:
                path.unlink()
                removed.append(name)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"删除 {name} 失败: {e}")
    return {"removed": removed}
