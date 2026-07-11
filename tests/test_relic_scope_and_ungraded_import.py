from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from md_archive import parse_archive_md, parse_coordinates
from relic_scope import (
    filter_relics,
    normalize_relic_scope,
    relic_in_scope,
    scope_counts,
)
import step01_import_relics
from step01_import_relics import (
    _match_two_lines,
    _merge_protected_baseline,
    import_from_markdown,
)
from data_loader import DataStore
from services.patrol_service import PatrolDB
from routers import patrol


def _md(*, code: str, name: str, level: str, county: str = "任城区") -> str:
    return f"""# {name}

## 基本信息

| 字段 | 内容 |
|------|------|
| 档案编号 | {code} |
| 区县 | {county} |
| 文物大类 | 古文化遗址 |

## 位置信息

| 字段 | 内容 |
|------|------|
| 详细地址 | 山东省济宁市任城区李营街道测试村 |
| 是否整体迁移并在新迁址占有独立地域范围 | 否 |

## 坐标数据

| 序号 | 分组 | 测点类型 | 纬度 | 经度 | 海拔(m) | 测点说明 | 备注 |
|------|------|---------|------|------|---------|---------|------|
| 1 | （无） | 9 | 35°25′0.0″ | 116°35′0.0″ | 30 | 测点 | （无） |

## 文物属性

| 字段 | 内容 |
|------|------|
| 文物级别 | {level} |
| 类别（大类） | 古文化遗址 |
| 年代 | 汉 |
| 统计年代 | 战国秦汉 |

## 保存现状

| 字段 | 内容 |
|------|------|
| 现状评估 | 一般 |

## 简介

测试简介。
"""


def _paths(root):
    return SimpleNamespace(
        root=root,
        input_docs=root / "data" / "input" / "00_docs",
        input_markdown=root / "data" / "input" / "01_relics" / "markdown",
        input_media=root / "data" / "input" / "02_media",
        output_dataset=root / "data" / "output" / "dataset",
        output_photos=root / "data" / "output" / "photos",
        output_drawings=root / "data" / "output" / "drawings",
    )


def test_scope_keeps_tier_semantics_separate():
    rows = [
        {"archive_code": "P1", "_rank_code": "1", "tier": "city"},
        {"archive_code": "P4", "_rank_code": "4", "tier": "full"},
        {"archive_code": "U1", "_rank_code": "5", "tier": "full"},
    ]

    assert normalize_relic_scope("designated") == "protected"
    assert [r["archive_code"] for r in filter_relics(rows, "protected")] == ["P1", "P4"]
    assert [r["archive_code"] for r in filter_relics(rows, "all")] == ["P1", "P4", "U1"]
    assert relic_in_scope(rows[2], "protected") is False
    assert scope_counts(rows) == {"all": 3, "protected": 2, "ungraded": 1}


def test_memory_queries_apply_scope_to_bbox_and_search():
    ds = DataStore()
    ds.relics = [
        {
            "archive_code": "P1",
            "name": "保护遗址",
            "heritage_level": "省级文物保护单位",
            "category_main": "古文化遗址",
            "center_lng": 116.5,
            "center_lat": 35.4,
        },
        {
            "archive_code": "U1",
            "name": "未定级遗址",
            "heritage_level": "尚未核定公布为文物保护单位的不可移动文物",
            "category_main": "古文化遗址",
            "center_lng": 116.6,
            "center_lat": 35.5,
        },
    ]

    common = dict(
        categories=None,
        ranks=None,
        county=None,
        township=None,
        tier=None,
        condition=None,
    )
    protected = ds.query_bbox(116, 35, 117, 36, scope="protected", **common)
    all_rows = ds.query_bbox(116, 35, 117, 36, scope="all", **common)
    assert [r["code"] for r in protected] == ["P1"]
    assert [r["code"] for r in all_rows] == ["P1", "U1"]
    assert ds.search_fulltext("未定级", scope="protected") == []
    assert [r["code"] for r in ds.search_fulltext("未定级", scope="all")] == ["U1"]


def test_patrol_routes_persist_and_filter_creation_scope(tmp_path):
    db = PatrolDB()
    db.init(tmp_path / "patrol")
    try:
        protected = db.create_route(
            name="文保路线",
            relic_codes=["P1"],
            data_scope="protected",
        )
        all_route = db.create_route(
            name="全量路线",
            relic_codes=["P1", "U1"],
            data_scope="all",
        )
        assert protected["data_scope"] == "protected"
        assert all_route["data_scope"] == "all"
        assert [r["name"] for r in db.list_routes(data_scope="protected")] == ["文保路线"]
        assert [r["name"] for r in db.list_routes(data_scope="all")] == ["全量路线"]
    finally:
        db.close()


def test_patrol_plan_uses_requested_scope(monkeypatch):
    rows = [
        {
            "archive_code": "P1",
            "name": "保护遗址",
            "heritage_level": "省级文物保护单位",
            "_rank_code": "2",
            "center_lng": 116.5,
            "center_lat": 35.4,
            "condition_level": "一般",
            "county": "任城区",
        },
        {
            "archive_code": "U1",
            "name": "未定级遗址",
            "heritage_level": "尚未核定公布为文物保护单位的不可移动文物",
            "_rank_code": "5",
            "center_lng": 116.6,
            "center_lat": 35.5,
            "condition_level": "一般",
            "county": "任城区",
        },
    ]
    monkeypatch.setattr(patrol.store, "relics", rows)
    monkeypatch.setattr(patrol.store, "relics_map", {r["archive_code"]: r for r in rows})
    monkeypatch.setattr(
        patrol.ai_service,
        "parse_patrol_intent",
        lambda _text: {"type": "condition", "count": 30, "_parser": "rules"},
    )
    monkeypatch.setattr(
        patrol,
        "_plan_geometry",
        lambda stops, start=None: {
            "distance_m": 0,
            "duration_s": 0,
            "polyline": [[s["lng"], s["lat"]] for s in stops],
            "source": "test",
        },
    )

    protected = asyncio.run(
        patrol.patrol_plan(patrol.PlanRequest(text="规划路线", scope="protected"))
    )
    all_rows = asyncio.run(
        patrol.patrol_plan(patrol.PlanRequest(text="规划路线", scope="all"))
    )
    assert protected["scope"] == "protected"
    assert protected["routes"][0]["codes"] == ["P1"]
    assert all_rows["scope"] == "all"
    assert set(all_rows["routes"][0]["codes"]) == {"P1", "U1"}


def test_coordinate_fallback_uses_valid_unknown_type_and_rejects_shifted_columns():
    valid = """## 坐标数据
| 序号 | 分组 | 测点类型 | 纬度 | 经度 | 海拔(m) | 测点说明 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 无 | 9 | 35°0′0″ | 116°0′0″ | 20 | A | 无 |
| 2 | 无 | 9 | 35°0′36″ | 116°0′36″ | 21 | B | 无 |
"""
    coords = parse_coordinates(valid)
    assert coords["center_lat"] == 35.005
    assert coords["center_lng"] == 116.005

    shifted = """## 坐标数据
| 序号 | 分组 | 测点类型 | 纬度 | 经度 | 海拔(m) | 测点说明 | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 9 | 35°0′0″ | 117°0′0″ | 193°0′0″ | 20 | A | 无 |
"""
    assert parse_coordinates(shifted)["center_lat"] is None


def test_parser_accepts_quxian_and_long_relocation_field(tmp_path):
    path = tmp_path / "370811-0001_测试遗址.md"
    path.write_text(
        _md(
            code="370811-0001",
            name="测试遗址",
            level="尚未核定公布为文物保护单位的不可移动文物",
            county="370882",
        ),
        encoding="utf-8",
    )
    row = parse_archive_md(path, group_name="兖州区")
    assert row["county"] == "兖州区"
    assert row["is_relocated"] == "否"
    assert row["center_lng"] is not None


def test_supplemental_import_only_appends_ungraded(tmp_path):
    paths = _paths(tmp_path)
    primary = paths.input_markdown / "任城区"
    supplemental = tmp_path / "data" / "supplemental" / "任城区"
    primary.mkdir(parents=True)
    supplemental.mkdir(parents=True)

    (primary / "370811-P001_在级遗址.md").write_text(
        _md(code="370811-P001", name="在级遗址", level="省级文物保护单位"),
        encoding="utf-8",
    )
    (supplemental / "370811-P001_在级遗址.md").write_text(
        _md(code="370811-P001", name="在级遗址", level="省级文物保护单位"),
        encoding="utf-8",
    )
    (supplemental / "370811-U001_未定级遗址.md").write_text(
        _md(
            code="370811-U001",
            name="未定级遗址",
            level="尚未核定公布为文物保护单位的不可移动文物",
        ),
        encoding="utf-8",
    )

    result = import_from_markdown(
        paths,
        {
            "data_import": {
                "include_ungraded_markdown": True,
                "ungraded_markdown_dir": "data/supplemental",
            },
            "geo": {"source_crs": "wgs84"},
            "administrative": {"full_tier_county": "嘉祥县"},
        },
    )
    assert result is not None
    relics, photos, drawings, boundaries = result
    assert [r["archive_code"] for r in relics] == ["370811-P001", "370811-U001"]
    assert [r["data_scope"] for r in relics] == ["protected", "ungraded"]
    assert photos == []
    assert drawings == []
    assert boundaries == []

    report = json.loads(
        (paths.output_dataset / "ungraded_import_report.json").read_text(encoding="utf-8")
    )
    assert report["supplemental_discovered"] == 2
    assert report["supplemental_protected_excluded"] == 1
    assert report["supplemental_ungraded_accepted"] == 1


def test_protected_repair_is_exact_allowlist_and_audited(tmp_path):
    paths = _paths(tmp_path)
    supplemental = tmp_path / "data" / "supplemental" / "任城区"
    supplemental.mkdir(parents=True)
    (supplemental / "P-REPAIR_修复点.md").write_text(
        _md(code="P-REPAIR", name="修复点", level="省级文物保护单位"),
        encoding="utf-8",
    )
    (supplemental / "P-EXCLUDED_普通在级点.md").write_text(
        _md(code="P-EXCLUDED", name="普通在级点", level="县级文物保护单位"),
        encoding="utf-8",
    )

    result = import_from_markdown(
        paths,
        {
            "data_import": {
                "ungraded_markdown_dir": "data/supplemental",
                "protected_repair_codes": ["P-REPAIR"],
                "protected_repair_level_overrides": {
                    "P-REPAIR": "市级文物保护单位",
                },
            },
            "geo": {"source_crs": "wgs84"},
        },
    )
    assert result is not None
    relics, *_ = result
    repair = [r for r in relics if r["archive_code"] == "P-REPAIR"]
    assert len(repair) == 1
    assert repair[0]["source_collection"] == "approved_protected_repair"
    assert repair[0]["heritage_level"] == "市级文物保护单位"
    assert all(r["archive_code"] != "P-EXCLUDED" for r in relics)

    merged, audit = _merge_protected_baseline(
        [
            {"archive_code": "|", "heritage_level": "县级文物保护单位"},
            {"archive_code": "P-KEEP", "heritage_level": "国家级文物保护单位"},
        ],
        repair,
        {"P-REPAIR"},
        {"|"},
    )
    assert [r["archive_code"] for r in merged] == ["P-KEEP", "P-REPAIR"]
    assert audit["protected_baseline_preserved"] == 1
    assert audit["protected_baseline_invalid_removed"] == ["|"]
    assert audit["protected_repair_codes"] == ["P-REPAIR"]


def test_two_line_matching_never_assigns_polygon_to_ungraded(monkeypatch):
    feature = {
        "type": "Feature",
        "properties": {
            "polyId": "line-1",
            "name": "同名遗址",
            "county": "任城区",
            "rangeType": 0,
        },
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[116.5, 35.4], [116.6, 35.4], [116.5, 35.5], [116.5, 35.4]]],
        },
    }
    monkeypatch.setattr(step01_import_relics, "_load_two_line_features", lambda: [feature])
    rows = [
        {
            "archive_code": "U1",
            "name": "同名遗址",
            "county": "任城区",
            "heritage_level": "尚未核定公布为文物保护单位的不可移动文物",
        },
        {
            "archive_code": "P1",
            "name": "同名遗址",
            "county": "任城区",
            "heritage_level": "县级文物保护单位",
        },
    ]

    matched = _match_two_lines(rows)
    assert len(matched) == 1
    assert matched[0]["properties"]["archive_code"] == "P1"
