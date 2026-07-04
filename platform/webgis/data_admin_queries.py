from __future__ import annotations

from typing import Iterable, Optional


def admin_neighbors(
    self,
    code: str,
    *,
    radius_m: float = 2000.0,
    limit: int = 20,
) -> list[dict]:
    """radius_m 米内的其它文物,按距离升序。
    排除自身与软删除;bbox 粗筛 + haversine 精算。"""
    if not self._use_db:
        return []
    import math
    conn = self._thread_conn()
    me = conn.execute(
        "SELECT lng, lat FROM relics WHERE code=?", (code,)
    ).fetchone()
    if not me or me["lng"] is None or me["lat"] is None:
        return []
    lng0 = float(me["lng"]); lat0 = float(me["lat"])
    # 1° lat ≈ 111 km,用度数粗算 bbox 边距。
    dlat = radius_m / 111_000.0
    dlng = radius_m / (111_000.0 * max(math.cos(math.radians(lat0)), 0.01))
    rows = conn.execute(
        """
        SELECT code, name, category, rank, lng, lat, township, village, era_stats
        FROM relics
        WHERE status >= 0 AND code <> ?
          AND lng IS NOT NULL AND lat IS NOT NULL
          AND lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?
        """,
        (code, lng0 - dlng, lng0 + dlng, lat0 - dlat, lat0 + dlat),
    ).fetchall()

    def _haversine(lng1, lat1, lng2, lat2) -> float:
        R = 6371_000.0
        p1 = math.radians(lat1); p2 = math.radians(lat2)
        dp = math.radians(lat2 - lat1); dl = math.radians(lng2 - lng1)
        a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
        return 2 * R * math.asin(math.sqrt(a))

    out: list[dict] = []
    for r in rows:
        d = _haversine(lng0, lat0, float(r["lng"]), float(r["lat"]))
        if d > radius_m:
            continue
        out.append({
            "code": r["code"],
            "name": r["name"],
            "category": r["category"],
            "rank": r["rank"],
            "lng": r["lng"],
            "lat": r["lat"],
            "township": r["township"] or "",
            "village": r["village"] or "",
            "era_stats": r["era_stats"] or "",
            "distance_m": round(d, 1),
        })
    out.sort(key=lambda x: x["distance_m"])
    return out[: max(1, min(int(limit), 200))]

def admin_list_relics(
    self,
    *,
    page: int = 1,
    size: int = 20,
    search: Optional[str] = None,
    categories: Optional[Iterable[str]] = None,
    ranks: Optional[Iterable[str]] = None,
    township: Optional[str] = None,
    search_type: Optional[str] = None,
    status: Optional[int] = None,
    bbox: Optional[tuple] = None,
    order_by: str = "updated_at_desc",
) -> dict:
    """后台分页列表。返回 {data, total, page, size}。

    search 同时匹配 code 前缀与 name 子串;
    status=None 返回 status>=0(正常 + 草稿),不含软删除。
    """
    if not self._use_db:
        # JSON 模式,仅内存列表分页。
        return self._admin_list_legacy(
            page=page, size=size, search=search,
            categories=categories, ranks=ranks,
            township=township, search_type=search_type,
        )

    where: list[str] = []
    params: list = []
    if search:
        where.append("(r.code LIKE ? OR r.name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if categories:
        cl = [str(v) for v in categories if v not in (None, "")]
        if cl:
            where.append(f"r.category IN ({','.join('?' for _ in cl)})")
            params.extend(cl)
    if ranks:
        rl = [str(v) for v in ranks if v not in (None, "")]
        if rl:
            where.append(f"r.rank IN ({','.join('?' for _ in rl)})")
            params.extend(rl)
    if township:
        where.append("r.township = ?")
        params.append(township)
    if search_type:
        where.append("r.search_type = ?")
        params.append(str(search_type))
    if status is None:
        where.append("r.status >= 0")
    else:
        where.append("r.status = ?")
        params.append(int(status))
    if bbox:
        try:
            mnl, mnt, mxl, mxt = [float(v) for v in bbox]
            if mnl > mxl: mnl, mxl = mxl, mnl
            if mnt > mxt: mnt, mxt = mxt, mnt
            where.append(
                "r.lng IS NOT NULL AND r.lat IS NOT NULL "
                "AND r.lng BETWEEN ? AND ? AND r.lat BETWEEN ? AND ?"
            )
            params.extend([mnl, mxl, mnt, mxt])
        except (TypeError, ValueError):
            pass

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    order_map = {
        "updated_at_desc": "r.updated_at DESC",
        "updated_at_asc":  "r.updated_at ASC",
        "code_asc":        "r.code ASC",
        "code_desc":       "r.code DESC",
        "name_asc":        "r.name ASC",
    }
    order_sql = order_map.get(order_by, "r.updated_at DESC")

    page = max(1, int(page))
    size = max(1, min(int(size), 200))
    offset = (page - 1) * size

    conn = self._thread_conn()
    total_row = conn.execute(
        f"SELECT COUNT(*) AS n FROM relics AS r{where_sql}", params,
    ).fetchone()
    total = int(total_row["n"]) if total_row else 0

    rows = conn.execute(
        f"""
        SELECT r.id, r.code, r.name, r.category, r.rank, r.search_type,
               r.lng, r.lat, r.township, r.village, r.era, r.era_stats,
               r.has_3d, r.has_pdf, r.has_photo, r.has_boundary,
               r.photo_count, r.drawing_count,
               r.status, r.version, r.updated_at
        FROM relics AS r{where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
        """,
        [*params, size, offset],
    ).fetchall()

    data = [
        {
            "id": r["id"],
            "code": r["code"],
            "name": r["name"],
            "category": r["category"],
            "rank": r["rank"],
            "search_type": r["search_type"] or "",
            "lng": r["lng"],
            "lat": r["lat"],
            "township": r["township"] or "",
            "village": r["village"] or "",
            "era": r["era"] or "",
            "era_stats": r["era_stats"] or "",
            "has_3d": bool(r["has_3d"]),
            "has_pdf": bool(r["has_pdf"]),
            "has_photo": bool(r["has_photo"]),
            "has_boundary": bool(r["has_boundary"]),
            "photo_count": r["photo_count"] or 0,
            "drawing_count": r["drawing_count"] or 0,
            "status": r["status"],
            "version": r["version"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]
    return {"data": data, "total": total, "page": page, "size": size}

def _admin_list_legacy(
    self, *, page, size, search, categories, ranks,
    township, search_type,
) -> dict:
    """JSON 模式下的简易分页,仅适用于小规模 demo。"""
    from codes import normalize_category, normalize_rank, normalize_search_type
    rank_set = {str(v) for v in ranks} if ranks else None
    cat_set = {str(v) for v in categories} if categories else None
    s = (search or "").strip()
    out = []
    for r in self.relics:
        code = (r.get("archive_code") or "").strip()
        name = (r.get("name") or "").strip()
        if s and s not in code and s not in name:
            continue
        c = normalize_category(r.get("category_main"))
        rk = normalize_rank(r.get("heritage_level"))
        st = normalize_search_type(r.get("survey_type"))
        if cat_set and c not in cat_set:
            continue
        if rank_set and rk not in rank_set:
            continue
        if township and (r.get("township") or "") != township:
            continue
        if search_type and st != str(search_type):
            continue
        out.append({
            "id": code,
            "code": code,
            "name": name,
            "category": c,
            "rank": rk,
            "search_type": st,
            "lng": r.get("center_lng"),
            "lat": r.get("center_lat"),
            "township": r.get("township") or "",
            "village": r.get("village") or "",
            "era": r.get("era") or "",
            "era_stats": r.get("era_stats") or "",
            "has_3d": bool(r.get("has_3d")),
            "has_pdf": False,
            "has_photo": (r.get("photo_count") or 0) > 0,
            "has_boundary": bool(r.get("has_boundary")),
            "photo_count": r.get("photo_count") or 0,
            "drawing_count": r.get("drawing_count") or 0,
            "status": 1,
            "version": 1,
            "updated_at": None,
        })
    total = len(out)
    page = max(1, int(page)); size = max(1, min(int(size), 200))
    lo = (page - 1) * size
    return {"data": out[lo:lo + size], "total": total, "page": page, "size": size}

def admin_export_relics(
    self,
    *,
    search: Optional[str] = None,
    categories: Optional[Iterable[str]] = None,
    ranks: Optional[Iterable[str]] = None,
    township: Optional[str] = None,
    search_type: Optional[str] = None,
    status: Optional[int] = None,
    codes: Optional[Iterable[str]] = None,
    bbox: Optional[tuple] = None,
    order_by: str = "code_asc",
) -> Iterable[dict]:
    """按条件/显式 code 列表导出,生成器形式(适合流式写 CSV)。

    给出 codes 时忽略其它筛选,按列表精确导出;不分页,调用方自行节流。
    """
    if not self._use_db:
        # JSON 模式:内存分页迭代。
        def _gen_legacy():
            page = 1
            while True:
                r = self._admin_list_legacy(
                    page=page, size=200, search=search,
                    categories=categories, ranks=ranks,
                    township=township, search_type=search_type,
                )
                for row in r["data"]:
                    yield row
                if page * r["size"] >= r["total"]:
                    break
                page += 1
        yield from _gen_legacy()
        return

    conn = self._thread_conn()
    codes_list = [str(c).strip() for c in (codes or []) if str(c).strip()]

    where: list[str] = []
    params: list = []
    if codes_list:
        where.append(f"r.code IN ({','.join('?' for _ in codes_list)})")
        params.extend(codes_list)
    else:
        if search:
            where.append("(r.code LIKE ? OR r.name LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        if categories:
            cl = [str(v) for v in categories if v not in (None, "")]
            if cl:
                where.append(f"r.category IN ({','.join('?' for _ in cl)})")
                params.extend(cl)
        if ranks:
            rl = [str(v) for v in ranks if v not in (None, "")]
            if rl:
                where.append(f"r.rank IN ({','.join('?' for _ in rl)})")
                params.extend(rl)
        if township:
            where.append("r.township = ?")
            params.append(township)
        if search_type:
            where.append("r.search_type = ?")
            params.append(str(search_type))
        if status is None:
            where.append("r.status >= 0")
        else:
            where.append("r.status = ?")
            params.append(int(status))
        if bbox:
            try:
                mnl, mnt, mxl, mxt = [float(v) for v in bbox]
                if mnl > mxl: mnl, mxl = mxl, mnl
                if mnt > mxt: mnt, mxt = mxt, mnt
                where.append(
                    "r.lng IS NOT NULL AND r.lat IS NOT NULL "
                    "AND r.lng BETWEEN ? AND ? AND r.lat BETWEEN ? AND ?"
                )
                params.extend([mnl, mxl, mnt, mxt])
            except (TypeError, ValueError):
                pass

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    order_map = {
        "updated_at_desc": "r.updated_at DESC",
        "updated_at_asc":  "r.updated_at ASC",
        "code_asc":        "r.code ASC",
        "code_desc":       "r.code DESC",
        "name_asc":        "r.name ASC",
    }
    order_sql = order_map.get(order_by, "r.code ASC")
    cur = conn.execute(
        f"""
        SELECT r.code, r.name, r.category, r.rank, r.search_type,
               r.era, r.era_stats,
               r.lng, r.lat, r.alt,
               r.township, r.village, r.address,
               r.has_3d, r.has_pdf, r.has_photo, r.has_boundary,
               r.photo_count, r.drawing_count,
               r.brief, r.status, r.version, r.updated_at
        FROM relics AS r{where_sql}
        ORDER BY {order_sql}
        """,
        params,
    )
    for r in cur:
        yield {k: r[k] for k in r.keys()}

def admin_list_townships(self) -> list[str]:
    """DB 中出现过的乡镇列表(去重排序),供筛选下拉使用。"""
    if not self._use_db:
        return sorted({(r.get("township") or "").strip() for r in self.relics if r.get("township")})
    conn = self._thread_conn()
    rows = conn.execute(
        "SELECT DISTINCT township FROM relics WHERE township IS NOT NULL AND township <> '' ORDER BY township"
    ).fetchall()
    return [r["township"] for r in rows]
