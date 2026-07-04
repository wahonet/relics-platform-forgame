"""统计 API:基础统计 + 数据要素门面大屏聚合。"""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import APIRouter

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from data_loader import store  # noqa: E402

router = APIRouter(tags=["统计"])

_RANK_ORDER = ["全国重点文物保护单位", "省级文物保护单位", "市级文物保护单位",
               "县级文物保护单位", "尚未核定公布为文物保护单位的不可移动文物"]
_COND_ORDER = ["好", "较好", "一般", "较差", "差"]

# 年代归一化:原始年代字符串包含关键字 → 标准分期(展示按 _ERA_ORDER)
_ERA_ORDER = ["史前", "夏商周", "秦汉", "魏晋南北朝", "隋唐五代", "宋金元", "明", "清", "近现代"]
# 匹配顺序与展示顺序不同:魏晋南北朝先于夏商周,避免"北周/北魏"误中"周/魏"泛匹配。
_ERA_KEYWORDS = [
    ("史前", ("新石器", "龙山", "大汶口", "北辛", "细石器", "岳石")),
    ("魏晋南北朝", ("三国", "晋", "北魏", "东魏", "西魏", "北齐", "北周", "南北朝", "魏")),
    ("夏商周", ("夏", "商", "西周", "东周", "春秋", "战国", "周")),
    ("秦汉", ("秦", "西汉", "东汉", "汉")),
    ("隋唐五代", ("隋", "唐", "五代")),
    ("宋金元", ("北宋", "南宋", "宋", "辽", "金", "元")),
    ("明", ("明",)),
    ("清", ("清",)),
    ("近现代", ("民国", "近现代", "现代", "19", "20")),
]


def _era_bucket(raw: str) -> str:
    """把"明、清"/"1938年"等原始年代归到标准分期(取最早命中的分期)。"""
    if not raw:
        return "未知"
    for bucket, kws in _ERA_KEYWORDS:
        for kw in kws:
            if kw in raw:
                return bucket
    return "未知"


@router.get("/stats")
async def stats():
    return store.compute_stats()


@router.get("/stats/dashboard")
async def stats_dashboard():
    """数据要素门面大屏一次性聚合。"""
    relics = store.relics
    total = len(relics)

    by_rank: dict[str, int] = {}
    by_county: dict[str, int] = {}
    by_category: dict[str, int] = {}
    by_condition: dict[str, int] = {}
    by_era: dict[str, int] = {}
    tier_city = 0
    tier_full = 0
    n_3d = n_boundary = n_intro = n_photo = n_spu = n_fpu = 0

    for r in relics:
        by_rank[r.get("heritage_level") or "未知"] = by_rank.get(r.get("heritage_level") or "未知", 0) + 1
        by_county[r.get("county") or "未知"] = by_county.get(r.get("county") or "未知", 0) + 1
        by_category[r.get("category_main") or "其他"] = by_category.get(r.get("category_main") or "其他", 0) + 1
        by_condition[r.get("condition_level") or "未知"] = by_condition.get(r.get("condition_level") or "未知", 0) + 1
        era = _era_bucket(r.get("era_stats") or r.get("era") or "")
        by_era[era] = by_era.get(era, 0) + 1
        if (r.get("tier") or "city") == "full":
            tier_full += 1
        else:
            tier_city += 1
        if r.get("has_3d"):
            n_3d += 1
        if r.get("has_boundary"):
            n_boundary += 1
        if r.get("intro"):
            n_intro += 1
        if (r.get("photo_count") or 0) > 0:
            n_photo += 1
        if r.get("has_archive_spu"):
            n_spu += 1
        if r.get("has_archive_fpu"):
            n_fpu += 1

    designated = sum(v for k, v in by_rank.items() if k in _RANK_ORDER[:4])

    def _pct(n: int) -> float:
        return round(n / total * 100, 1) if total else 0.0

    completeness = {
        "coords": 100.0,
        "intro": _pct(n_intro),
        "photo": _pct(n_photo),
        "boundary_of_designated": round(n_boundary / designated * 100, 1) if designated else 0.0,
        "condition": _pct(sum(v for k, v in by_condition.items() if k in _COND_ORDER)),
    }
    quality_score = round(sum(completeness.values()) / len(completeness), 1)

    return {
        "total": total,
        "designated_total": designated,
        "tier": {"city": tier_city, "full": tier_full},
        "by_rank": [{"name": k, "value": by_rank.get(k, 0)} for k in _RANK_ORDER if by_rank.get(k)],
        "by_county": sorted(
            ({"name": k, "value": v} for k, v in by_county.items()),
            key=lambda x: -x["value"],
        ),
        "by_category": sorted(
            ({"name": k, "value": v} for k, v in by_category.items()),
            key=lambda x: -x["value"],
        ),
        "by_condition": [{"name": k, "value": by_condition.get(k, 0)} for k in _COND_ORDER],
        "by_era": (
            [{"name": k, "value": by_era[k]} for k in _ERA_ORDER if by_era.get(k)]
            + ([{"name": "未知", "value": by_era["未知"]}] if by_era.get("未知") else [])
        ),
        "assets": {
            "photos": len(store.photo_index),
            "drawings": len(store.drawing_index),
            "models_3d": n_3d,
            "archive_spu": n_spu,
            "archive_fpu": n_fpu,
            "boundaries": n_boundary,
        },
        "completeness": completeness,
        "quality_score": quality_score,
    }
