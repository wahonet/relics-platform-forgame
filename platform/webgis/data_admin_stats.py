from __future__ import annotations


def admin_stats_overview(self) -> dict:
    """后台首页聚合指标,尽量一次 SQL 拿齐。

    返回字段:
      totals              总数/3D/PDF/照片/有边界/草稿/删除
      by_category         大类分布 [{code,label,count}]
      by_rank             保护级别分布
      by_search_type      普查来源分布
      by_township_top     乡镇 Top15
      by_era_stats_top    年代 Top8
      audit_14days        近 14 天按日 × 动作统计
      audit_recent        最近 10 条审计
      last_updated        数据库最近更新秒时间戳
    """
    if not self._use_db:
        return self._admin_stats_legacy()

    conn = self._thread_conn()

    # ── 总数 + 布尔字段计数(一条 SQL) ────────────────
    t = conn.execute(
        """
        SELECT
            SUM(CASE WHEN status = 1  THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status = 0  THEN 1 ELSE 0 END) AS drafts,
            SUM(CASE WHEN status = -1 THEN 1 ELSE 0 END) AS deleted,
            SUM(CASE WHEN status = 1 AND has_3d = 1       THEN 1 ELSE 0 END) AS has_3d,
            SUM(CASE WHEN status = 1 AND has_pdf = 1      THEN 1 ELSE 0 END) AS has_pdf,
            SUM(CASE WHEN status = 1 AND has_photo = 1    THEN 1 ELSE 0 END) AS has_photo,
            SUM(CASE WHEN status = 1 AND has_boundary = 1 THEN 1 ELSE 0 END) AS has_boundary,
            MAX(updated_at) AS last_updated
        FROM relics
        """,
    ).fetchone()
    totals = {
        "total":        int(t["total"] or 0),
        "drafts":       int(t["drafts"] or 0),
        "deleted":      int(t["deleted"] or 0),
        "has_3d":       int(t["has_3d"] or 0),
        "has_pdf":      int(t["has_pdf"] or 0),
        "has_photo":    int(t["has_photo"] or 0),
        "has_boundary": int(t["has_boundary"] or 0),
    }
    last_updated = int(t["last_updated"] or 0)

    # ── 类别 / 级别 / 普查来源 分布 ──────────────────
    from codes import CATEGORY_CODES, RANK_CODES, SEARCH_TYPE_CODES

    def _count_group(col: str) -> dict:
        rows = conn.execute(
            f"SELECT {col} AS k, COUNT(*) AS n FROM relics WHERE status = 1 GROUP BY {col}"
        ).fetchall()
        return {str(r["k"] or ""): int(r["n"]) for r in rows}

    cat_counts = _count_group("category")
    rank_counts = _count_group("rank")
    st_counts = _count_group("search_type")

    by_category = [
        {"code": c, "label": CATEGORY_CODES[c], "count": cat_counts.get(c, 0)}
        for c in CATEGORY_CODES
    ]
    by_rank = [
        {"code": c, "label": RANK_CODES[c], "count": rank_counts.get(c, 0)}
        for c in RANK_CODES
    ]
    by_search_type = [
        {"code": c, "label": SEARCH_TYPE_CODES[c], "count": st_counts.get(c, 0)}
        for c in SEARCH_TYPE_CODES
    ]

    # ── 乡镇 Top15 ─────────────────────────────────
    rows = conn.execute(
        """
        SELECT township AS k, COUNT(*) AS n FROM relics
        WHERE status = 1 AND township IS NOT NULL AND township <> ''
        GROUP BY township ORDER BY n DESC LIMIT 15
        """,
    ).fetchall()
    by_township_top = [{"name": r["k"], "count": int(r["n"])} for r in rows]

    # ── 年代 Top8 ─────────────────────────────────
    rows = conn.execute(
        """
        SELECT era_stats AS k, COUNT(*) AS n FROM relics
        WHERE status = 1 AND era_stats IS NOT NULL AND era_stats <> ''
        GROUP BY era_stats ORDER BY n DESC LIMIT 8
        """,
    ).fetchall()
    by_era_stats_top = [{"name": r["k"], "count": int(r["n"])} for r in rows]

    # ── 近 14 天审计变更(按日按动作) ──────────────
    import time as _time
    now = int(_time.time())
    start = now - 13 * 86400
    # 使用 sqlite localtime 分桶,前端直接消费不再二次转换。
    rows = conn.execute(
        """
        SELECT
            strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
            action,
            COUNT(*) AS n
        FROM audit_log
        WHERE ts >= ?
        GROUP BY day, action
        """,
        (start,),
    ).fetchall()
    # 补齐 14 天完整序列,缺失日填 0。
    import datetime as _dt
    today = _dt.date.fromtimestamp(now)
    days = [(today - _dt.timedelta(days=13 - i)).isoformat() for i in range(14)]
    action_map = {"create": {}, "update": {}, "delete": {}}
    for r in rows:
        act = r["action"] or "update"
        if act not in action_map:
            action_map[act] = {}
        action_map[act][r["day"]] = int(r["n"])
    audit_14days = {
        "days": days,
        "create": [action_map["create"].get(d, 0) for d in days],
        "update": [action_map["update"].get(d, 0) for d in days],
        "delete": [action_map["delete"].get(d, 0) for d in days],
    }

    # ── 最近 10 条审计 ─────────────────────────────
    rows = conn.execute(
        """
        SELECT a.id, a.ts, a.actor, a.action, a.relic_code, r.name
        FROM audit_log a
        LEFT JOIN relics r ON r.code = a.relic_code
        ORDER BY a.id DESC LIMIT 10
        """,
    ).fetchall()
    audit_recent = [
        {
            "id": r["id"],
            "ts": r["ts"],
            "actor": r["actor"] or "",
            "action": r["action"] or "",
            "relic_code": r["relic_code"] or "",
            "relic_name": r["name"] or "",
        }
        for r in rows
    ]

    return {
        "totals": totals,
        "by_category": by_category,
        "by_rank": by_rank,
        "by_search_type": by_search_type,
        "by_township_top": by_township_top,
        "by_era_stats_top": by_era_stats_top,
        "audit_14days": audit_14days,
        "audit_recent": audit_recent,
        "last_updated": last_updated,
    }

def _admin_stats_legacy(self) -> dict:
    """JSON 模式 fallback,从内存 relics 现算(字段能少则少)。"""
    from codes import CATEGORY_CODES, RANK_CODES, SEARCH_TYPE_CODES
    from codes import normalize_category, normalize_rank, normalize_search_type

    total = len(self.relics)
    has_3d = sum(1 for r in self.relics if r.get("has_3d"))
    has_boundary = sum(1 for r in self.relics if r.get("has_boundary"))
    has_photo = sum(1 for r in self.relics if (r.get("photo_count") or 0) > 0)

    cat_counts: dict[str, int] = {}
    rank_counts: dict[str, int] = {}
    st_counts: dict[str, int] = {}
    twp_counts: dict[str, int] = {}
    era_counts: dict[str, int] = {}
    for r in self.relics:
        cat_counts[normalize_category(r.get("category_main"))] = cat_counts.get(normalize_category(r.get("category_main")), 0) + 1
        rank_counts[normalize_rank(r.get("heritage_level"))] = rank_counts.get(normalize_rank(r.get("heritage_level")), 0) + 1
        st = normalize_search_type(r.get("survey_type"))
        st_counts[st] = st_counts.get(st, 0) + 1
        t = (r.get("township") or "").strip()
        if t:
            twp_counts[t] = twp_counts.get(t, 0) + 1
        e = (r.get("era_stats") or "").strip()
        if e:
            era_counts[e] = era_counts.get(e, 0) + 1

    return {
        "totals": {
            "total": total, "drafts": 0, "deleted": 0,
            "has_3d": has_3d, "has_pdf": 0,
            "has_photo": has_photo, "has_boundary": has_boundary,
        },
        "by_category": [
            {"code": c, "label": CATEGORY_CODES[c], "count": cat_counts.get(c, 0)}
            for c in CATEGORY_CODES
        ],
        "by_rank": [
            {"code": c, "label": RANK_CODES[c], "count": rank_counts.get(c, 0)}
            for c in RANK_CODES
        ],
        "by_search_type": [
            {"code": c, "label": SEARCH_TYPE_CODES[c], "count": st_counts.get(c, 0)}
            for c in SEARCH_TYPE_CODES
        ],
        "by_township_top": [
            {"name": k, "count": v}
            for k, v in sorted(twp_counts.items(), key=lambda x: -x[1])[:15]
        ],
        "by_era_stats_top": [
            {"name": k, "count": v}
            for k, v in sorted(era_counts.items(), key=lambda x: -x[1])[:8]
        ],
        "audit_14days": {"days": [], "create": [], "update": [], "delete": []},
        "audit_recent": [],
        "last_updated": 0,
    }
