"""Import the project owner's ArcGIS administrative boundaries.

The source delivery contains four polygon layers:

* city, county and township polygons in EPSG:4326;
* village polygons in ``Krasovsky_1940_Albers``.

This utility trusts each SHP's declared CRS, filters the village layer to
Jining, reprojects everything to WGS-84, normalises the properties consumed by
the web client, and writes deterministic repository seeds under
``boundary/standard``.  The large township/village seeds are gzip-compressed;
``services.boundary_seed`` expands them into ``data/output/boundaries`` at
runtime.

Geospatial dependencies are intentionally development-only.  The running web
service only needs the generated JSON assets.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

try:
    import geopandas as gpd
    from shapely.geometry import mapping
except ImportError as exc:  # pragma: no cover - actionable CLI failure
    raise SystemExit(
        "Boundary import requires geopandas, pyogrio, pyproj and shapely."
    ) from exc


PROJECT_ROOT = Path(__file__).resolve().parents[2]
STANDARD_DIR = PROJECT_ROOT / "boundary" / "standard"
RUNTIME_DIR = PROJECT_ROOT / "data" / "output" / "boundaries"
STATIC_VECTOR_DIR = PROJECT_ROOT / "platform" / "webgis" / "static" / "vector_basemap"

SOURCE_FILES = {
    "city": "济宁市边界.shp",
    "county": "济宁市各县边界.shp",
    "townships": "济宁市镇街边界.shp",
    "villages": "济宁市各村边界.shp",
}

NORMALIZED_KEYS = (
    "name",
    "XZQMC",
    "adcode",
    "level",
    "_county_name",
    "_township_name",
    "_village_name",
    "label_lng",
    "label_lat",
)


def _text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"nan", "none"} else text


def _code(value: Any) -> str:
    text = _text(value)
    if text.endswith(".0"):
        text = text[:-2]
    return text


def _round_nested(value: Any, digits: int = 6) -> Any:
    if isinstance(value, dict):
        return {key: _round_nested(item, digits) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_round_nested(item, digits) for item in value]
    if isinstance(value, float):
        return round(value, digits)
    return value


def _json_bytes(payload: dict, *, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8")


def _write_gzip(path: Path, payload: bytes) -> None:
    # mtime=0 keeps generated assets byte-for-byte reproducible.
    path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))


def _read_layer(source_dir: Path, layer: str):
    path = source_dir / SOURCE_FILES[layer]
    if not path.is_file():
        raise FileNotFoundError(f"Missing source layer: {path}")
    frame = gpd.read_file(path, engine="pyogrio")
    if frame.crs is None:
        raise ValueError(f"Layer has no declared CRS: {path.name}")
    if frame.empty:
        raise ValueError(f"Layer is empty: {path.name}")
    if frame.geometry.isna().any() or frame.geometry.is_empty.any():
        raise ValueError(f"Layer contains null/empty geometry: {path.name}")
    if (~frame.geometry.is_valid).any():
        raise ValueError(f"Layer contains invalid geometry: {path.name}")
    return frame


def _representative_points_wgs84(frame):
    # Representative points stay inside concave polygons and islands, unlike a
    # bbox centre.  UTM 50N is appropriate for the Jining extent.
    projected = frame.to_crs(32650)
    points = gpd.GeoSeries(projected.geometry.representative_point(), crs=32650)
    return points.to_crs(4326)


def _county_index(counties):
    county_wgs84 = counties.to_crs(4326)
    rows = []
    for _, row in county_wgs84.iterrows():
        rows.append(
            {
                "name": _text(row.get("地名") or row.get("县级")),
                "adcode": _code(row.get("区划码") or row.get("县级码") or row.get("code")),
                "geometry": row.geometry,
            }
        )
    return rows


def _locate_county(point, counties: list[dict]) -> dict:
    for county in counties:
        if county["geometry"].covers(point):
            return county
    # Boundary precision can leave a representative point a few centimetres
    # outside.  Nearest standard county is a safe deterministic fallback.
    return min(counties, key=lambda item: item["geometry"].distance(point))


def _locate_township(point, townships: list[dict]) -> dict:
    for township in townships:
        if township["geometry"].covers(point):
            return township
    return min(townships, key=lambda item: item["geometry"].distance(point))


def _township_index(townships, counties: list[dict], villages) -> list[dict]:
    township_wgs84 = townships.to_crs(4326)
    township_labels = _representative_points_wgs84(townships)
    rows: list[dict] = []
    for position, (_, row) in enumerate(township_wgs84.iterrows()):
        county = _locate_county(township_labels.iloc[position], counties)
        name = _text(row.get("乡"))
        if not name:
            raise ValueError(f"townships[{position}] lacks a name")
        rows.append(
            {
                "index": position,
                "name": name,
                "county_name": county["name"],
                "county_adcode": county["adcode"],
                "geometry": row.geometry,
                "adcode": "",
            }
        )

    # The township SHP has no code field, while the village delivery carries
    # official 9-digit township codes.  Assign each village spatially to the
    # standard township polygon, then take that polygon's modal official code.
    code_counts = {row["index"]: Counter() for row in rows}
    village_wgs84 = villages.to_crs(4326)
    village_labels = _representative_points_wgs84(villages)
    for position, (_, village) in enumerate(village_wgs84.iterrows()):
        township = _locate_township(village_labels.iloc[position], rows)
        code = _code(village.get("镇代码_"))
        if len(code) == 9 and code.isdigit():
            code_counts[township["index"]][code] += 1

    for township in rows:
        counts = code_counts[township["index"]]
        if counts:
            township["source_adcode"] = sorted(
                counts,
                key=lambda code: (-counts[code], code),
            )[0]
        else:
            township["source_adcode"] = ""

    # Functional-area and historic village records can reuse one source code
    # across two current standard polygons.  Keep the official source value
    # for traceability, but use an explicit stable project key wherever that
    # code is absent or ambiguous rather than pretending it is unique.
    code_groups: dict[str, list[dict]] = {}
    for township in rows:
        source_adcode = township["source_adcode"]
        if source_adcode:
            code_groups.setdefault(source_adcode, []).append(township)
    for township in rows:
        source_adcode = township["source_adcode"]
        if source_adcode and len(code_groups[source_adcode]) == 1:
            township["adcode"] = source_adcode
        else:
            digest = hashlib.sha1(
                f"{township['county_adcode']}|{township['name']}".encode("utf-8")
            ).hexdigest()[:10]
            township["adcode"] = f"town-{digest}"

    used_codes: dict[str, str] = {}
    for township in rows:
        duplicate = used_codes.get(township["adcode"])
        if duplicate:
            raise ValueError(
                f"Township code {township['adcode']} maps to both "
                f"{duplicate} and {township['name']}"
            )
        used_codes[township["adcode"]] = township["name"]
    return rows


def _feature_collection(
    frame,
    layer: str,
    townships: list[dict],
) -> dict:
    wgs84 = frame.to_crs(4326)
    labels = _representative_points_wgs84(frame)
    features: list[dict] = []

    for position, (_, row) in enumerate(wgs84.iterrows()):
        label = labels.iloc[position]
        located_township = (
            _locate_township(label, townships)
            if layer in {"townships", "villages"}
            else None
        )

        if layer == "city":
            name = _text(row.get("地名") or row.get("地级"))
            adcode = _code(row.get("区划码") or row.get("地级码") or row.get("code"))
            county_name = township_name = village_name = ""
        elif layer == "county":
            name = _text(row.get("地名") or row.get("县级"))
            adcode = _code(row.get("区划码") or row.get("县级码") or row.get("code"))
            county_name = name
            township_name = village_name = ""
        elif layer == "townships":
            name = located_township["name"]
            county_name = located_township["county_name"]
            township_name = name
            village_name = ""
            adcode = located_township["adcode"]
        else:
            name = _text(row.get("XZQMC"))
            adcode = _code(row.get("code") or row.get("XZQDM"))
            county_name = located_township["county_name"]
            township_name = located_township["name"]
            village_name = name

        if not name or not adcode:
            raise ValueError(f"{layer}[{position}] lacks a normalised name/adcode")

        properties = {
            "name": name,
            "XZQMC": name,
            "adcode": adcode,
            "level": layer[:-1] if layer.endswith("s") else layer,
            "_county_name": county_name,
            "_township_name": township_name,
            "_village_name": village_name,
            "label_lng": round(float(label.x), 6),
            "label_lat": round(float(label.y), 6),
        }
        # Keep the legacy village-name alias used by the boundary export and
        # some existing deployments, while presenting one normalised contract
        # to the new renderer.
        if layer == "villages":
            properties["ZLDWMC"] = name
        elif layer == "townships":
            properties["source_adcode"] = located_township["source_adcode"]
        assert set(NORMALIZED_KEYS).issubset(properties)
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": _round_nested(mapping(row.geometry), 6),
            }
        )

    return {"type": "FeatureCollection", "features": features}


def _bbox(collection: dict) -> list[float]:
    west = south = float("inf")
    east = north = float("-inf")

    def visit(value: Any) -> None:
        nonlocal west, south, east, north
        if (
            isinstance(value, list)
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and isinstance(value[1], (int, float))
        ):
            lng, lat = float(value[0]), float(value[1])
            west, south = min(west, lng), min(south, lat)
            east, north = max(east, lng), max(north, lat)
            return
        if isinstance(value, list):
            for item in value:
                visit(item)

    for feature in collection["features"]:
        visit(feature["geometry"]["coordinates"])
    return [round(west, 6), round(south, 6), round(east, 6), round(north, 6)]


def _geometry_type(collection: dict) -> str:
    types = {feature["geometry"]["type"] for feature in collection["features"]}
    return next(iter(types)) if len(types) == 1 else "mixed"


def _write_runtime(
    manifest: dict,
    collections: dict[str, dict],
    manifest_sha256: str,
) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    for layer, collection in collections.items():
        (RUNTIME_DIR / f"{layer}.geojson").write_bytes(_json_bytes(collection))
    state = {
        "schema_version": manifest["schema_version"],
        "dataset_version": manifest["dataset_version"],
        "manifest_sha256": manifest_sha256,
        "layers": {
            layer: manifest["layers"][layer]["content_sha256"]
            for layer in collections
        },
    }
    (RUNTIME_DIR / ".standard-boundaries.json").write_bytes(_json_bytes(state, pretty=True))


def import_boundaries(source_dir: Path, dataset_version: str, village_tolerance_m: float) -> dict:
    source_dir = source_dir.resolve()
    city = _read_layer(source_dir, "city")
    county = _read_layer(source_dir, "county")
    townships = _read_layer(source_dir, "townships")
    villages = _read_layer(source_dir, "villages")

    # The village delivery includes neighbouring edge features.  The source
    # attribute identifies exactly 6,504 Jining villages.
    villages = villages[villages["市名_1"].astype(str).str.strip() == "济宁市"].copy()
    if len(city) != 1 or len(county) != 11 or len(townships) != 157 or len(villages) != 6504:
        raise ValueError(
            "Unexpected feature counts: "
            f"city={len(city)}, county={len(county)}, "
            f"townships={len(townships)}, villages={len(villages)}"
        )

    # Simplify only the dense village delivery, in its native metre-based CRS.
    # Two metres is visually lossless at village scale while cutting the web
    # payload by roughly 60%; preserve_topology keeps polygons valid.
    if village_tolerance_m > 0:
        villages.geometry = villages.geometry.simplify(
            village_tolerance_m,
            preserve_topology=True,
        )
        if (~villages.geometry.is_valid).any():
            raise ValueError("Village simplification produced invalid geometry")

    county_lookup = _county_index(county)
    township_lookup = _township_index(townships, county_lookup, villages)
    frames = {
        "city": city,
        "county": county,
        "townships": townships,
        "villages": villages,
    }
    collections = {
        layer: _feature_collection(frame, layer, township_lookup)
        for layer, frame in frames.items()
    }

    STANDARD_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_VECTOR_DIR.mkdir(parents=True, exist_ok=True)
    layer_manifest: dict[str, dict] = {}
    for layer, collection in collections.items():
        compressed = layer in {"townships", "villages"}
        filename = f"{layer}.geojson" + (".gz" if compressed else "")
        payload = _json_bytes(collection)
        output = STANDARD_DIR / filename
        if compressed:
            _write_gzip(output, payload)
        else:
            output.write_bytes(payload)
        layer_manifest[layer] = {
            "file": filename,
            "encoding": "gzip+utf-8" if compressed else "utf-8",
            "feature_count": len(collection["features"]),
            "geometry_type": _geometry_type(collection),
            "bbox": _bbox(collection),
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "content_sha256": hashlib.sha256(payload).hexdigest(),
        }

    manifest = {
        "schema_version": 1,
        "dataset_version": dataset_version,
        "crs": "EPSG:4326",
        "source": "ArcGIS standard boundary shapefiles supplied by the project owner",
        "source_files": SOURCE_FILES,
        "village_simplification_m": village_tolerance_m,
        "layers": layer_manifest,
    }
    manifest_path = STANDARD_DIR / "manifest.json"
    manifest_path.write_bytes(_json_bytes(manifest, pretty=True))
    manifest_sha256 = hashlib.sha256(manifest_path.read_bytes()).hexdigest()

    # County navigation and the offline vector basemap must use the exact same
    # WGS-84 city/county geometry as the visible administrative overlay.
    for layer in ("city", "county"):
        shutil.copyfile(STANDARD_DIR / f"{layer}.geojson", STATIC_VECTOR_DIR / f"{layer}.geojson")

    _write_runtime(manifest, collections, manifest_sha256)
    return manifest


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Directory containing the ArcGIS SHP delivery")
    parser.add_argument(
        "--dataset-version",
        default="2026-07-10-arcgis-v2",
        help="Stable version written to the seed manifest",
    )
    parser.add_argument(
        "--village-tolerance-m",
        type=float,
        default=2.0,
        help="Topology-preserving village simplification tolerance in metres",
    )
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = import_boundaries(
        args.source,
        dataset_version=args.dataset_version,
        village_tolerance_m=max(0.0, args.village_tolerance_m),
    )
    summary = {
        layer: {
            "features": meta["feature_count"],
            "bbox": meta["bbox"],
            "file": meta["file"],
        }
        for layer, meta in manifest["layers"].items()
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
