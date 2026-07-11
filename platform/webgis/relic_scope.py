"""“文保单位 / 全部文物”统一业务口径。

scope 与历史 tier 完全独立：
- protected: 仅 rank 1..4（国/省/市/县级文保单位）
- all:       rank 1..5（再包含未定级不可移动文物）
"""
from __future__ import annotations

from collections.abc import Iterable

from codes import normalize_rank

SCOPE_PROTECTED = "protected"
SCOPE_ALL = "all"
PROTECTED_RANKS = frozenset({"1", "2", "3", "4"})
VALID_SCOPES = frozenset({SCOPE_PROTECTED, SCOPE_ALL})


def normalize_relic_scope(value: str | None) -> str:
    """把兼容别名归一到 canonical scope；非法值抛 ValueError。"""
    raw = (value or SCOPE_PROTECTED).strip().lower()
    if raw in {"designated", "protected", "protection"}:
        return SCOPE_PROTECTED
    if raw == SCOPE_ALL:
        return SCOPE_ALL
    raise ValueError(f"无效数据范围 {value!r}，应为 protected 或 all")


def relic_rank_code(relic: dict) -> str:
    raw = relic.get("_rank_code") or relic.get("rank_code") or relic.get("rank")
    code = str(raw or "").strip()
    if code in {"1", "2", "3", "4", "5"}:
        return code
    return normalize_rank(relic.get("heritage_level"))


def relic_in_scope(relic: dict, scope: str | None) -> bool:
    canonical = normalize_relic_scope(scope)
    return canonical == SCOPE_ALL or relic_rank_code(relic) in PROTECTED_RANKS


def filter_relics(relics: Iterable[dict], scope: str | None) -> list[dict]:
    canonical = normalize_relic_scope(scope)
    if canonical == SCOPE_ALL:
        return list(relics)
    return [r for r in relics if relic_rank_code(r) in PROTECTED_RANKS]


def scope_counts(relics: Iterable[dict]) -> dict[str, int]:
    rows = list(relics)
    protected = sum(1 for r in rows if relic_rank_code(r) in PROTECTED_RANKS)
    return {
        "all": len(rows),
        "protected": protected,
        "ungraded": len(rows) - protected,
    }
