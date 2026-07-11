from __future__ import annotations

import gzip
import json
import math
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import boundary_seed


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STANDARD_DIR = PROJECT_ROOT / "boundary" / "standard"
MANIFEST_PATH = STANDARD_DIR / "manifest.json"
STATIC_VECTOR_DIR = PROJECT_ROOT / "platform" / "webgis" / "static" / "vector_basemap"

EXPECTED_COUNTS = {
    "city": 1,
    "county": 11,
    "townships": 157,
    "villages": 6504,
}
EXPECTED_OUTPUTS = {f"{name}.geojson" for name in EXPECTED_COUNTS}
JINING_COUNTIES = {
    "任城区",
    "兖州区",
    "曲阜市",
    "邹城市",
    "微山县",
    "鱼台县",
    "金乡县",
    "嘉祥县",
    "汶上县",
    "泗水县",
    "梁山县",
}
NORMALIZED_FIELDS = {
    "name",
    "XZQMC",
    "adcode",
    "_county_name",
    "_township_name",
    "_village_name",
    "label_lng",
    "label_lat",
    "level",
}


def _read_json(path: Path) -> dict:
    if path.suffix.lower() == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
    else:
        payload = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict), f"{path} 顶层必须是 JSON object"
    return payload


@pytest.fixture(scope="module")
def manifest() -> dict:
    assert MANIFEST_PATH.is_file(), f"缺少标准边界清单: {MANIFEST_PATH}"
    payload = _read_json(MANIFEST_PATH)
    assert payload.get("schema_version")
    assert payload.get("dataset_version")
    assert payload.get("source")
    assert payload.get("crs")
    assert isinstance(payload.get("layers"), dict)
    return payload


def _layer_meta(manifest: dict, layer: str) -> dict:
    meta = manifest["layers"].get(layer)
    assert isinstance(meta, dict), f"manifest 缺少 {layer} 层"
    return meta


def _feature_count(meta: dict) -> int:
    # 兼容早期草案中的 count；正式清单使用 feature_count。
    value = meta.get("feature_count", meta.get("count"))
    assert isinstance(value, int)
    return value


def _layer_path(manifest: dict, layer: str) -> Path:
    filename = _layer_meta(manifest, layer).get("file")
    assert isinstance(filename, str) and filename
    path = (STANDARD_DIR / filename).resolve()
    assert path.parent == STANDARD_DIR.resolve(), f"非法层文件路径: {filename}"
    assert path.is_file(), f"缺少标准边界层: {path}"
    return path


def _assert_bbox(bbox: object, *, layer: str) -> tuple[float, float, float, float]:
    assert isinstance(bbox, list) and len(bbox) == 4, f"{layer}.bbox 必须为四元数组"
    west, south, east, north = (float(value) for value in bbox)
    assert all(math.isfinite(value) for value in (west, south, east, north))
    assert west < east and south < north
    # 济宁市及飞地的宽松 WGS84 防呆范围；可及时发现米制或未转 GCJ-02 数据。
    assert 115.0 < west < 118.0
    assert 115.0 < east < 118.5
    assert 34.0 < south < 36.5
    assert 34.0 < north < 36.5
    return west, south, east, north


def test_manifest_declares_four_wgs84_layers(manifest: dict):
    crs = str(manifest["crs"]).upper().replace(" ", "")
    assert crs in {"WGS84", "WGS-84", "EPSG:4326", "EPSG4326"}
    assert set(manifest["layers"]) == set(EXPECTED_COUNTS)

    city_bbox = _assert_bbox(_layer_meta(manifest, "city").get("bbox"), layer="city")
    for layer, expected in EXPECTED_COUNTS.items():
        meta = _layer_meta(manifest, layer)
        assert _feature_count(meta) == expected
        compression = meta.get("compression", meta.get("encoding"))
        assert isinstance(compression, str) and compression
        assert str(meta.get("geometry_type")).lower() in {
            "polygon",
            "multipolygon",
            "mixed",
        }
        bbox = _assert_bbox(meta.get("bbox"), layer=layer)
        # 所有细分层必须落在市界外接框附近；留少量误差容纳边界精度差异。
        assert bbox[0] >= city_bbox[0] - 0.05
        assert bbox[1] >= city_bbox[1] - 0.05
        assert bbox[2] <= city_bbox[2] + 0.05
        assert bbox[3] <= city_bbox[3] + 0.05

        path = _layer_path(manifest, layer)
        is_gzip = "gzip" in compression.lower()
        assert (path.suffix.lower() == ".gz") is is_gzip


@pytest.mark.parametrize("layer", tuple(EXPECTED_COUNTS))
def test_standard_layer_feature_contract(manifest: dict, layer: str):
    collection = _read_json(_layer_path(manifest, layer))
    assert collection.get("type") == "FeatureCollection"
    features = collection.get("features")
    assert isinstance(features, list)
    assert len(features) == EXPECTED_COUNTS[layer]

    expected_geometry = str(_layer_meta(manifest, layer).get("geometry_type"))
    for index, feature in enumerate(features):
        assert feature.get("type") == "Feature", f"{layer}[{index}] 不是 Feature"
        geometry = feature.get("geometry") or {}
        if expected_geometry.lower() != "mixed":
            assert geometry.get("type") == expected_geometry
        else:
            assert geometry.get("type") in {"Polygon", "MultiPolygon"}

        properties = feature.get("properties")
        assert isinstance(properties, dict)
        missing = NORMALIZED_FIELDS.difference(properties)
        assert not missing, f"{layer}[{index}] 缺少规范字段: {sorted(missing)}"
        assert str(properties["name"]).strip()
        assert properties["XZQMC"] == properties["name"]
        assert str(properties["adcode"]).strip()
        assert str(properties["level"]).strip()
        lng = float(properties["label_lng"])
        lat = float(properties["label_lat"])
        assert math.isfinite(lng) and math.isfinite(lat)
        assert 115.0 < lng < 118.5 and 34.0 < lat < 36.5

        if layer == "county":
            assert properties["_county_name"] == properties["name"]
        elif layer == "townships":
            assert properties["_county_name"] in JINING_COUNTIES
            assert properties["_township_name"] == properties["name"]
        elif layer == "villages":
            assert properties["_county_name"] in JINING_COUNTIES
            assert str(properties["_township_name"]).strip()
            assert properties["_village_name"] == properties["name"]
            assert properties.get("ZLDWMC") == properties["name"]


def test_villages_are_limited_to_jining(manifest: dict):
    villages = _read_json(_layer_path(manifest, "villages"))["features"]
    townships = _read_json(_layer_path(manifest, "townships"))["features"]
    county_names = {
        str((feature.get("properties") or {}).get("_county_name") or "").strip()
        for feature in villages
    }
    assert county_names
    assert county_names <= JINING_COUNTIES
    # 数据应覆盖全市 11 个县市区，而非误抽取某一个县或混入省内其它地区。
    assert county_names == JINING_COUNTIES

    # 村表里的历史镇街名称不能直接使用；空间归属后必须落在标准镇街层。
    township_names = {
        str((feature.get("properties") or {}).get("name") or "").strip()
        for feature in townships
    }
    village_township_names = {
        str((feature.get("properties") or {}).get("_township_name") or "").strip()
        for feature in villages
    }
    assert village_township_names <= township_names
    assert len(village_township_names) >= 150
    township_codes = [
        str((feature.get("properties") or {}).get("adcode") or "").strip()
        for feature in townships
    ]
    assert all(township_codes)
    assert len(set(township_codes)) == EXPECTED_COUNTS["townships"]


@pytest.mark.parametrize("layer", ("city", "county"))
def test_static_vector_boundaries_match_canonical(manifest: dict, layer: str):
    canonical = _read_json(_layer_path(manifest, layer))
    static_copy = _read_json(STATIC_VECTOR_DIR / f"{layer}.geojson")
    assert static_copy == canonical


def test_seed_restore_recovers_four_layers_and_skips_matching_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    manifest: dict,
):
    output_dir = tmp_path / "boundaries"
    monkeypatch.setattr(boundary_seed, "SEED_DIR", STANDARD_DIR)
    monkeypatch.setattr(
        boundary_seed,
        "get_paths",
        lambda: SimpleNamespace(output_boundaries=output_dir),
    )

    restored = boundary_seed.restore_seed_boundaries()
    assert set(restored) == EXPECTED_OUTPUTS

    state_path = output_dir / ".standard-boundaries.json"
    assert state_path.is_file()
    state = _read_json(state_path)
    assert state.get("dataset_version") == manifest["dataset_version"]

    for layer, expected in EXPECTED_COUNTS.items():
        output = output_dir / f"{layer}.geojson"
        assert output.is_file()
        collection = _read_json(output)
        assert collection.get("type") == "FeatureCollection"
        assert len(collection.get("features") or []) == expected

    # 设为明显的历史时间。若第二次恢复重写任何文件，mtime 会变回当前时间。
    tracked_paths = [state_path, *(output_dir / name for name in sorted(EXPECTED_OUTPUTS))]
    sentinel_ns = 1_600_000_000_000_000_000
    for index, path in enumerate(tracked_paths):
        stamp = sentinel_ns + index
        os.utime(path, ns=(stamp, stamp))
    mtimes_before = {path.name: path.stat().st_mtime_ns for path in tracked_paths}

    restored_again = boundary_seed.restore_seed_boundaries()
    assert restored_again == []
    assert {path.name: path.stat().st_mtime_ns for path in tracked_paths} == mtimes_before

    # 相同版本号不能掩盖运行时文件损坏；内容哈希不一致时应完整重建。
    corrupted = output_dir / "townships.geojson"
    corrupted.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    restored_after_corruption = boundary_seed.restore_seed_boundaries()
    assert set(restored_after_corruption) == EXPECTED_OUTPUTS
    assert len(_read_json(corrupted)["features"]) == EXPECTED_COUNTS["townships"]
