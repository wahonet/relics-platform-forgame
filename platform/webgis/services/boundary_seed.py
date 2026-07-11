"""Restore packaged administrative-boundary seeds into the runtime directory.

``boundary/standard`` is the canonical WGS-84 delivery generated from the
project owner's ArcGIS layers.  City/county files are plain GeoJSON while the
larger township/village files are gzip-compressed in Git.  At startup they are
expanded to ``data/output/boundaries`` where the existing static mount and
export API can keep using the four conventional filenames.

The old DataV GCJ-02 seeds remain as a compatibility fallback for deployments
that do not ship the new manifest.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import re
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from _common import PROJECT_ROOT, gcj02_to_wgs84, get_paths  # noqa: E402

SEED_DIR = PROJECT_ROOT / "boundary" / "standard"
LEGACY_SEED_DIR = PROJECT_ROOT / "boundary"
STATE_FILENAME = ".standard-boundaries.json"
LAYER_NAMES = ("city", "county", "townships", "villages")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _read_json(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def _safe_seed_path(filename: str) -> Path:
    path = (SEED_DIR / filename).resolve()
    if path.parent != SEED_DIR.resolve():
        raise ValueError(f"Unsafe boundary seed path: {filename}")
    return path


def _seed_bytes(path: Path, encoding: str) -> bytes:
    raw = path.read_bytes()
    if "gzip" in encoding.lower() or path.suffix.lower() == ".gz":
        return gzip.decompress(raw)
    return raw


def _write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(payload)
    temporary.replace(path)


def _state_matches(out_dir: Path, manifest: dict, manifest_sha256: str) -> bool:
    state_path = out_dir / STATE_FILENAME
    try:
        state = _read_json(state_path)
    except (OSError, json.JSONDecodeError, ValueError):
        return False
    if state.get("dataset_version") != manifest.get("dataset_version"):
        return False
    if state.get("manifest_sha256") != manifest_sha256:
        return False
    state_layers = state.get("layers")
    if not isinstance(state_layers, dict):
        return False
    for layer in LAYER_NAMES:
        meta = manifest["layers"][layer]
        expected = str(meta.get("content_sha256") or "")
        output = out_dir / f"{layer}.geojson"
        if state_layers.get(layer) != expected or not output.is_file():
            return False
        try:
            if hashlib.sha256(output.read_bytes()).hexdigest() != expected:
                return False
        except OSError:
            return False
    return True


def _validate_collection(collection: dict, meta: dict, source_name: str) -> list[dict]:
    features = collection.get("features") if isinstance(collection, dict) else None
    if (
        not isinstance(collection, dict)
        or collection.get("type") != "FeatureCollection"
        or not isinstance(features, list)
    ):
        raise ValueError(f"Invalid GeoJSON seed: {source_name}")

    bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]

    def visit(value) -> None:
        if (
            isinstance(value, list)
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and not isinstance(value[0], bool)
            and isinstance(value[1], (int, float))
            and not isinstance(value[1], bool)
        ):
            lng, lat = float(value[0]), float(value[1])
            if not math.isfinite(lng) or not math.isfinite(lat):
                raise ValueError(f"Non-finite coordinate in {source_name}")
            if not -180 <= lng <= 180 or not -90 <= lat <= 90:
                raise ValueError(f"Non-WGS84 coordinate in {source_name}: {lng}, {lat}")
            bounds[0] = min(bounds[0], lng)
            bounds[1] = min(bounds[1], lat)
            bounds[2] = max(bounds[2], lng)
            bounds[3] = max(bounds[3], lat)
            return
        if not isinstance(value, list):
            raise ValueError(f"Malformed coordinates in {source_name}")
        for item in value:
            visit(item)

    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"Invalid feature in {source_name}")
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in {
            "Polygon",
            "MultiPolygon",
        }:
            raise ValueError(f"Unsupported geometry in {source_name}")
        visit(geometry.get("coordinates"))

    declared_bbox = meta.get("bbox")
    if (
        not isinstance(declared_bbox, list)
        or len(declared_bbox) != 4
        or any(not isinstance(value, (int, float)) for value in declared_bbox)
        or any(not math.isfinite(float(value)) for value in declared_bbox)
    ):
        raise ValueError(f"Invalid bbox metadata for {source_name}")
    if any(abs(float(declared_bbox[index]) - bounds[index]) > 0.000002 for index in range(4)):
        raise ValueError(f"Boundary bbox mismatch: {source_name}")
    return features


def _restore_standard() -> list[str] | None:
    manifest_path = SEED_DIR / "manifest.json"
    if not manifest_path.is_file():
        return None
    manifest = _read_json(manifest_path)
    manifest_sha256 = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if manifest.get("schema_version") != 1:
        raise ValueError("Unsupported standard boundary schema")
    if not isinstance(manifest.get("dataset_version"), str) or not manifest["dataset_version"].strip():
        raise ValueError("Standard boundary manifest lacks dataset_version")
    crs = str(manifest.get("crs") or "").upper().replace(" ", "")
    if crs not in {"EPSG:4326", "EPSG4326", "WGS84", "WGS-84"}:
        raise ValueError("Standard boundary manifest must declare WGS84/EPSG:4326")
    layers = manifest.get("layers")
    if not isinstance(layers, dict) or set(layers) != set(LAYER_NAMES):
        raise ValueError("Standard boundary manifest must declare exactly four layers")

    out_dir = get_paths().output_boundaries
    out_dir.mkdir(parents=True, exist_ok=True)
    if _state_matches(out_dir, manifest, manifest_sha256):
        return []

    prepared: dict[str, bytes] = {}
    for layer in LAYER_NAMES:
        meta = layers.get(layer)
        if not isinstance(meta, dict):
            raise ValueError(f"Invalid manifest metadata for {layer}")
        filename = meta.get("file")
        encoding = str(meta.get("encoding") or "utf-8")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"Missing seed filename for {layer}")
        source = _safe_seed_path(filename)
        if not source.is_file():
            raise FileNotFoundError(source)
        expected_hash = str(meta.get("sha256") or "")
        expected_content_hash = str(meta.get("content_sha256") or "")
        if not _SHA256_RE.fullmatch(expected_hash):
            raise ValueError(f"Invalid boundary seed checksum: {source.name}")
        if not _SHA256_RE.fullmatch(expected_content_hash):
            raise ValueError(f"Invalid boundary content checksum: {source.name}")
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Boundary seed checksum mismatch: {source.name}")
        payload = _seed_bytes(source, encoding)
        if hashlib.sha256(payload).hexdigest() != expected_content_hash:
            raise ValueError(f"Boundary content checksum mismatch: {source.name}")
        collection = json.loads(payload.decode("utf-8"))
        features = _validate_collection(collection, meta, source.name)
        expected_count = meta.get("feature_count", meta.get("count"))
        if isinstance(expected_count, int) and len(features) != expected_count:
            raise ValueError(f"Boundary feature count mismatch: {source.name}")
        prepared[f"{layer}.geojson"] = payload

    # Validate all four files before replacing any runtime asset.
    for filename, payload in prepared.items():
        _write_atomic(out_dir / filename, payload)
    state = {
        "schema_version": manifest.get("schema_version"),
        "dataset_version": manifest.get("dataset_version"),
        "manifest_sha256": manifest_sha256,
        "layers": {
            layer: manifest["layers"][layer]["content_sha256"]
            for layer in LAYER_NAMES
        },
    }
    _write_atomic(
        out_dir / STATE_FILENAME,
        (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    return sorted(prepared)


# ---- Legacy DataV fallback -------------------------------------------------

_SUFFIX_TO_OUTPUT = {
    "_市.geojson": "city.geojson",
    "_县.geojson": "county.geojson",
}


def _convert_ring(ring: list) -> list:
    out = []
    for point in ring:
        if not point or len(point) < 2:
            continue
        lng, lat = gcj02_to_wgs84(float(point[0]), float(point[1]))
        out.append([lng, lat])
    return out


def _flatten_features(collection: dict) -> list[dict]:
    features: list[dict] = []
    for feature in collection.get("features") or []:
        properties = dict(feature.get("properties") or {})
        name = properties.get("name") or properties.get("XZQMC") or ""
        properties.setdefault("XZQMC", name)
        properties.setdefault("_county_name", name)
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "Polygon":
            polygons = [geometry.get("coordinates") or []]
        elif geometry.get("type") == "MultiPolygon":
            polygons = geometry.get("coordinates") or []
        else:
            polygons = []
        for rings in polygons:
            converted = [_convert_ring(ring) for ring in rings if len(ring) >= 3]
            if converted and len(converted[0]) >= 3:
                features.append(
                    {
                        "type": "Feature",
                        "properties": dict(properties),
                        "geometry": {"type": "Polygon", "coordinates": converted},
                    }
                )
    return features


def _restore_legacy() -> list[str]:
    if not LEGACY_SEED_DIR.exists():
        return []
    out_dir = get_paths().output_boundaries
    out_dir.mkdir(parents=True, exist_ok=True)
    restored: list[str] = []
    for source in sorted(LEGACY_SEED_DIR.glob("*.geojson")):
        prefix = source.name.split("_")[0]
        if prefix.endswith(("省", "自治区")):
            continue
        target = next(
            (output for suffix, output in _SUFFIX_TO_OUTPUT.items() if source.name.endswith(suffix)),
            None,
        )
        if not target:
            continue
        try:
            collection = _read_json(source)
            features = _flatten_features(collection)
            if not features:
                continue
            _write_atomic(
                out_dir / target,
                json.dumps(
                    {"type": "FeatureCollection", "features": features},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )
            restored.append(target)
        except (OSError, json.JSONDecodeError, ValueError):
            continue
    return restored


def restore_seed_boundaries() -> list[str]:
    """Restore canonical four-level boundaries; use legacy city/county as fallback."""
    standard = _restore_standard()
    return _restore_legacy() if standard is None else standard
