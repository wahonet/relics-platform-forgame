"""对比图斑(用地范围线 SHP)导入与文物范围冲突分析 API。

场景:自然资源部门提供用地/耕地/永农等 SHP(多为 CGCS2000,高斯-克吕格投影
或经纬度),导入后在地图上叠加显示,并一键查询是否压占文物两线范围
(保护范围/建控地带/本体)或覆盖文物本体点位。

- POST   /api/parcels/import               上传 SHP(.shp+.dbf+.shx+.prj / zip),转 WGS84 存盘
- GET    /api/parcels/layers                已导入图层列表
- GET    /api/parcels/layers/{id}/geojson   图层 GeoJSON(地图渲染用)
- GET    /api/parcels/layers/{id}/analysis  上次分析结果(无则 404)
- POST   /api/parcels/layers/{id}/analyze   一键冲突分析(结果同时存盘)
- DELETE /api/parcels/layers/{id}           删除图层

坐标系策略(与平台一致,CGCS2000 ≈ WGS84 identity):
- .prj 含 Gauss_Kruger → 读中央经线做 GK 反算;x>1e6 视为带号前缀自动剥离
- .prj 为地理坐标(度) → 按 CGCS2000 经纬度直用
- 无 .prj → 按坐标量级猜测:|x|≤180 为经纬度,否则 GK(带号前缀优先,
  否则用 config geo.center 就近 3° 带的中央经线)
"""
from __future__ import annotations

import io
import json
import math
import re
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from _common import get_paths, load_config  # noqa: E402
from crs import gk_inverse  # noqa: E402

from data_loader import store  # noqa: E402
from relic_scope import SCOPE_PROTECTED, normalize_relic_scope  # noqa: E402

router = APIRouter(prefix="/parcels", tags=["图斑对比"])

_PARCEL_DIR: Path = get_paths().output_dataset.parent / "parcels"
_INDEX_FILE: Path = _PARCEL_DIR / "layers.json"
_LOCK = threading.Lock()

_MAX_UPLOAD_BYTES = 200 * 1024 * 1024
_MAX_CONFLICTS = 800


# ── 图层索引(layers.json) ─────────────────────────────────────
def _load_index() -> list[dict]:
    try:
        if _INDEX_FILE.exists():
            data = json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _save_index(items: list[dict]) -> None:
    _PARCEL_DIR.mkdir(parents=True, exist_ok=True)
    _INDEX_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def _layer_meta(layer_id: str) -> dict | None:
    for it in _load_index():
        if it.get("id") == layer_id:
            return it
    return None


# ── PRJ / 坐标转换 ────────────────────────────────────────────
def _default_central_meridian() -> float:
    """config geo.center 经度就近取 3° 带中央经线;取不到用 117°(山东)。"""
    try:
        lng = float((((load_config().get("geo") or {}).get("center") or {}).get("lng")))
        return round(lng / 3) * 3
    except Exception:  # noqa: BLE001
        return 117.0


def _parse_prj(text: str) -> dict:
    """极简 WKT 解析,只区分 GK 投影 / 地理坐标。"""
    name_m = re.search(r'(?:PROJCS|GEOGCS)\["([^"]+)"', text)
    name = name_m.group(1) if name_m else ""
    if "PROJCS" in text:
        cm_m = re.search(r'PARAMETER\["Central_Meridian",\s*([-\d.]+)\]', text, re.I)
        return {
            "kind": "gk",
            "name": name or "投影坐标",
            "central_meridian": float(cm_m.group(1)) if cm_m else None,
        }
    if "GEOGCS" in text:
        return {"kind": "geographic", "name": name or "地理坐标", "central_meridian": None}
    return {"kind": "unknown", "name": name, "central_meridian": None}


def _guess_crs_from_sample(x: float, y: float) -> str:
    return "geographic" if abs(x) <= 180 and abs(y) <= 90 else "gk"


def _make_transformer(kind: str, central_meridian: float):
    """返回 (x, y) → (lng, lat) 的函数。"""
    if kind == "geographic":
        return lambda x, y: (x, y)

    def _tf(x: float, y: float) -> tuple[float, float]:
        # 带号前缀坐标(如 39xxxxxx)按前缀所在带反算,忽略传入 cm
        cm = int(x / 1_000_000) * 3 if x > 1_000_000 else central_meridian
        return gk_inverse(x, y, cm, zone_prefix=True)

    return _tf


# ── SHP 解析 ──────────────────────────────────────────────────
def _read_cpg(data: bytes | None) -> str | None:
    if not data:
        return None
    enc = data.decode("ascii", "ignore").strip().lower()
    if "utf" in enc:
        return "utf-8"
    if enc in ("gbk", "gb2312", "gb18030", "936", "cp936"):
        return "gbk"
    return None


def _json_safe(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace").strip()
    return str(v)


def _strip_z(coords):
    """递归把坐标缩到 (x, y) 二维。"""
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        return coords[:2]
    return [_strip_z(c) for c in coords]


def _transform_coords(coords, tf):
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        lng, lat = tf(coords[0], coords[1])
        return [lng, lat]
    return [_transform_coords(c, tf) for c in coords]


def _parcel_label(props: dict, idx: int) -> str:
    zl = str(props.get("ZLDWMC") or props.get("XZQMC") or "").strip()
    dl = str(props.get("DLMC") or "").strip()
    tb = str(props.get("TBBH") or props.get("YJJBNTTBBH") or "").strip()
    label = " · ".join(p for p in (zl, dl) if p)
    if tb:
        label = f"{label} (图斑{tb})" if label else f"图斑{tb}"
    return label or f"要素 #{idx + 1}"


def _parse_shapefile_group(name: str, group: dict[str, bytes]) -> tuple[dict, list[str]]:
    """把一组 {.shp/.dbf/.shx/.prj/.cpg: bytes} 解析为 WGS84 GeoJSON 图层。
    返回 (layer_dict, warnings)。layer_dict = {meta, geojson}。"""
    import shapefile  # pyshp,已在 requirements

    warnings: list[str] = []
    if ".shp" not in group:
        raise HTTPException(400, f"{name}: 缺少 .shp 文件")
    has_dbf = ".dbf" in group
    if not has_dbf:
        # 浏览器无法自动带上同文件夹的伴生文件,只拖 .shp 时降级为
        # 纯几何导入(图斑无属性名),不再报错拦截。
        warnings.append(f"{name}: 未附带 .dbf 属性表,已仅导入图形(建议连同 .dbf/.prj 一起选择)")

    # 坐标系
    crs_kind = "unknown"
    central_meridian: float | None = None
    crs_desc = ""
    if ".prj" in group:
        prj = _parse_prj(group[".prj"].decode("utf-8", "ignore"))
        crs_kind = prj["kind"]
        central_meridian = prj["central_meridian"]
        crs_desc = prj["name"]

    # DBF 编码:.cpg 优先,再 utf-8 → gbk,最后 utf-8+replace 兜底。
    # DBF 记录是迭代中惰性解码的,编码错误可能出现在任意一条,
    # 所以整个解析过程按候选编码整体重试。
    enc_candidates: list[tuple[str, str]] = []
    cpg_enc = _read_cpg(group.get(".cpg"))
    if cpg_enc:
        enc_candidates.append((cpg_enc, "strict"))
    for e in ("utf-8", "gbk"):
        if all(c[0] != e for c in enc_candidates):
            enc_candidates.append((e, "strict"))
    enc_candidates.append(("utf-8", "replace"))

    def _parse_with(enc: str, errors: str):
        local_warns: list[str] = []
        with shapefile.Reader(
            shp=io.BytesIO(group[".shp"]),
            dbf=io.BytesIO(group[".dbf"]) if has_dbf else None,
            shx=io.BytesIO(group[".shx"]) if ".shx" in group else None,
            encoding=enc,
            encodingErrors=errors,
        ) as reader:
            kind = crs_kind
            cm = central_meridian
            # 无 .prj 时按坐标量级猜测
            if kind == "unknown":
                try:
                    bx = reader.bbox
                    kind = _guess_crs_from_sample(bx[0], bx[1])
                    local_warns.append(
                        f"{name}: 缺少 .prj,按坐标量级判定为"
                        f"{'经纬度' if kind == 'geographic' else '高斯投影'}"
                    )
                except Exception:  # noqa: BLE001
                    raise HTTPException(400, f"{name}: 无法读取 bbox 判定坐标系") from None

            if kind == "gk" and cm is None:
                # 带号前缀坐标可逐点自推;非前缀坐标用配置默认带
                try:
                    sample_x = float(reader.bbox[0])
                except Exception:  # noqa: BLE001
                    sample_x = 0.0
                if sample_x <= 1_000_000:
                    cm = _default_central_meridian()
                    local_warns.append(f"{name}: .prj 未含中央经线,按默认 {cm:g}° 反算")

            tf = _make_transformer(kind, cm or 117.0)
            desc = crs_desc or (
                "CGCS2000 经纬度" if kind == "geographic" else "高斯-克吕格投影"
            )
            if kind == "gk" and cm:
                desc += f" (CM {cm:g}°)"

            def _iter_shape_props():
                if has_dbf:
                    for sr in reader.iterShapeRecords():
                        yield sr.shape, sr.record.as_dict()
                else:
                    for s in reader.iterShapes():
                        yield s, {}

            feats: list[dict] = []
            minx, miny, maxx, maxy = 180.0, 90.0, -180.0, -90.0
            skipped = 0
            for idx, (shp, rec) in enumerate(_iter_shape_props()):
                gi = shp.__geo_interface__
                gtype = gi.get("type")
                if gtype not in ("Polygon", "MultiPolygon"):
                    skipped += 1
                    continue
                coords = _transform_coords(_strip_z(gi.get("coordinates")), tf)
                props = {
                    k: _json_safe(v)
                    for k, v in rec.items()
                    if v not in (None, "", b"")
                }
                props["_idx"] = idx
                props["_label"] = _parcel_label(props, idx)
                feats.append({
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": gtype, "coordinates": coords},
                })
                # bbox 遍历全部环粗算即可(含洞无碍)
                rings = coords if gtype == "Polygon" else [r for poly in coords for r in poly]
                for ring in rings:
                    for pt in ring:
                        if pt[0] < minx: minx = pt[0]
                        if pt[0] > maxx: maxx = pt[0]
                        if pt[1] < miny: miny = pt[1]
                        if pt[1] > maxy: maxy = pt[1]
            if skipped:
                local_warns.append(f"{name}: 跳过 {skipped} 个非面要素")
            return feats, (minx, miny, maxx, maxy), desc, local_warns

    features: list[dict] = []
    bbox = (180.0, 90.0, -180.0, -90.0)
    last_err: Exception | None = None
    for enc, errors in enc_candidates:
        try:
            features, bbox, crs_desc, parse_warns = _parse_with(enc, errors)
            warnings.extend(parse_warns)
            if errors == "replace":
                warnings.append(f"{name}: 属性表编码异常,部分字符已替换为 �")
            break
        except UnicodeDecodeError as e:
            last_err = e
            continue
    else:
        raise HTTPException(400, f"{name}: DBF 编码识别失败 ({last_err})")
    minx, miny, maxx, maxy = bbox

    layer = {
        "meta": {
            "id": uuid.uuid4().hex[:8],
            "name": name,
            "feature_count": len(features),
            "bbox": [round(minx, 6), round(miny, 6), round(maxx, 6), round(maxy, 6)],
            "source_crs": crs_desc,
            "created_at": int(time.time()),
        },
        "geojson": {"type": "FeatureCollection", "features": features},
    }
    return layer, warnings


def _expand_uploads(payload: list[tuple[str, bytes]]) -> dict[str, dict[str, bytes]]:
    """上传文件(含 zip 展开)按 shapefile 基名分组 → {stem: {ext: bytes}}。"""
    exts = (".shp", ".dbf", ".shx", ".prj", ".cpg")
    flat: list[tuple[str, bytes]] = []
    for fname, data in payload:
        if fname.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    for zi in zf.infolist():
                        if zi.is_dir():
                            continue
                        base = Path(zi.filename).name
                        if base.lower().endswith(exts):
                            flat.append((base, zf.read(zi)))
            except zipfile.BadZipFile:
                raise HTTPException(400, f"{fname}: 不是有效的 zip 文件") from None
        else:
            flat.append((Path(fname).name, data))

    groups: dict[str, dict[str, bytes]] = {}
    for fname, data in flat:
        p = Path(fname)
        ext = p.suffix.lower()
        if ext not in exts:
            continue
        groups.setdefault(p.stem, {})[ext] = data
    return groups


def _import_sync(payload: list[tuple[str, bytes]]) -> dict:
    groups = _expand_uploads(payload)
    if not groups:
        raise HTTPException(400, "未找到 .shp 文件(支持 .shp/.dbf/.shx/.prj/.cpg 或打包 zip)")

    created: list[dict] = []
    warnings: list[str] = []
    for stem, group in groups.items():
        layer, warns = _parse_shapefile_group(stem, group)
        warnings.extend(warns)
        meta = layer["meta"]
        _PARCEL_DIR.mkdir(parents=True, exist_ok=True)
        (_PARCEL_DIR / f"{meta['id']}.geojson").write_text(
            json.dumps(layer["geojson"], ensure_ascii=False), encoding="utf-8"
        )
        created.append(meta)

    with _LOCK:
        idx = _load_index()
        idx.extend(created)
        _save_index(idx)
    return {"layers": created, "warnings": warnings}


# ── 冲突分析 ──────────────────────────────────────────────────
_KIND_ORDER = {"body": 0, "protection": 1, "control": 2, "point": 3}


def _scope_or_422(value: str | None) -> str:
    try:
        return normalize_relic_scope(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _analysis_path(layer_id: str, scope: str) -> Path:
    return _PARCEL_DIR / f"{layer_id}.{scope}.analysis.json"


def _m2_per_deg2(lat: float) -> float:
    return 111_132.954 * 111_319.490 * math.cos(math.radians(lat))


def _analyze_sync(layer_id: str, scope: str = SCOPE_PROTECTED) -> dict:
    from shapely.geometry import Point, shape as shp_shape
    from shapely.strtree import STRtree
    from shapely.validation import make_valid

    meta = _layer_meta(layer_id)
    gj_file = _PARCEL_DIR / f"{layer_id}.geojson"
    if not meta or not gj_file.exists():
        raise HTTPException(404, "图层不存在")
    gj = json.loads(gj_file.read_text(encoding="utf-8"))
    feats = gj.get("features") or []
    scoped_relics = store.scoped_relics(scope)
    scoped_codes = {str(r.get("archive_code") or "") for r in scoped_relics}

    def _valid(geom):
        try:
            g = shp_shape(geom)
            return g if g.is_valid else make_valid(g)
        except Exception:  # noqa: BLE001
            return None

    parcel_geoms: list = []
    # (feature_index, label):feature_index 用要素的 _idx 属性,
    # 与前端 ParcelLayer 的高亮索引对齐(跳过非面要素时数组下标会错位)。
    parcel_meta: list[tuple[int, str]] = []
    for i, f in enumerate(feats):
        g = _valid(f.get("geometry"))
        if g is None or g.is_empty:
            continue
        props = f.get("properties") or {}
        if str(props.get("archive_code") or "") not in scoped_codes:
            continue
        fidx = int(props.get("_idx", i))
        label = str(props.get("_label") or f"要素 #{fidx + 1}")
        parcel_geoms.append(g)
        parcel_meta.append((fidx, label))

    # 文物两线/本体面(启动时已随 store 加载,WGS84)
    relic_polys: list[dict] = []
    for f in (store.geojson_polygons or {}).get("features") or []:
        props = f.get("properties") or {}
        kind = props.get("kind") or ""
        if kind not in ("protection", "control", "body"):
            continue
        g = _valid(f.get("geometry"))
        if g is None or g.is_empty:
            continue
        relic_polys.append({
            "code": props.get("archive_code") or "",
            "name": props.get("name") or "",
            "kind": kind,
            "geom": g,
        })

    conflicts: list[dict] = []
    hit_features: set[int] = set()
    hit_relics: set[str] = set()
    summary = {"body": 0, "protection": 0, "control": 0, "point": 0}

    # 1) 图斑 × 两线范围面 相交
    if relic_polys and parcel_geoms:
        tree = STRtree([rp["geom"] for rp in relic_polys])
        for gi_local, pg in enumerate(parcel_geoms):
            fidx, label = parcel_meta[gi_local]
            for j in tree.query(pg, predicate="intersects"):
                rp = relic_polys[int(j)]
                try:
                    inter = pg.intersection(rp["geom"])
                except Exception:  # noqa: BLE001
                    continue
                if inter.is_empty:
                    continue
                rep = inter.representative_point()
                area_m2 = inter.area * _m2_per_deg2(rep.y)
                # 相邻图斑共边只产生线状交集(面积≈0),不算压占
                if area_m2 < 0.05:
                    continue
                conflicts.append({
                    "feature_index": fidx,
                    "parcel_name": label,
                    "relic_code": rp["code"],
                    "relic_name": rp["name"],
                    "kind": rp["kind"],
                    "overlap_m2": round(area_m2, 1),
                    "center": [round(rep.x, 8), round(rep.y, 8)],
                })
                hit_features.add(fidx)
                hit_relics.add(rp["code"])
                summary[rp["kind"]] += 1

    # 2) 文物本体点位 落在图斑内(无本体面数据时的兜底核查)
    if parcel_geoms:
        ptree = STRtree(parcel_geoms)
        for r in scoped_relics:
            lng, lat = r.get("center_lng"), r.get("center_lat")
            if lng is None or lat is None:
                continue
            pt = Point(float(lng), float(lat))
            for j in ptree.query(pt, predicate="within"):
                fidx, label = parcel_meta[int(j)]
                conflicts.append({
                    "feature_index": fidx,
                    "parcel_name": label,
                    "relic_code": r.get("archive_code") or "",
                    "relic_name": r.get("name") or "",
                    "kind": "point",
                    "overlap_m2": 0,
                    "center": [float(lng), float(lat)],
                })
                hit_features.add(fidx)
                hit_relics.add(r.get("archive_code") or "")
                summary["point"] += 1

    conflicts.sort(key=lambda c: (_KIND_ORDER.get(c["kind"], 9), -c["overlap_m2"]))
    truncated = len(conflicts) > _MAX_CONFLICTS
    if truncated:
        conflicts = conflicts[:_MAX_CONFLICTS]

    result = {
        "scope": scope,
        "layer_id": layer_id,
        "layer_name": meta.get("name") or "",
        "analyzed_at": int(time.time()),
        "checked_features": len(parcel_geoms),
        "relic_polygons": len(relic_polys),
        "conflicts": conflicts,
        "truncated": truncated,
        "summary": {
            **summary,
            "total": sum(summary.values()),
            "features_hit": len(hit_features),
            "relics_hit": len(hit_relics),
        },
    }
    _analysis_path(layer_id, scope).write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )
    return result


# ── 路由 ──────────────────────────────────────────────────────
@router.post("/import")
async def import_parcels(files: list[UploadFile] = File(...)):
    payload: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > _MAX_UPLOAD_BYTES:
            raise HTTPException(413, "上传总大小超过 200MB 限制")
        payload.append((f.filename or "unnamed", data))
    return await run_in_threadpool(_import_sync, payload)


@router.get("/layers")
async def list_layers():
    items = [it for it in _load_index() if (_PARCEL_DIR / f"{it.get('id')}.geojson").exists()]
    return {"layers": items}


@router.get("/layers/{layer_id}/geojson")
async def layer_geojson(layer_id: str):
    p = _PARCEL_DIR / f"{layer_id}.geojson"
    if not re.fullmatch(r"[0-9a-f]{8}", layer_id) or not p.exists():
        raise HTTPException(404, "图层不存在")
    return Response(content=p.read_bytes(), media_type="application/geo+json")


@router.get("/layers/{layer_id}/analysis")
async def layer_analysis(
    layer_id: str,
    scope: str = Query(SCOPE_PROTECTED, description="protected=文保单位 all=全部文物"),
):
    canonical_scope = _scope_or_422(scope)
    p = _analysis_path(layer_id, canonical_scope)
    if not re.fullmatch(r"[0-9a-f]{8}", layer_id) or not p.exists():
        raise HTTPException(404, "尚未分析")
    return Response(content=p.read_bytes(), media_type="application/json")


@router.post("/layers/{layer_id}/analyze")
async def analyze_layer(
    layer_id: str,
    scope: str = Query(SCOPE_PROTECTED, description="protected=文保单位 all=全部文物"),
):
    if not re.fullmatch(r"[0-9a-f]{8}", layer_id):
        raise HTTPException(404, "图层不存在")
    return await run_in_threadpool(_analyze_sync, layer_id, _scope_or_422(scope))


@router.delete("/layers/{layer_id}")
async def delete_layer(layer_id: str):
    if not re.fullmatch(r"[0-9a-f]{8}", layer_id):
        raise HTTPException(404, "图层不存在")
    with _LOCK:
        idx = _load_index()
        kept = [it for it in idx if it.get("id") != layer_id]
        if len(kept) == len(idx):
            raise HTTPException(404, "图层不存在")
        _save_index(kept)
    for suffix in (".geojson", ".analysis.json", ".protected.analysis.json", ".all.analysis.json"):
        try:
            (_PARCEL_DIR / f"{layer_id}{suffix}").unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}
