"""全局数据容器 (Repository)。

启动时检测 `data/output/dataset/relics.db`:存在则走 SQLite 模式,同时把全量记录
缓存到 `self.relics` 以兼容旧路由;不存在则回退 JSON 模式(全量内存)。

新路由优先使用 `store.query_bbox()` / `store.search_fulltext()`,
仅在需要全量时才使用 `store.relics`。

向后兼容接口：
    store.relics / store.relics_map
    store.photo_index / store.photo_map
    store.drawing_index / store.drawing_map
    store.geojson_points / store.geojson_polygons
    store.township_stats / store.survey_routes / store.village_coverage
    store.pdf_map
    store.load() / store.get_relic() / store.get_photos() / store.get_drawings()
    store.get_relics_summary() / store.compute_stats()

DB 模式专用接口：
    store.query_bbox(...)        视口查询(极简 8 字段)
    store.search_fulltext(...)   FTS5 全文搜索
    store.get_relic_full(code)   单条完整详情(含 extra_json 合并)
    store.polygon_of(code)       单条多边形几何
"""
from __future__ import annotations

import csv
import json
import logging
import sqlite3
import sys
import threading
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("uvicorn.error")

# 兜底一次 scripts/ 路径,避免单测直接 import data_loader 时找不到 codes.py。
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from data_serializers import row_to_legacy  # noqa: E402
from survey_coverage import compute_village_coverage, load_survey_routes  # noqa: E402
import data_admin_queries  # noqa: E402
import data_admin_stats  # noqa: E402



class DataStore:
    """SQLite (推荐) / JSON (fallback) 双模式的数据容器。
    `_use_db=True` 时查询走 DB,`self.relics` 仍会被填充以兼容旧接口。"""

    def __init__(self) -> None:
        self.relics: list[dict] = []
        self.relics_map: dict[str, dict] = {}
        self.photo_index: list[dict] = []
        self.photo_map: dict[str, list[dict]] = {}
        self.drawing_index: list[dict] = []
        self.drawing_map: dict[str, list[dict]] = {}
        self.pdf_map: dict[str, str] = {}
        self.geojson_points: dict = {}
        self.geojson_polygons: dict = {}
        self.township_stats: list[dict] = []
        self.survey_routes: dict[str, list[dict]] = {}
        self.village_coverage: dict = {}
        self._bounds: Optional[tuple[float, float, float, float]] = None

        self._use_db: bool = False
        self._db_path: Optional[Path] = None
        # 主连接在 lifespan 启动时打开;路由线程按需通过 _thread_conn() 获取各自连接。
        self._db: Optional[sqlite3.Connection] = None
        self._tls = threading.local()

    # ── 加载入口 ────────────────────────────────────────────
    def load(
        self,
        dataset_dir: str | Path,
        *,
        village_geojson: str | Path = "",
        pdf_dir: str | Path = "",
        survey_gps_csv: str | Path = "",
        bounds: Optional[tuple[float, float, float, float]] = None,
    ) -> None:
        """一次性加载所有数据源。检测到 relics.db 则用 DB 模式,否则回退 JSON。"""
        dp = Path(dataset_dir)
        self._bounds = bounds

        db_file = dp / "relics.db"
        if db_file.exists():
            self._open_db(db_file)
            log.info("[数据] DB 模式: %s", db_file)
        else:
            log.warning("[数据] 未找到 relics.db，回退 JSON 模式。建议运行 step07_build_db.py")

        # PDF 文件名列表未入库,仍通过扫目录获得。
        if pdf_dir:
            self._load_pdf_index(Path(pdf_dir))

        if self._use_db:
            self._populate_legacy_from_db()
            self._load_geojson(dp)
            self._load_township_stats(dp / "township_stats.csv")
        else:
            self._load_relics(dp / "relics_full.json")
            self._load_photo_index(dp / "photo_index.csv")
            self._load_drawing_index(dp / "drawing_index.csv")
            self._load_geojson(dp)
            self._load_township_stats(dp / "township_stats.csv")

        if survey_gps_csv and Path(survey_gps_csv).exists():
            self._load_survey_routes(Path(survey_gps_csv))

        if village_geojson and Path(village_geojson).exists() and self.survey_routes:
            self._compute_village_coverage(Path(village_geojson))

    # ── SQLite 连接管理 ─────────────────────────────────────
    def _open_db(self, db_path: Path) -> None:
        self._db_path = db_path
        self._use_db = True
        # 启动阶段用的主连接,仅做一次性初始化;请求路径走 _thread_conn()。
        conn = sqlite3.connect(
            str(db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit,事务由代码 BEGIN/COMMIT 管理
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        self._db = conn

    def _thread_conn(self) -> sqlite3.Connection:
        """每线程独立连接,规避 sqlite3 cursor 跨线程共享问题。"""
        if not self._db_path:
            raise RuntimeError("DB 未开启")
        c = getattr(self._tls, "conn", None)
        if c is None:
            c = sqlite3.connect(str(self._db_path), check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL;")
            c.execute("PRAGMA foreign_keys=ON;")
            self._tls.conn = c
        return c

    # ── DB 模式初始化 ────────────────────────────────────────
    def _populate_legacy_from_db(self) -> None:
        """把 DB 全量读到 self.relics / relics_map / photo_map / drawing_map,
        供旧接口继续使用。"""
        assert self._db is not None
        self.relics.clear()
        self.relics_map.clear()
        self.photo_index.clear()
        self.photo_map.clear()
        self.drawing_index.clear()
        self.drawing_map.clear()

        for row in self._db.execute("SELECT * FROM relics WHERE status = 1"):
            extra = {}
            if row["extra_json"]:
                try:
                    extra = json.loads(row["extra_json"]) or {}
                except json.JSONDecodeError:
                    pass
            d = row_to_legacy(row, extra)
            if self.pdf_map.get(row["code"]):
                d["has_pdf"] = True
                d["pdf_path"] = self.pdf_map[row["code"]]
            self.relics.append(d)
            self.relics_map[row["code"]] = d

        # 照片 / 图纸索引
        for row in self._db.execute("SELECT relic_code, path, thumb_path, taken_at FROM photos"):
            p = {
                "archive_code": row["relic_code"],
                "path": row["path"],
                "thumb_path": row["thumb_path"] or "",
                "taken_at": row["taken_at"],
            }
            self.photo_index.append(p)
            self.photo_map.setdefault(row["relic_code"], []).append(p)

        for row in self._db.execute("SELECT relic_code, path FROM drawings"):
            dw = {"archive_code": row["relic_code"], "path": row["path"]}
            self.drawing_index.append(dw)
            self.drawing_map.setdefault(row["relic_code"], []).append(dw)

    # ── JSON 模式原有逻辑（完全保留） ────────────────────────
    def _load_relics(self, path: Path) -> None:
        if not path.exists():
            log.warning("[数据] 未找到 %s", path)
            return
        with open(path, "r", encoding="utf-8") as f:
            self.relics = json.load(f)
        for r in self.relics:
            code = r.get("archive_code")
            if code:
                self.relics_map[code] = r

    def _load_photo_index(self, path: Path) -> None:
        if not path.exists():
            return
        self.photo_index = self._read_csv(path)
        for p in self.photo_index:
            code = p.get("archive_code")
            if code:
                self.photo_map.setdefault(code, []).append(p)

    def _load_drawing_index(self, path: Path) -> None:
        if not path.exists():
            return
        self.drawing_index = self._read_csv(path)
        for d in self.drawing_index:
            code = d.get("archive_code")
            if code:
                self.drawing_map.setdefault(code, []).append(d)

    def _load_geojson(self, data_path: Path) -> None:
        pts = data_path / "relics_points.geojson"
        polys = data_path / "relics_polygons.geojson"
        if pts.exists():
            with open(pts, "r", encoding="utf-8") as f:
                self.geojson_points = json.load(f)
        if polys.exists():
            with open(polys, "r", encoding="utf-8") as f:
                self.geojson_polygons = json.load(f)

    def _load_township_stats(self, path: Path) -> None:
        if path.exists():
            self.township_stats = self._read_csv(path)

    def _load_pdf_index(self, pdf_dir: Path) -> None:
        if not pdf_dir.exists():
            log.warning("[PDF] 目录不存在: %s", pdf_dir)
            return
        for sub in pdf_dir.iterdir():
            if not sub.is_dir():
                continue
            pdfs = sorted(sub.glob("*.pdf"))
            if pdfs:
                self.pdf_map[sub.name] = f"{sub.name}/{pdfs[0].name}"
        log.info("[PDF] %d 个档案 PDF 已索引", len(self.pdf_map))

    def _load_survey_routes(self, path: Path) -> None:
        self.survey_routes = load_survey_routes(
            path=path,
            bounds=self._bounds,
            read_csv=self._read_csv,
            log=log,
        )

    def _compute_village_coverage(self, village_path: Path) -> None:
        coverage = compute_village_coverage(
            village_path=village_path,
            survey_routes=self.survey_routes,
            relics=self.relics,
            log=log,
        )
        if coverage is not None:
            self.village_coverage = coverage

    # ── 兼容旧接口 ───────────────────────────────────────────
    def get_relic(self, code: str) -> Optional[dict]:
        return self.relics_map.get(code)

    def get_photos(self, code: str) -> list[dict]:
        return self.photo_map.get(code, [])

    def get_drawings(self, code: str) -> list[dict]:
        return self.drawing_map.get(code, [])

    def get_relics_summary(self) -> list[dict]:
        """不含简介/边界点的精简列表,用于地图打点与列表渲染。"""
        fields = [
            "archive_code", "name", "category_main", "category_sub",
            "era", "era_stats", "heritage_level", "township", "address",
            "center_lat", "center_lng", "center_alt",
            "has_boundary", "area", "condition_level", "risk_score",
            "ownership_type", "has_3d", "model_3d_path",
            "photo_count", "drawing_count",
            "survey_type", "industry", "risk_factors",
        ]
        result = []
        for r in self.relics:
            item = {k: r.get(k) for k in fields}
            pdf = self.pdf_map.get(r.get("archive_code", ""))
            item["has_pdf"] = pdf is not None
            item["pdf_path"] = pdf or ""
            result.append(item)
        return result

    def compute_stats(self) -> dict:
        total = len(self.relics)
        by_category: dict[str, int] = {}
        by_township: dict[str, int] = {}
        by_condition: dict[str, int] = {}
        by_era: dict[str, int] = {}
        has_3d_count = 0
        has_boundary_count = 0

        for r in self.relics:
            by_category[r.get("category_main", "未知")] = by_category.get(r.get("category_main", "未知"), 0) + 1
            by_township[r.get("township", "未知")] = by_township.get(r.get("township", "未知"), 0) + 1
            by_condition[r.get("condition_level", "未知")] = by_condition.get(r.get("condition_level", "未知"), 0) + 1
            by_era[r.get("era_stats", "未知")] = by_era.get(r.get("era_stats", "未知"), 0) + 1
            if r.get("has_3d"):
                has_3d_count += 1
            if r.get("has_boundary"):
                has_boundary_count += 1

        return {
            "total": total,
            "has_3d_count": has_3d_count,
            "has_boundary_count": has_boundary_count,
            "by_category": by_category,
            "by_township": by_township,
            "by_condition": by_condition,
            "by_era": by_era,
        }

    # ── Repository 新接口（DB 模式专用） ────────────────────
    def query_bbox(
        self,
        min_lng: float,
        min_lat: float,
        max_lng: float,
        max_lat: float,
        *,
        categories: Optional[Iterable[str]] = None,
        ranks: Optional[Iterable[str]] = None,
        township: Optional[str] = None,
        search_type: Optional[str] = None,
        limit: int = 2000,
    ) -> list[dict]:
        """视口 + 多条件筛选。返回 id/name/code/lng/lat/category/rank/has_3d 8 字段。

        bbox 的 buffer 扩展由调用方处理(见 routers/relics.py);
        categories/ranks 支持多选,None 或空值表示不筛选。
        """
        if not self._use_db:
            return self._query_bbox_memory(min_lng, min_lat, max_lng, max_lat,
                                            categories=categories, ranks=ranks,
                                            township=township, search_type=search_type,
                                            limit=limit)

        sql = [
            "SELECT r.id, r.code, r.name, r.category, r.rank, r.lng, r.lat, r.has_3d",
            "FROM relics_rtree AS s",
            "JOIN relics_rtree_map AS m ON m.id_int = s.id_int",
            "JOIN relics AS r ON r.id = m.relic_id",
            "WHERE s.max_lng >= ? AND s.min_lng <= ?",
            "  AND s.max_lat >= ? AND s.min_lat <= ?",
            "  AND r.status = 1",
        ]
        params: list = [min_lng, max_lng, min_lat, max_lat]

        if categories:
            cl = [str(v) for v in categories if v not in (None, "")]
            if cl:
                sql.append(f"  AND r.category IN ({','.join('?' for _ in cl)})")
                params.extend(cl)
        if ranks:
            rl = [str(v) for v in ranks if v not in (None, "")]
            if rl:
                sql.append(f"  AND r.rank IN ({','.join('?' for _ in rl)})")
                params.extend(rl)
        if township:
            sql.append("  AND r.township = ?")
            params.append(township)
        if search_type:
            sql.append("  AND r.search_type = ?")
            params.append(str(search_type))

        sql.append("LIMIT ?")
        params.append(int(limit))

        conn = self._thread_conn()
        rows = conn.execute("\n".join(sql), params).fetchall()
        return [
            {
                "id": r["id"],
                "code": r["code"],
                "name": r["name"],
                "lng": r["lng"],
                "lat": r["lat"],
                "category": r["category"],
                "rank": r["rank"],
                "has_3d": bool(r["has_3d"]),
            }
            for r in rows
        ]

    def _query_bbox_memory(
        self, min_lng, min_lat, max_lng, max_lat,
        *, categories, ranks, township, search_type, limit,
    ) -> list[dict]:
        """JSON 模式下的视口查询 fallback。全量遍历,性能仅足以支撑千条级。"""
        from codes import normalize_category, normalize_rank, normalize_search_type

        rank_set = {str(v) for v in ranks} if ranks else None
        cat_set = {str(v) for v in categories} if categories else None
        out = []
        for r in self.relics:
            lng = r.get("center_lng")
            lat = r.get("center_lat")
            if lng is None or lat is None:
                continue
            try:
                lng = float(lng); lat = float(lat)
            except (TypeError, ValueError):
                continue
            if not (min_lng <= lng <= max_lng and min_lat <= lat <= max_lat):
                continue
            cat_code = normalize_category(r.get("category_main"))
            rk_code = normalize_rank(r.get("heritage_level"))
            st_code = normalize_search_type(r.get("survey_type"))
            if cat_set and cat_code not in cat_set:
                continue
            if rank_set and rk_code not in rank_set:
                continue
            if township and r.get("township") != township:
                continue
            if search_type and st_code != search_type:
                continue
            out.append({
                "id": r.get("archive_code"),
                "code": r.get("archive_code"),
                "name": r.get("name"),
                "lng": lng,
                "lat": lat,
                "category": cat_code,
                "rank": rk_code,
                "has_3d": bool(r.get("has_3d")),
            })
            if len(out) >= limit:
                break
        return out

    def search_fulltext(self, keyword: str, limit: int = 20) -> list[dict]:
        """FTS5 全文搜索,返回格式同 query_bbox。
        关键词 >= 3 字走 FTS5 trigram,< 3 字回退 LIKE。"""
        kw = (keyword or "").strip()
        if not kw:
            return []

        if not self._use_db:
            return [r for r in [self._peek_memory(kw, limit)] if r][0] if self._peek_memory(kw, limit) else []

        conn = self._thread_conn()
        if len(kw) >= 3:
            sql = (
                "SELECT r.id, r.code, r.name, r.category, r.rank, r.lng, r.lat, r.has_3d "
                "FROM relics_fts f "
                "JOIN relics_rtree_map m ON m.id_int = f.rowid "
                "JOIN relics r ON r.id = m.relic_id "
                "WHERE f.relics_fts MATCH ? AND r.status = 1 "
                "LIMIT ?"
            )
            # FTS5 MATCH 会按 trigram 切分,双引号需要转义。
            safe_kw = kw.replace('"', '""')
            rows = conn.execute(sql, (f'"{safe_kw}"', int(limit))).fetchall()
        else:
            sql = (
                "SELECT id, code, name, category, rank, lng, lat, has_3d "
                "FROM relics WHERE status = 1 AND name LIKE ? LIMIT ?"
            )
            rows = conn.execute(sql, (f"%{kw}%", int(limit))).fetchall()

        return [
            {
                "id": r["id"], "code": r["code"], "name": r["name"],
                "lng": r["lng"], "lat": r["lat"],
                "category": r["category"], "rank": r["rank"],
                "has_3d": bool(r["has_3d"]),
            }
            for r in rows
        ]

    def _peek_memory(self, kw: str, limit: int) -> list[dict]:
        """JSON fallback:按 name 子串过滤。"""
        out = []
        for r in self.relics:
            if kw in (r.get("name") or ""):
                out.append({
                    "id": r.get("archive_code"), "code": r.get("archive_code"),
                    "name": r.get("name"),
                    "lng": r.get("center_lng"), "lat": r.get("center_lat"),
                    "category": r.get("category_main"), "rank": r.get("heritage_level"),
                    "has_3d": bool(r.get("has_3d")),
                })
                if len(out) >= limit:
                    break
        return out

    @lru_cache(maxsize=1024)
    def get_relic_full(self, code: str) -> Optional[dict]:
        """单条完整详情,合并 extra_json。DB 模式走 DB,否则走内存。"""
        if self._use_db:
            conn = self._thread_conn()
            row = conn.execute(
                "SELECT * FROM relics WHERE code = ? AND status = 1", (code,)
            ).fetchone()
            if not row:
                return None
            extra = {}
            if row["extra_json"]:
                try:
                    extra = json.loads(row["extra_json"]) or {}
                except json.JSONDecodeError:
                    pass
            d = row_to_legacy(row, extra)
            d["photos"] = self.get_photos(code)
            d["drawings"] = self.get_drawings(code)
            if self.pdf_map.get(code):
                d["has_pdf"] = True
                d["pdf_path"] = self.pdf_map[code]
            return d
        return self.relics_map.get(code)

    def polygon_of(self, code: str) -> Optional[dict]:
        """单条文物的多边形几何 (GeoJSON),仅 DB 模式有效。"""
        if not self._use_db:
            return None
        conn = self._thread_conn()
        row = conn.execute(
            "SELECT geom_geojson FROM polygons WHERE relic_code = ?", (code,)
        ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["geom_geojson"])
        except json.JSONDecodeError:
            return None

    # ── 写入接口 (Admin) ─────────────────────────────────────
    # 乐观锁:UPDATE 必须匹配 expected_version,成功后 version += 1。
    # 所有写操作落 audit_log,记录 before_json / after_json 以便回溯。

    # 允许通过 admin 写入的列白名单(防止通过列名注入)。
    _WRITABLE = {
        "name", "category", "rank", "search_type",
        "lng", "lat", "alt", "township", "village", "address",
        "era", "era_stats", "has_3d", "has_pdf", "has_photo",
        "has_boundary", "photo_count", "drawing_count",
        "brief", "extra_json", "status",
    }

    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        return {k: row[k] for k in row.keys()}

    def _write_audit(
        self, conn: sqlite3.Connection, *,
        actor: str, action: str, code: str,
        before: Optional[dict], after: Optional[dict],
    ) -> None:
        import time
        conn.execute(
            "INSERT INTO audit_log (actor, action, relic_code, before_json, after_json, ts) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                actor or "",
                action,
                code,
                json.dumps(before, ensure_ascii=False) if before else None,
                json.dumps(after, ensure_ascii=False) if after else None,
                int(time.time()),
            ),
        )

    def _rtree_upsert(
        self, conn: sqlite3.Connection, relic_id: str, lng: float, lat: float,
    ) -> None:
        """同步 (lng, lat) 到 R-Tree 与桥接表。"""
        row = conn.execute(
            "SELECT id_int FROM relics_rtree_map WHERE relic_id = ?", (relic_id,)
        ).fetchone()
        if row:
            id_int = row["id_int"]
            conn.execute(
                "UPDATE relics_rtree SET min_lng=?, max_lng=?, min_lat=?, max_lat=? WHERE id_int=?",
                (lng, lng, lat, lat, id_int),
            )
        else:
            # 新记录:先插 R-Tree 获取 id_int,再写桥接表。
            cur = conn.execute(
                "INSERT INTO relics_rtree (min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?)",
                (lng, lng, lat, lat),
            )
            id_int = cur.lastrowid
            conn.execute(
                "INSERT INTO relics_rtree_map (id_int, relic_id) VALUES (?, ?)",
                (id_int, relic_id),
            )

    def _fts_upsert(self, conn: sqlite3.Connection, row: dict) -> None:
        conn.execute("DELETE FROM relics_fts WHERE code = ?", (row["code"],))
        conn.execute(
            "INSERT INTO relics_fts (code, name, brief, era, township, village) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                row.get("code", ""),
                row.get("name", ""),
                row.get("brief") or "",
                row.get("era") or "",
                row.get("township") or "",
                row.get("village") or "",
            ),
        )

    def create_relic(self, payload: dict, *, actor: str = "") -> dict:
        """创建文物。payload 需包含 code/name/category/rank/lng/lat。
        成功返回完整记录;code 重复抛 ValueError。"""
        if not self._use_db:
            raise RuntimeError("create_relic 仅在 DB 模式可用")
        import time
        import uuid as _uuid

        code = str(payload.get("code", "")).strip()
        name = str(payload.get("name", "")).strip()
        if not code or not name:
            raise ValueError("缺少 code 或 name")
        try:
            lng = float(payload["lng"]); lat = float(payload["lat"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("lng/lat 必须是有效坐标")

        conn = self._thread_conn()
        exist = conn.execute("SELECT 1 FROM relics WHERE code = ?", (code,)).fetchone()
        if exist:
            raise ValueError(f"文物编号 {code} 已存在")

        relic_id = str(_uuid.uuid4())
        now = int(time.time())

        conn.execute("BEGIN")
        try:
            conn.execute(
                """INSERT INTO relics (
                    id, code, name, category, rank, search_type,
                    lng, lat, alt, township, village, address,
                    era, era_stats, has_3d, has_pdf, has_photo, has_boundary,
                    photo_count, drawing_count, brief, extra_json,
                    status, version, created_at, updated_at
                ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?)""",
                (
                    relic_id, code, name,
                    str(payload.get("category") or "0600"),
                    str(payload.get("rank") or "5"),
                    payload.get("search_type"),
                    lng, lat,
                    float(payload["alt"]) if payload.get("alt") not in (None, "") else None,
                    payload.get("township"), payload.get("village"), payload.get("address"),
                    payload.get("era"), payload.get("era_stats"),
                    1 if payload.get("has_3d") else 0,
                    1 if payload.get("has_pdf") else 0,
                    1 if payload.get("has_photo") else 0,
                    1 if payload.get("has_boundary") else 0,
                    int(payload.get("photo_count") or 0),
                    int(payload.get("drawing_count") or 0),
                    payload.get("brief"),
                    json.dumps(payload.get("extra"), ensure_ascii=False) if payload.get("extra") else None,
                    int(payload.get("status", 1)),
                    1, now, now,
                ),
            )
            self._rtree_upsert(conn, relic_id, lng, lat)
            self._fts_upsert(conn, {
                "code": code, "name": name,
                "brief": payload.get("brief"),
                "era": payload.get("era"),
                "township": payload.get("township"),
                "village": payload.get("village"),
            })
            row = conn.execute("SELECT * FROM relics WHERE id = ?", (relic_id,)).fetchone()
            after = self._row_to_dict(row)
            self._write_audit(conn, actor=actor, action="create", code=code,
                              before=None, after=after)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        self._populate_legacy_from_db()
        return after

    def update_relic(
        self, code: str, patch: dict, *, expected_version: int, actor: str = "",
    ) -> dict:
        """乐观锁更新。expected_version 不匹配抛 ValueError("VERSION_CONFLICT")。
        patch 仅保留 `_WRITABLE` 里的字段,其它忽略。"""
        if not self._use_db:
            raise RuntimeError("update_relic 仅在 DB 模式可用")
        import time

        conn = self._thread_conn()
        before_row = conn.execute("SELECT * FROM relics WHERE code = ?", (code,)).fetchone()
        if not before_row:
            raise ValueError(f"文物 {code} 不存在")
        if int(before_row["version"]) != int(expected_version):
            raise ValueError("VERSION_CONFLICT")

        sets = []
        params: list = []
        for k, v in (patch or {}).items():
            if k not in self._WRITABLE:
                continue
            if k == "extra_json" and isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            sets.append(f"{k} = ?")
            params.append(v)
        if not sets:
            raise ValueError("没有可更新的字段")

        now = int(time.time())
        sets.append("updated_at = ?")
        params.append(now)
        sets.append("version = version + 1")
        params.extend([code, expected_version])

        conn.execute("BEGIN")
        try:
            cur = conn.execute(
                f"UPDATE relics SET {', '.join(sets)} WHERE code = ? AND version = ?",
                params,
            )
            if cur.rowcount != 1:
                # 被其它线程先行更新,版本号对不上。
                conn.execute("ROLLBACK")
                raise ValueError("VERSION_CONFLICT")
            row = conn.execute("SELECT * FROM relics WHERE code = ?", (code,)).fetchone()
            if ("lng" in patch) or ("lat" in patch):
                self._rtree_upsert(conn, row["id"], row["lng"], row["lat"])
            if any(k in patch for k in ("name", "brief", "era", "township", "village")):
                self._fts_upsert(conn, {
                    "code": row["code"], "name": row["name"],
                    "brief": row["brief"], "era": row["era"],
                    "township": row["township"], "village": row["village"],
                })
            after = self._row_to_dict(row)
            self._write_audit(conn, actor=actor, action="update", code=code,
                              before=self._row_to_dict(before_row), after=after)
            conn.execute("COMMIT")
        except Exception:
            try: conn.execute("ROLLBACK")
            except Exception: pass
            raise
        self._populate_legacy_from_db()
        return after

    def delete_relic(self, code: str, *, actor: str = "") -> None:
        """软删除:status=-1 且 version++;主键与空间/FTS 索引保留以便恢复。"""
        if not self._use_db:
            raise RuntimeError("delete_relic 仅在 DB 模式可用")
        import time

        conn = self._thread_conn()
        before_row = conn.execute("SELECT * FROM relics WHERE code = ?", (code,)).fetchone()
        if not before_row:
            raise ValueError(f"文物 {code} 不存在")

        conn.execute("BEGIN")
        try:
            conn.execute(
                "UPDATE relics SET status = -1, version = version + 1, updated_at = ? WHERE code = ?",
                (int(time.time()), code),
            )
            self._write_audit(conn, actor=actor, action="delete", code=code,
                              before=self._row_to_dict(before_row), after=None)
            conn.execute("COMMIT")
        except Exception:
            try: conn.execute("ROLLBACK")
            except Exception: pass
            raise
        self._populate_legacy_from_db()

    def list_audit(
        self,
        *,
        code: Optional[str] = None,
        limit: int = 100,
        actions: Optional[Iterable[str]] = None,
        actor: Optional[str] = None,
        field: Optional[str] = None,
        start_ts: Optional[int] = None,
        end_ts: Optional[int] = None,
    ) -> list[dict]:
        """读取审计日志,最近在前。

        - code: 精确匹配
        - actions: create/update/delete/rollback 任意子集
        - actor: LIKE %actor%
        - field: 判定 before/after_json 是否出现该字段 (LIKE `%"field":%`)
        - start_ts / end_ts: 秒级时间戳区间
        """
        if not self._use_db:
            return []
        conn = self._thread_conn()
        where: list[str] = []
        params: list = []
        if code:
            where.append("relic_code = ?"); params.append(code)
        if actions:
            al = [str(a) for a in actions if a]
            if al:
                where.append(f"action IN ({','.join('?' for _ in al)})")
                params.extend(al)
        if actor:
            where.append("actor LIKE ?"); params.append(f"%{actor}%")
        if field:
            # before/after 任一出现该字段即命中。
            pat = f'%"{field}":%'
            where.append("(before_json LIKE ? OR after_json LIKE ?)")
            params.extend([pat, pat])
        if start_ts is not None:
            where.append("ts >= ?"); params.append(int(start_ts))
        if end_ts is not None:
            where.append("ts <= ?"); params.append(int(end_ts))
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            f"SELECT * FROM audit_log{where_sql} ORDER BY id DESC LIMIT ?",
            [*params, max(1, min(limit, 1000))],
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def rollback_audit(self, audit_id: int, *, actor: str = "") -> dict:
        """按审计记录回滚:
        - update:  用 before_json 覆写(仅 _WRITABLE 字段)
        - delete:  用 before_json 恢复(含 status)
        - create:  等价于软删当前文物

        走当前版本号做乐观锁;若记录已被彻底删除则拒绝。
        本次回滚本身也落一条 action=rollback 的审计。
        """
        if not self._use_db:
            raise RuntimeError("rollback_audit 仅在 DB 模式可用")
        conn = self._thread_conn()
        row = conn.execute(
            "SELECT id, action, relic_code, before_json, after_json FROM audit_log WHERE id=?",
            (int(audit_id),),
        ).fetchone()
        if not row:
            raise ValueError("审计记录不存在")
        action = row["action"] or ""
        code = row["relic_code"] or ""
        if not code:
            raise ValueError("该审计记录缺少 relic_code，无法回滚")
        before = json.loads(row["before_json"]) if row["before_json"] else None

        tag = f"rollback#{audit_id}"
        stamp = f"{actor or ''} [{tag}]".strip()

        if action == "create":
            # 回滚新建 = 软删。
            self.delete_relic(code, actor=stamp)
            return {"ok": True, "action_taken": "delete", "code": code}

        if action in ("update", "delete", "rollback"):
            if not before:
                raise ValueError("该记录缺少 before_json，无法回滚")
            cur = conn.execute(
                "SELECT version FROM relics WHERE code=?", (code,)
            ).fetchone()
            if not cur:
                raise ValueError("该文物已彻底删除，无法回滚")
            ev = int(cur["version"])
            patch = {k: before.get(k) for k in before.keys() if k in self._WRITABLE}
            if not patch:
                raise ValueError("before_json 无可写字段，无法回滚")
            self.update_relic(code, patch, expected_version=ev, actor=stamp)
            return {"ok": True, "action_taken": "update", "code": code}

        raise ValueError(f"不支持回滚的 action: {action}")

    def admin_neighbors(
        self,
        code: str,
        *,
        radius_m: float = 2000.0,
        limit: int = 20,
    ) -> list[dict]:
        return data_admin_queries.admin_neighbors(
            self, code, radius_m=radius_m, limit=limit
        )

    # ── 后台分页查询（给 /api/admin/relics 用） ─────────────────
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
        return data_admin_queries.admin_list_relics(
            self,
            page=page,
            size=size,
            search=search,
            categories=categories,
            ranks=ranks,
            township=township,
            search_type=search_type,
            status=status,
            bbox=bbox,
            order_by=order_by,
        )

    def _admin_list_legacy(
        self, *, page, size, search, categories, ranks,
        township, search_type,
    ) -> dict:
        return data_admin_queries._admin_list_legacy(
            self,
            page=page,
            size=size,
            search=search,
            categories=categories,
            ranks=ranks,
            township=township,
            search_type=search_type,
        )

    # ── 批量操作（后台多选工具用）───────────────────────
    def admin_bulk_update(
        self,
        codes: Iterable[str],
        patch: dict,
        *,
        actor: str = "",
    ) -> dict:
        """批量同字段更新。每条独立读版本 → 写回,冲突/缺失/异常逐条记录不中断。

        字段受 `_WRITABLE` 约束;空 patch 抛 ValueError。
        返回 {updated, not_found:[...], failed:[{code,error}...]}。
        """
        if not self._use_db:
            raise RuntimeError("admin_bulk_update 仅在 DB 模式可用")
        clean = {k: v for k, v in (patch or {}).items() if k in self._WRITABLE}
        if not clean:
            raise ValueError("没有可更新的字段")

        updated = 0
        not_found: list[str] = []
        failed: list[dict] = []
        conn = self._thread_conn()
        for raw_code in codes or []:
            code = str(raw_code or "").strip()
            if not code:
                continue
            row = conn.execute(
                "SELECT version FROM relics WHERE code = ?", (code,)
            ).fetchone()
            if not row:
                not_found.append(code)
                continue
            try:
                self.update_relic(
                    code, dict(clean),
                    expected_version=int(row["version"]), actor=actor,
                )
                updated += 1
            except ValueError as e:
                failed.append({"code": code, "error": str(e)})
            except Exception as e:  # pragma: no cover
                failed.append({"code": code, "error": str(e)})
        return {"updated": updated, "not_found": not_found, "failed": failed}

    def admin_bulk_delete(
        self, codes: Iterable[str], *, actor: str = "",
    ) -> dict:
        """批量软删除,错一条不中断其余。"""
        if not self._use_db:
            raise RuntimeError("admin_bulk_delete 仅在 DB 模式可用")
        deleted = 0
        not_found: list[str] = []
        failed: list[dict] = []
        for raw_code in codes or []:
            code = str(raw_code or "").strip()
            if not code:
                continue
            try:
                self.delete_relic(code, actor=actor)
                deleted += 1
            except ValueError as e:
                msg = str(e)
                if "不存在" in msg:
                    not_found.append(code)
                else:
                    failed.append({"code": code, "error": msg})
            except Exception as e:  # pragma: no cover
                failed.append({"code": code, "error": str(e)})
        return {"deleted": deleted, "not_found": not_found, "failed": failed}

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
        return data_admin_queries.admin_export_relics(
            self,
            search=search,
            categories=categories,
            ranks=ranks,
            township=township,
            search_type=search_type,
            status=status,
            codes=codes,
            bbox=bbox,
            order_by=order_by,
        )

    def admin_stats_overview(self) -> dict:
        return data_admin_stats.admin_stats_overview(self)

    def _admin_stats_legacy(self) -> dict:
        return data_admin_stats._admin_stats_legacy(self)

    def admin_list_townships(self) -> list[str]:
        return data_admin_queries.admin_list_townships(self)

    # ── 工具 ────────────────────────────────────────────────
    @staticmethod
    def _read_csv(path: Path) -> list[dict]:
        with open(path, "r", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))


store = DataStore()
