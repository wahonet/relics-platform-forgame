from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Optional


def load_survey_routes(
    path: Path,
    bounds: Optional[tuple[float, float, float, float]],
    read_csv: Callable[[Path], list[dict]],
    log,
) -> dict[str, list[dict]]:
    rows = read_csv(path)
    if not rows:
        return {}

    def pick(row: dict, *keys: str) -> str:
        for key in keys:
            if key in row and row[key] not in (None, ""):
                return str(row[key]).strip()
        return ""

    west, south, east, north = bounds or (-180.0, -90.0, 180.0, 90.0)
    groups: dict[str, list[dict]] = {}

    for row in rows:
        dt_str = pick(row, "拍摄时间", "time", "datetime")
        lat_str = pick(row, "纬度", "lat", "latitude")
        lon_str = pick(row, "经度", "lon", "lng", "longitude")
        if not dt_str or not lat_str or not lon_str:
            continue
        try:
            lat = float(lat_str)
            lon = float(lon_str)
        except ValueError:
            continue
        if not (south < lat < north and west < lon < east):
            continue

        parts = dt_str.split(" ", 1)
        date_raw = parts[0]
        time_raw = parts[1] if len(parts) > 1 else "00:00:00"

        date_parts = date_raw.replace("/", "-").split("-")
        if len(date_parts) == 3:
            date = f"{int(date_parts[0]):04d}-{int(date_parts[1]):02d}-{int(date_parts[2]):02d}"
        else:
            date = date_raw

        time_parts = time_raw.split(":")
        time_val = ":".join(part.zfill(2) for part in time_parts[:3])
        if len(time_parts) < 3:
            time_val += ":00"

        groups.setdefault(date, []).append({
            "filename": pick(row, "文件名", "filename"),
            "time": time_val,
            "lat": lat,
            "lon": lon,
        })

    for points in groups.values():
        points.sort(key=lambda point: point["time"])

    routes = dict(sorted(groups.items()))
    total = sum(len(points) for points in routes.values())
    log.info("[普查路线] 已加载 %d 天 / %d 个点", len(routes), total)
    return routes


def compute_village_coverage(
    village_path: Path,
    survey_routes: dict[str, list[dict]],
    relics: list[dict],
    log,
) -> Optional[dict]:
    try:
        from shapely.geometry import LineString, Point, shape
        from shapely import STRtree
        from shapely.ops import prep
    except ImportError:
        log.warning("[村村达] 缺少 shapely 依赖，跳过空间分析")
        return None

    with open(village_path, "r", encoding="utf-8") as f:
        vdata = json.load(f)
    features = vdata.get("features", [])
    if not features:
        return None

    village_list: list[dict] = []
    polygons: list = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry")
        if not geom:
            continue
        try:
            poly = shape(geom)
            if not poly.is_valid:
                poly = poly.buffer(0)
        except Exception:
            continue
        centroid = poly.centroid
        village_list.append({
            "name": props.get("ZLDWMC") or props.get("name") or "",
            "township": props.get("_township") or props.get("township") or "",
            "center_lat": round(centroid.y, 6),
            "center_lon": round(centroid.x, 6),
        })
        polygons.append(poly)

    tree = STRtree(polygons)
    prepped = [prep(poly) for poly in polygons]
    reached: set[int] = set()
    first_date: dict[int, str] = {}
    reached_by: dict[int, str] = {}

    for date in sorted(survey_routes.keys()):
        points = survey_routes[date]
        coords = [(point["lon"], point["lat"]) for point in points]
        if len(coords) >= 2:
            route_geom = LineString(coords)
        elif len(coords) == 1:
            route_geom = Point(coords[0])
        else:
            continue
        for idx in tree.query(route_geom):
            if idx not in reached and prepped[idx].intersects(route_geom):
                reached.add(idx)
                first_date[idx] = date
                reached_by[idx] = "route"

    for relic in relics:
        lat = relic.get("center_lat")
        lng = relic.get("center_lng")
        if not lat or not lng:
            continue
        try:
            point = Point(float(lng), float(lat))
        except (TypeError, ValueError):
            continue
        for idx in tree.query(point):
            if idx not in reached and prepped[idx].intersects(point):
                reached.add(idx)
                first_date[idx] = ""
                reached_by[idx] = "relic"

    villages = []
    for idx, village in enumerate(village_list):
        village["reached"] = idx in reached
        village["first_date"] = first_date.get(idx, "")
        village["reached_by"] = reached_by.get(idx, "")
        villages.append(village)

    reached_count = sum(1 for village in villages if village["reached"])
    coverage = {
        "total": len(villages),
        "reached": reached_count,
        "unreached": len(villages) - reached_count,
        "villages": villages,
    }
    log.info(
        "[村村达] %d/%d 村已到达 (%.1f%%)",
        reached_count,
        len(villages),
        reached_count / len(villages) * 100 if villages else 0,
    )
    return coverage
