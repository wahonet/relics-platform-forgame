from __future__ import annotations

from pathlib import Path

from data_serializers import row_to_legacy
from survey_coverage import load_survey_routes


class DummyLogger:
    def info(self, *args, **kwargs):
        pass

    def warning(self, *args, **kwargs):
        pass


class FakeRow(dict):
    def keys(self):
        return super().keys()


def test_row_to_legacy_maps_db_fields_to_frontend_shape():
    row = FakeRow({
        "code": "A001",
        "name": "Test Relic",
        "category": "ancient_building",
        "rank": "county",
        "search_type": "third",
        "lng": 120.1,
        "lat": 30.2,
        "alt": 5,
        "township": "Town",
        "village": "",
        "address": "Address",
        "era": "Ming",
        "era_stats": "Ming",
        "has_3d": 1,
        "has_boundary": 0,
        "photo_count": 2,
        "drawing_count": 1,
        "brief": "Intro",
        "version": 3,
    })

    legacy = row_to_legacy(row, {"custom": "value"})

    assert legacy["archive_code"] == "A001"
    assert legacy["center_lng"] == 120.1
    assert legacy["has_3d"] is True
    assert legacy["_version"] == 3
    assert legacy["custom"] == "value"


def test_load_survey_routes_normalizes_dates_and_filters_bounds():
    rows = [
        {"filename": "b.jpg", "datetime": "2026/5/2 9:03", "lat": "30.2", "lng": "120.2"},
        {"filename": "a.jpg", "datetime": "2026/5/2 08:01:02", "lat": "30.1", "lng": "120.1"},
        {"filename": "outside.jpg", "datetime": "2026/5/2 10:00", "lat": "35", "lng": "120.1"},
        {"filename": "bad.jpg", "datetime": "2026/5/2 10:00", "lat": "bad", "lng": "120.1"},
    ]

    routes = load_survey_routes(
        path=Path("unused.csv"),
        bounds=(119.0, 29.0, 121.0, 31.0),
        read_csv=lambda _path: rows,
        log=DummyLogger(),
    )

    assert list(routes) == ["2026-05-02"]
    assert [point["filename"] for point in routes["2026-05-02"]] == ["a.jpg", "b.jpg"]
    assert routes["2026-05-02"][1]["time"] == "09:03:00"
