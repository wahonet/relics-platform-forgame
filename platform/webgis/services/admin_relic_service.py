"""Service helpers for admin relic management.

The router keeps HTTP-specific concerns; this module owns reusable payload
normalization, import/export shaping, and batch-operation validation.
"""
from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path
from typing import Iterable, Optional

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from codes import (  # noqa: E402
    CATEGORY_CODES,
    RANK_CODES,
    SEARCH_TYPE_CODES,
    normalize_category,
    normalize_rank,
    normalize_search_type,
)

EXPORT_FIELDNAMES = [
    "code", "name",
    "category", "category_label",
    "rank", "rank_label",
    "search_type", "search_type_label",
    "era", "era_stats",
    "lng", "lat", "alt",
    "township", "village", "address",
    "has_3d", "has_pdf", "has_photo", "has_boundary",
    "photo_count", "drawing_count",
    "status", "version", "updated_at",
    "brief",
]


def normalize_relic_payload(raw: dict) -> dict:
    """Normalize legacy and Chinese fields to DB-facing payload keys."""
    p = dict(raw or {})
    if "category_main" in p and "category" not in p:
        p["category"] = normalize_category(p.pop("category_main"))
    elif "category" in p:
        p["category"] = normalize_category(p["category"])
    if "heritage_level" in p and "rank" not in p:
        p["rank"] = normalize_rank(p.pop("heritage_level"))
    elif "rank" in p:
        p["rank"] = normalize_rank(p["rank"])
    if "survey_type" in p and "search_type" not in p:
        p["search_type"] = normalize_search_type(p.pop("survey_type"))

    if "center_lng" in p and "lng" not in p:
        p["lng"] = p.pop("center_lng")
    if "center_lat" in p and "lat" not in p:
        p["lat"] = p.pop("center_lat")
    if "center_alt" in p and "alt" not in p:
        p["alt"] = p.pop("center_alt")
    if "archive_code" in p and "code" not in p:
        p["code"] = p.pop("archive_code")
    return p


def parse_bbox(bbox: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    """Parse 'minLng,minLat,maxLng,maxLat'; invalid input returns None."""
    if not bbox:
        return None
    parts = [p.strip() for p in bbox.split(",") if p.strip()]
    if len(parts) != 4:
        return None
    try:
        mnl, mnt, mxl, mxt = [float(p) for p in parts]
    except ValueError:
        return None
    return (mnl, mnt, mxl, mxt)


def split_csv_values(value: Optional[str]) -> Optional[list[str]]:
    items = [c.strip() for c in (value or "").split(",") if c.strip()]
    return items or None


def codes_payload() -> dict:
    """Return national-code dictionaries in the existing API shape."""
    return {
        "categories": [{"code": c, "label": CATEGORY_CODES[c]} for c in CATEGORY_CODES],
        "ranks": [{"code": c, "label": RANK_CODES[c]} for c in RANK_CODES],
        "search_types": [{"code": c, "label": SEARCH_TYPE_CODES[c]} for c in SEARCH_TYPE_CODES],
    }


def bulk_update_payload(payload: dict) -> tuple[list[str], dict]:
    codes = payload.get("codes") or []
    fields = payload.get("fields") or {}
    if not isinstance(codes, list) or not codes:
        raise ValueError("codes 不能为空")
    if not isinstance(fields, dict) or not fields:
        raise ValueError("fields 不能为空")
    patch = normalize_relic_payload(fields)
    patch.pop("code", None)
    return codes, patch


def bulk_status_payload(payload: dict) -> tuple[list[str], int]:
    codes = payload.get("codes") or []
    status = payload.get("status")
    if not isinstance(codes, list) or not codes:
        raise ValueError("codes 不能为空")
    if status not in (1, 0, -1):
        raise ValueError("status 只能是 1 / 0 / -1")
    return codes, int(status)


def iter_export_csv(rows: Iterable[dict]) -> Iterable[str]:
    """Yield CSV chunks with UTF-8 BOM for Excel-friendly downloads."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=EXPORT_FIELDNAMES, extrasaction="ignore")
    yield "\ufeff"
    writer.writeheader()
    yield buf.getvalue()
    buf.seek(0)
    buf.truncate(0)

    for r in rows:
        row = dict(r)
        row["category_label"] = CATEGORY_CODES.get(str(row.get("category") or ""), "")
        row["rank_label"] = RANK_CODES.get(str(row.get("rank") or ""), "")
        row["search_type_label"] = SEARCH_TYPE_CODES.get(str(row.get("search_type") or ""), "")
        for k in ("has_3d", "has_pdf", "has_photo", "has_boundary"):
            row[k] = 1 if row.get(k) else 0
        writer.writerow(row)
        yield buf.getvalue()
        buf.seek(0)
        buf.truncate(0)


def parse_import_items(filename: str, raw: bytes) -> list[dict]:
    """Parse uploaded CSV/JSON bytes into row dictionaries."""
    if not raw:
        raise ValueError("空文件")

    name = (filename or "").lower()
    if name.endswith(".json"):
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON 解析失败: {e}") from e
        if not isinstance(data, list):
            raise ValueError("JSON 顶层需是数组")
        return data

    if name.endswith(".csv"):
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        return list(reader)

    raise ValueError("仅支持 .csv / .json")


def import_relic_items(store_obj, items: list[dict], mode: str, actor: str) -> dict:
    """Import rows into the given store using existing create/update methods."""
    results = {"created": 0, "updated": 0, "skipped": 0, "failed": 0, "errors": []}
    for idx, raw_row in enumerate(items, start=1):
        p = normalize_relic_payload(raw_row)
        code = (p.get("code") or "").strip()
        if not code:
            results["skipped"] += 1
            continue
        try:
            existing = store_obj.get_relic(code)
            if existing:
                if mode == "create_only":
                    results["skipped"] += 1
                    continue
                ev = existing.get("_version")
                if ev is None:
                    row = store_obj._thread_conn().execute(
                        "SELECT version FROM relics WHERE code = ?", (code,)
                    ).fetchone()
                    ev = int(row["version"]) if row else 1
                store_obj.update_relic(code, p, expected_version=int(ev), actor=actor)
                results["updated"] += 1
            else:
                store_obj.create_relic(p, actor=actor)
                results["created"] += 1
        except Exception as e:
            results["failed"] += 1
            results["errors"].append({"line": idx, "code": code, "error": str(e)})
            if len(results["errors"]) > 50:
                break

    return results

