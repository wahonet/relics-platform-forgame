from __future__ import annotations

import csv
import io

from services import admin_relic_service as svc


class FakeStore:
    def __init__(self):
        self.rows = {
            "A001": {"code": "A001", "_version": 2},
        }
        self.created = []
        self.updated = []

    def get_relic(self, code):
        return self.rows.get(code)

    def update_relic(self, code, payload, expected_version, actor):
        self.updated.append((code, payload, expected_version, actor))

    def create_relic(self, payload, actor):
        self.created.append((payload, actor))


def test_normalize_relic_payload_accepts_legacy_fields():
    payload = svc.normalize_relic_payload(
        {
            "archive_code": "A001",
            "center_lng": "116.1",
            "center_lat": "35.2",
            "center_alt": "42",
            "category": "0300",
            "rank": "5",
        }
    )

    assert payload["code"] == "A001"
    assert payload["lng"] == "116.1"
    assert payload["lat"] == "35.2"
    assert payload["alt"] == "42"
    assert payload["category"] == "0300"
    assert payload["rank"] == "5"


def test_parse_bbox_and_csv_filters_are_tolerant():
    assert svc.parse_bbox("1, 2,3,4") == (1.0, 2.0, 3.0, 4.0)
    assert svc.parse_bbox("1,2,3") is None
    assert svc.parse_bbox("bad") is None
    assert svc.split_csv_values(" a, ,b ") == ["a", "b"]
    assert svc.split_csv_values("") is None


def test_bulk_payload_validation_removes_code_from_patch():
    codes, patch = svc.bulk_update_payload(
        {"codes": ["A001"], "fields": {"code": "B002", "rank": "5"}}
    )

    assert codes == ["A001"]
    assert patch == {"rank": "5"}


def test_parse_import_items_supports_csv_and_json():
    csv_rows = svc.parse_import_items("items.csv", b"\xef\xbb\xbfcode,name\nA001,Alpha\n")
    json_rows = svc.parse_import_items("items.json", b'[{"code":"B002","name":"Beta"}]')

    assert csv_rows == [{"code": "A001", "name": "Alpha"}]
    assert json_rows == [{"code": "B002", "name": "Beta"}]


def test_iter_export_csv_adds_labels_and_boolean_flags():
    chunks = list(
        svc.iter_export_csv(
            [
                {
                    "code": "A001",
                    "name": "Alpha",
                    "category": "0300",
                    "rank": "5",
                    "search_type": "2",
                    "has_3d": True,
                    "has_pdf": False,
                }
            ]
        )
    )

    text = "".join(chunks).lstrip("\ufeff")
    row = next(csv.DictReader(io.StringIO(text)))
    assert row["category_label"]
    assert row["rank_label"]
    assert row["search_type_label"]
    assert row["has_3d"] == "1"
    assert row["has_pdf"] == "0"


def test_import_relic_items_updates_existing_and_creates_new():
    store = FakeStore()
    result = svc.import_relic_items(
        store,
        [{"code": "A001", "name": "Alpha 2"}, {"code": "B002", "name": "Beta"}],
        mode="upsert",
        actor="tester",
    )

    assert result["updated"] == 1
    assert result["created"] == 1
    assert store.updated == [("A001", {"code": "A001", "name": "Alpha 2"}, 2, "tester")]
    assert store.created == [({"code": "B002", "name": "Beta"}, "tester")]

