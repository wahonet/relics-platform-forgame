from __future__ import annotations

from data_serializers import row_to_legacy


class FakeRow(dict):
    def keys(self):
        return super().keys()


def test_row_to_legacy_maps_db_fields_to_frontend_shape():
    row = FakeRow({
        "code": "A001",
        "name": "Test Relic",
        "category": "ancient_building",
        "rank": "county",
        "county": "嘉祥县",
        "tier": "full",
        "condition": "较好",
        "has_archive_spu": 1,
        "has_archive_fpu": 1,
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
    assert legacy["county"] == "嘉祥县"
    assert legacy["tier"] == "full"
    assert legacy["condition_level"] == "较好"
    assert legacy["has_archive_spu"] is True
    assert legacy["has_archive_fpu"] is True
    assert legacy["_version"] == 3
    assert legacy["custom"] == "value"
