"""Step 06 | 行政边界 Shapefile → WGS-84 GeoJSON。

输入布局(显式命名 / 启发式二选一,亦可混用):

    显式:
        data/input/03_boundaries/
            county/*.shp              县界
            townships/*.shp           所有乡镇合入同 1 个 SHP
            townships/<name>/*.shp    子目录名即乡镇名
            villages/*.shp            村界

    启发式(data/input/03_boundaries/<any>/*.shp):
        1 要素 + 未投影       → county
        >100 要素 + 已投影    → villages
        子目录/1 SHP          → townships (子目录名即乡镇名)

坐标统一到 WGS-84:高斯-克吕格用 `config.geo.boundaries.central_meridian`
逆投影;若 `boundaries.is_gcj02=True`,再做一次 GCJ-02 → WGS-84 修正,
确保边界层与 step02 点位对齐(部分下发成果在 GCJ-02 上再做高斯投影)。

输出 `data/output/boundaries/{county,townships,villages}.geojson`;
村要素自动回填 `_township`(点在多边形)。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import shapefile

from _common import gcj02_to_wgs84, get_logger, get_paths, load_config
from crs import gk_inverse  # 高斯-克吕格逆投影,统一从 crs.py 复用

STEP_ID = "step02"


def gk_to_lonlat(x: float, y: float, central_meridian: float) -> tuple[float, float]:
    """高斯-克吕格 → 经纬度。`x > 1_000_000` 视为含带号,自动剥离。
    薄包装,核心算法在 crs.gk_inverse。"""
    return gk_inverse(x, y, central_meridian, zone_prefix=True, zone_width=3)


def _safe_reader(shp_path: Path):
    """打开 SHP;文件不存在/损坏/过小时返回 None,不抛异常。"""
    if not shp_path.exists() or shp_path.stat().st_size < 100:
        return None
    try:
        return shapefile.Reader(str(shp_path))
    except Exception:
        return None


def is_projected(shp_path: Path) -> bool:
    sf = _safe_reader(shp_path)
    if sf is None or len(sf) == 0:
        return False
    try:
        return abs(sf.shape(0).points[0][0]) > 1_000_000
    except Exception:
        return False


def make_transform(projection: str, central_meridian: float, is_gcj02: bool = False):
    """返回 (x, y) → (lon, lat) 转换函数,输出 WGS-84。

    is_gcj02=True 表示源数据是 GCJ-02 上的高斯投影,反投影后还需再做
    GCJ-02 → WGS-84 修正,否则会相对 step02 点位系统漂移 ~500 m。
    """
    p = (projection or "auto").lower()

    if p in ("none", "wgs84", "cgcs2000"):
        base = lambda x, y: (round(x, 7), round(y, 7))
    elif p in ("gcj02", "gcj-02"):
        return lambda x, y: gcj02_to_wgs84(x, y)
    else:
        base = lambda x, y: gk_to_lonlat(x, y, central_meridian)

    if is_gcj02:
        return lambda x, y: gcj02_to_wgs84(*base(x, y))
    return base


def shp_to_features(
    shp_path: Path,
    reproject: bool,
    transform,
    log,
) -> list[dict]:
    sf = _safe_reader(shp_path)
    if sf is None:
        log.warning(f"  跳过损坏或空文件: {shp_path.name}")
        return []
    fnames = [f[0] for f in sf.fields[1:]]
    features: list[dict] = []
    errors = 0
    for i in range(len(sf)):
        try:
            sr = sf.shapeRecord(i)
        except Exception:
            errors += 1
            continue
        shape = sr.shape
        rec = dict(zip(fnames, sr.record))
        if not shape.points:
            continue
        parts_idx = list(shape.parts) + [len(shape.points)]
        rings = []
        for j in range(len(parts_idx) - 1):
            pts = shape.points[parts_idx[j]:parts_idx[j + 1]]
            if reproject:
                pts = [list(transform(p[0], p[1])) for p in pts]
            else:
                pts = [[round(p[0], 7), round(p[1], 7)] for p in pts]
            rings.append(pts)
        props = {}
        for k, v in rec.items():
            if isinstance(v, (int, float, str, bool, type(None))):
                props[k] = v
            else:
                props[k] = str(v)
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Polygon", "coordinates": rings},
        })
    if errors:
        log.warning(f"  {shp_path.name}: 跳过 {errors} 条异常记录")
    return features


# ── 村 → 镇 空间关联 (bbox 中心 + 射线法点在面内) ─────────
def _centroid_bbox(feature: dict) -> tuple[float, float]:
    ring = feature["geometry"]["coordinates"][0]
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2


def _point_in_ring(px: float, py: float, ring: list[list[float]]) -> bool:
    n = len(ring)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-20) + xi):
            inside = not inside
        j = i
    return inside


def assign_townships(villages: list[dict], townships: list[dict], log) -> None:
    tw_data = []
    for tw in townships:
        name = (
            tw["properties"].get("_township_name")
            or tw["properties"].get("XZQMC")
            or tw["properties"].get("NAME")
            or tw["properties"].get("name")
            or ""
        )
        ring = tw["geometry"]["coordinates"][0]
        tw_data.append((name, ring))

    assigned, unassigned = 0, 0
    for v in villages:
        cx, cy = _centroid_bbox(v)
        matched = ""
        for tw_name, ring in tw_data:
            if _point_in_ring(cx, cy, ring):
                matched = tw_name
                break
        v["properties"]["_township"] = matched
        if matched:
            assigned += 1
        else:
            unassigned += 1
    log.info(f"  村 → 镇街关联: 匹配 {assigned}, 未匹配 {unassigned}")


def save_geojson(name: str, features: list[dict], out_dir: Path, log) -> None:
    geojson = {"type": "FeatureCollection", "features": features}
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.geojson"
    path.write_text(
        json.dumps(geojson, ensure_ascii=False),
        encoding="utf-8",
    )
    if features:
        lons, lats = [], []
        for feat in features:
            for ring in feat["geometry"]["coordinates"]:
                for pt in ring:
                    lons.append(pt[0])
                    lats.append(pt[1])
        log.info(
            f"  ✓ {name}.geojson: {len(features)} 要素 | "
            f"lon=[{min(lons):.4f}, {max(lons):.4f}] "
            f"lat=[{min(lats):.4f}, {max(lats):.4f}]"
        )
    else:
        log.info(f"  ✓ {name}.geojson: 0 要素")


def collect_layers(root: Path, log) -> dict[str, list[tuple[Path, str]]]:
    """扫描输入,返回 `{county|townships|villages: [(shp, override_name)]}`。
    override_name 仅对 townships 有意义,对应"子目录名即乡镇名"布局。"""
    layers: dict[str, list[tuple[Path, str]]] = {
        "county": [],
        "townships": [],
        "villages": [],
    }

    for key in layers:
        d = root / key
        if not d.is_dir():
            continue
        if key == "townships":
            for shp in sorted(d.glob("*.shp")):
                layers["townships"].append((shp, ""))
            for sub in sorted([s for s in d.iterdir() if s.is_dir()]):
                for shp in sub.glob("*.shp"):
                    layers["townships"].append((shp, sub.name))
        else:
            for shp in sorted(d.glob("*.shp")):
                layers[key].append((shp, ""))

    if any(layers[k] for k in layers):
        log.info("  按命名子目录识别边界层")
        return layers

    log.info("  未发现 county/townships/villages 子目录，启用启发式识别")
    for d in sorted([x for x in root.iterdir() if x.is_dir()]):
        shps = list(d.glob("*.shp"))
        subdirs = [s for s in d.iterdir() if s.is_dir()]
        if shps:
            for shp in shps:
                sf = _safe_reader(shp)
                if sf is None:
                    log.warning(f"    [{d.name}] 跳过损坏/空 SHP: {shp.name}")
                    continue
                count = len(sf)
                proj = is_projected(shp)
                log.info(f"    [{d.name}] {shp.name}: {count} 要素, projected={proj}")
                if count == 1 and not proj:
                    layers["county"].append((shp, ""))
                elif count > 100:
                    layers["villages"].append((shp, ""))
                else:
                    layers["townships"].append((shp, ""))
        if subdirs and not shps:
            for sub in sorted(subdirs):
                for shp in sub.glob("*.shp"):
                    if _safe_reader(shp) is None:
                        log.warning(f"    [{sub.name}] 跳过损坏/空 SHP: {shp.name}")
                        continue
                    layers["townships"].append((shp, sub.name))

    return layers


def main() -> int:
    log = get_logger(STEP_ID)
    cfg = load_config()
    paths = get_paths()

    bcfg = ((cfg.get("geo") or {}).get("boundaries") or {})
    projection = str(bcfg.get("projection") or "auto")
    central_meridian = float(bcfg.get("central_meridian") or 117.0)
    is_gcj02 = bool(bcfg.get("is_gcj02", False))

    in_dir = paths.input_boundaries
    out_dir = paths.output_boundaries

    log.info("=" * 70)
    log.info("Step 06 | 行政边界 Shapefile → GeoJSON")
    log.info(f"  输入: {in_dir}")
    log.info(f"  输出: {out_dir}")
    log.info(f"  投影: {projection}  中央经线: {central_meridian}  GCJ-02 修正: {is_gcj02}")
    log.info("=" * 70)

    if not in_dir.exists() or not any(in_dir.iterdir()):
        log.warning(f"未找到边界输入: {in_dir}（可选步骤，已跳过）")
        return 0

    transform = make_transform(projection, central_meridian, is_gcj02=is_gcj02)
    layers = collect_layers(in_dir, log)

    total = sum(len(v) for v in layers.values())
    if total == 0:
        log.warning("未扫描到任何 SHP 文件。")
        return 0

    county_features: list[dict] = []
    township_features: list[dict] = []
    village_features: list[dict] = []

    for shp, _ in layers["county"]:
        proj = is_projected(shp)
        log.info(f"  [county] {shp.name}: projected={proj}")
        county_features.extend(shp_to_features(shp, proj, transform, log))

    for shp, tname in layers["townships"]:
        proj = is_projected(shp)
        log.info(f"  [townships] {shp.name}: projected={proj}" + (f" [{tname}]" if tname else ""))
        feats = shp_to_features(shp, proj, transform, log)
        if tname:
            for f in feats:
                f["properties"]["_township_name"] = tname
        township_features.extend(feats)

    for shp, _ in layers["villages"]:
        proj = is_projected(shp)
        log.info(f"  [villages] {shp.name}: projected={proj}")
        village_features.extend(shp_to_features(shp, proj, transform, log))

    if county_features:
        save_geojson("county", county_features, out_dir, log)
    if township_features:
        save_geojson("townships", township_features, out_dir, log)
    if village_features:
        if township_features:
            assign_townships(village_features, township_features, log)
        save_geojson("villages", village_features, out_dir, log)

    log.info("=" * 70)
    log.info("完成")
    log.info("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
