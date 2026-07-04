from __future__ import annotations

from typing import Any

from codes import CATEGORY_CODES, RANK_CODES, SEARCH_TYPE_CODES


def row_to_legacy(row: Any, extra: dict | None) -> dict:
    """Map a DB relic row back to the legacy frontend field names."""
    data = dict(extra) if extra else {}
    data.update({
        "archive_code": row["code"],
        "name": row["name"],
        "category_main": CATEGORY_CODES.get(row["category"], "其他"),
        "heritage_level": RANK_CODES.get(row["rank"], ""),
        "survey_type": SEARCH_TYPE_CODES.get(row["search_type"] or "", row["search_type"] or ""),
        "center_lng": row["lng"],
        "center_lat": row["lat"],
        "center_alt": row["alt"],
        "township": row["township"] or "",
        "village": row["village"] or "",
        "address": row["address"] or "",
        "era": row["era"] or "",
        "era_stats": row["era_stats"] or "",
        "has_3d": bool(row["has_3d"]),
        "has_boundary": bool(row["has_boundary"]),
        "photo_count": row["photo_count"] or 0,
        "drawing_count": row["drawing_count"] or 0,
        "intro": row["brief"] or "",
        "_cat_code": row["category"],
        "_rank_code": row["rank"],
        "_version": row["version"] if "version" in row.keys() else 1,
    })
    return data
