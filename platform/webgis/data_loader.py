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
    store.archive_map
    store.load() / store.get_relic() / store.get_photos() / store.get_drawings()
    store.get_relics_summary() / store.compute_stats()

DB 模式专用接口：
    store.query_bbox(...)        视口查询(极简字段)
    store.search_fulltext(...)   FTS5 全文搜索
    store.get_relic_full(code)   单条完整详情(含 extra_json 合并)
    store.polygons_of(code)      两线范围面(保护范围/建控地带)
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
from relic_scope import (  # noqa: E402
    SCOPE_PROTECTED,
    filter_relics,
    normalize_relic_scope,
    relic_in_scope,
    scope_counts,
)



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
        # 普查档案 PDF: {code: {"sanpu": [relpath...], "sipu": [relpath...]}}
        self.archive_map: dict[str, dict[str, list[str]]] = {}
        self.geojson_points: dict = {}
        self.geojson_polygons: dict = {}
        self._bounds: Optional[tuple[float, float, float, float]] = None

        self._use_db: bool = False
        self._db_path: Optional[Path] = None
        # 主连接在 lifespan 启动时打开;路由线程按需通过 _thread_conn() 获取各自连接。
        self._db: Optional[sqlite3.Connection] = None
        self._tls = threading.local()
        # 全部已建连接的注册表 + 代数号:close_db() 关掉所有连接并使
        # 各线程 TLS 里的旧连接失效(gen 不匹配时重建)。
        self._conn_registry: list[sqlite3.Connection] = []
        self._conn_lock = threading.Lock()
        self._gen = 0

    # ── 加载入口 ────────────────────────────────────────────
    def load(
        self,
        dataset_dir: str | Path,
        *,
        archive_docs_dir: str | Path = "",
        bounds: Optional[tuple[float, float, float, float]] = None,
    ) -> None:
        """一次性加载所有数据源。检测到 relics.db 则用 DB 模式,否则回退 JSON。"""
        dp = Path(dataset_dir)
        self._bounds = bounds

        # 重载前清空全部容器:数据被清除后再 load,不能残留旧数据。
        self.relics.clear()
        self.relics_map.clear()
        self.photo_index.clear()
        self.photo_map.clear()
        self.drawing_index.clear()
        self.drawing_map.clear()
        self.archive_map.clear()
        self.geojson_points = {}
        self.geojson_polygons = {}
        self.get_relic_full.cache_clear()

        db_file = dp / "relics.db"
        if db_file.exists():
            self._open_db(db_file)
            log.info("[数据] DB 模式: %s", db_file)
        else:
            log.warning("[数据] 未找到 relics.db，回退 JSON 模式。建议运行 step03_build_db.py")

        # 档案 PDF 未入库,扫目录获得。
        if archive_docs_dir:
            self._load_archive_docs(Path(archive_docs_dir))

        if self._use_db:
            self._populate_legacy_from_db()
            self._load_geojson(dp)
        else:
            self._load_relics(dp / "relics_full.json")
            self._load_photo_index(dp / "photo_index.csv")
            self._load_drawing_index(dp / "drawing_index.csv")
            self._load_geojson(dp)

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
        with self._conn_lock:
            self._conn_registry.append(conn)

    def _thread_conn(self) -> sqlite3.Connection:
        """每线程独立连接,规避 sqlite3 cursor 跨线程共享问题。"""
        if not self._db_path:
            raise RuntimeError("DB 未开启")
        c = getattr(self._tls, "conn", None)
        # close_db() 之后代数号变化,旧连接已关闭,需要重建
        if c is None or getattr(self._tls, "gen", -1) != self._gen:
            c = sqlite3.connect(str(self._db_path), check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL;")
            c.execute("PRAGMA foreign_keys=ON;")
            self._tls.conn = c
            self._tls.gen = self._gen
            with self._conn_lock:
                self._conn_registry.append(c)
        return c

    def close_db(self) -> None:
        """关闭全部 SQLite 连接并释放文件句柄(清除数据前必须调用,
        否则 Windows 上无法删除被占用的 relics.db)。"""
        with self._conn_lock:
            conns = list(self._conn_registry)
            self._conn_registry.clear()
            self._gen += 1
        for c in conns:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        self._db = None
        self._db_path = None
        self._use_db = False

    # ── DB 模式初始化 ────────────────────────────────────────
    def _populate_legacy_from_db(self) -> None:
        """把 DB 全量读到 self.relics / relics_map / photo_map / drawing_map,
        供旧接口继续使用。"""
        assert self._db is not None
        # 数据已变化(启动加载或 create/update/delete 之后都会走到这里),
        # 必须同时清掉 get_relic_full 的 lru_cache,否则详情接口返回旧数据。
        self.get_relic_full.cache_clear()
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
            self.relics.append(d)
            self.relics_map[row["code"]] = d

        # 照片 / 图纸索引(键名与前端契约对齐: relative_path / photo_no / description)
        photo_cols = {r[1] for r in self._db.execute("PRAGMA table_info(photos)")}
        has_photo_meta = "photo_no" in photo_cols
        photo_sql = (
            "SELECT relic_code, path, photo_no, description, thumb_path, taken_at FROM photos"
            if has_photo_meta
            else "SELECT relic_code, path, thumb_path, taken_at FROM photos"
        )
        for row in self._db.execute(photo_sql):
            p = {
                "archive_code": row["relic_code"],
                "path": row["path"],
                "relative_path": row["path"],
                "photo_no": (row["photo_no"] if has_photo_meta else "") or "",
                "description": (row["description"] if has_photo_meta else "") or "",
                "thumb_path": row["thumb_path"] or "",
                "taken_at": row["taken_at"],
            }
            self.photo_index.append(p)
            self.photo_map.setdefault(row["relic_code"], []).append(p)

        drawing_cols = {r[1] for r in self._db.execute("PRAGMA table_info(drawings)")}
        has_drawing_meta = "drawing_no" in drawing_cols
        drawing_sql = (
            "SELECT relic_code, path, drawing_no, drawing_name FROM drawings"
            if has_drawing_meta
            else "SELECT relic_code, path FROM drawings"
        )
        for row in self._db.execute(drawing_sql):
            dw = {
                "archive_code": row["relic_code"],
                "path": row["path"],
                "relative_path": row["path"],
                "drawing_no": (row["drawing_no"] if has_drawing_meta else "") or "",
                "drawing_name": (row["drawing_name"] if has_drawing_meta else "") or "",
            }
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
            if not p.get("relative_path"):
                p["relative_path"] = p.get("path", "")
            code = p.get("archive_code")
            if code:
                self.photo_map.setdefault(code, []).append(p)

    def _load_drawing_index(self, path: Path) -> None:
        if not path.exists():
            return
        self.drawing_index = self._read_csv(path)
        for d in self.drawing_index:
            if not d.get("relative_path"):
                d["relative_path"] = d.get("path", "")
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

    def _load_archive_docs(self, docs_dir: Path) -> None:
        """扫描 {code}/{sanpu|sipu}/*.pdf,建立档案索引(相对 docs_dir 的路径)。"""
        if not docs_dir.exists():
            return
        n = 0
        for sub in docs_dir.iterdir():
            if not sub.is_dir():
                continue
            entry: dict[str, list[str]] = {}
            for kind in ("sanpu", "sipu"):
                d = sub / kind
                if not d.exists():
                    continue
                files = sorted(
                    f"{sub.name}/{kind}/{p.name}"
                    for p in d.iterdir()
                    if p.is_file() and p.suffix.lower() == ".pdf"
                )
                if files:
                    entry[kind] = files
            if entry:
                self.archive_map[sub.name] = entry
                n += 1
        log.info("[档案] %d 处文物的普查档案已索引", n)

    # ── 兼容旧接口 ───────────────────────────────────────────
    def get_relic(self, code: str) -> Optional[dict]:
        return self.relics_map.get(code)

    def get_photos(self, code: str) -> list[dict]:
        return self.photo_map.get(code, [])

    def get_drawings(self, code: str) -> list[dict]:
        return self.drawing_map.get(code, [])

    def scoped_relics(self, scope: str = SCOPE_PROTECTED) -> list[dict]:
        """返回当前业务口径的数据；tier 仍只表示资料丰富度。"""
        return filter_relics(self.relics, scope)

    def scope_counts(self) -> dict[str, int]:
        return scope_counts(self.relics)

    def get_relics_summary(self, scope: str = SCOPE_PROTECTED) -> list[dict]:
        """不含简介/边界点的精简列表,用于地图打点与列表渲染。"""
        fields = [
            "archive_code", "name", "category_main", "category_sub",
            "era", "era_stats", "heritage_level", "county", "township", "address",
            "center_lat", "center_lng", "center_alt",
            "has_boundary", "area", "condition_level", "tier",
            "ownership_type", "has_3d", "model_3d_path",
            "photo_count", "drawing_count", "attachments",
            "has_archive_spu", "has_archive_fpu", "last_patrol_at",
        ]
        result = []
        for r in self.scoped_relics(scope):
            item = {k: r.get(k) for k in fields}
            arch = self.archive_map.get(r.get("archive_code", ""))
            if arch:
                item["has_archive_spu"] = item["has_archive_spu"] or bool(arch.get("sanpu"))
                item["has_archive_fpu"] = item["has_archive_fpu"] or bool(arch.get("sipu"))
            result.append(item)
        return result

    def compute_stats(self, scope: str = SCOPE_PROTECTED) -> dict:
        relics = self.scoped_relics(scope)
        total = len(relics)
        by_category: dict[str, int] = {}
        by_county: dict[str, int] = {}
        by_rank: dict[str, int] = {}
        by_condition: dict[str, int] = {}
        by_era: dict[str, int] = {}
        has_3d_count = 0
        has_boundary_count = 0

        for r in relics:
            by_category[r.get("category_main", "未知")] = by_category.get(r.get("category_main", "未知"), 0) + 1
            by_county[r.get("county") or "未知"] = by_county.get(r.get("county") or "未知", 0) + 1
            by_rank[r.get("heritage_level") or "未知"] = by_rank.get(r.get("heritage_level") or "未知", 0) + 1
            by_condition[r.get("condition_level", "未知")] = by_condition.get(r.get("condition_level", "未知"), 0) + 1
            by_era[r.get("era_stats", "未知")] = by_era.get(r.get("era_stats", "未知"), 0) + 1
            if r.get("has_3d"):
                has_3d_count += 1
            if r.get("has_boundary"):
                has_boundary_count += 1

        return {
            "scope": normalize_relic_scope(scope),
            "total": total,
            "has_3d_count": has_3d_count,
            "has_boundary_count": has_boundary_count,
            "by_category": by_category,
            "by_county": by_county,
            "by_rank": by_rank,
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
        county: Optional[str] = None,
        township: Optional[str] = None,
        tier: Optional[str] = None,
        scope: str = SCOPE_PROTECTED,
        condition: Optional[str] = None,
        era_stats_in: Optional[Iterable[str]] = None,
        has_3d: Optional[bool] = None,
        keyword: Optional[str] = None,
        limit: int = 2000,
    ) -> list[dict]:
        """视口 + 多条件筛选。返回极简字段(含保存状况,供巡查地图着色)。

        bbox 的 buffer 扩展由调用方处理(见 routers/relics.py);
        categories/ranks 支持多选,None 或空值表示不筛选。
        era_stats_in 是 era_stats 原始值集合(前端按统计口径反查),
        "__empty__" 表示匹配空值。keyword 按名称/编号/地址做 LIKE 匹配。
        """
        canonical_scope = normalize_relic_scope(scope)
        if not self._use_db:
            return self._query_bbox_memory(min_lng, min_lat, max_lng, max_lat,
                                            categories=categories, ranks=ranks,
                                            county=county, township=township,
                                            tier=tier, scope=canonical_scope,
                                            condition=condition,
                                            era_stats_in=era_stats_in,
                                            has_3d=has_3d, keyword=keyword,
                                            limit=limit)

        sql = [
            "SELECT r.id, r.code, r.name, r.category, r.rank, r.lng, r.lat,"
            "       r.has_3d, r.county, r.condition, r.tier",
            "FROM relics_rtree AS s",
            "JOIN relics_rtree_map AS m ON m.id_int = s.id_int",
            "JOIN relics AS r ON r.id = m.relic_id",
            "WHERE s.max_lng >= ? AND s.min_lng <= ?",
            "  AND s.max_lat >= ? AND s.min_lat <= ?",
            "  AND r.status = 1",
        ]
        params: list = [min_lng, max_lng, min_lat, max_lat]

        if canonical_scope == SCOPE_PROTECTED:
            sql.append("  AND r.rank IN ('1','2','3','4')")
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
        if county:
            sql.append("  AND r.county = ?")
            params.append(county)
        if township:
            # 逗号分隔多选:撤镇设街道等新旧名并存时,前端会展开成多个写法
            tw = [v.strip() for v in str(township).split(",") if v.strip()]
            if tw:
                sql.append(f"  AND r.township IN ({','.join('?' for _ in tw)})")
                params.extend(tw)
        if tier:
            sql.append("  AND r.tier = ?")
            params.append(str(tier))
        if condition:
            sql.append("  AND r.condition = ?")
            params.append(str(condition))
        if era_stats_in:
            el = [str(v) for v in era_stats_in if v]
            want_empty = "__empty__" in el
            el = [v for v in el if v != "__empty__"]
            clauses = []
            if el:
                clauses.append(f"r.era_stats IN ({','.join('?' for _ in el)})")
                params.extend(el)
            if want_empty:
                clauses.append("(r.era_stats IS NULL OR r.era_stats = '')")
            if clauses:
                sql.append(f"  AND ({' OR '.join(clauses)})")
        if has_3d is not None:
            sql.append("  AND r.has_3d = ?")
            params.append(1 if has_3d else 0)
        if keyword:
            like = f"%{keyword}%"
            sql.append("  AND (r.name LIKE ? OR r.code LIKE ? OR r.address LIKE ?)")
            params.extend([like, like, like])

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
                "county": r["county"] or "",
                "condition": r["condition"] or "",
                "tier": r["tier"] or "city",
            }
            for r in rows
        ]

    def _query_bbox_memory(
        self, min_lng, min_lat, max_lng, max_lat,
        *, categories, ranks, county, township, tier, scope, condition,
        era_stats_in=None, has_3d=None, keyword=None, limit=2000,
    ) -> list[dict]:
        """JSON 模式下的视口查询 fallback。全量遍历,性能仅足以支撑千条级。"""
        from codes import normalize_category, normalize_rank

        rank_set = {str(v) for v in ranks} if ranks else None
        cat_set = {str(v) for v in categories} if categories else None
        town_set = {v.strip() for v in str(township).split(",") if v.strip()} if township else None
        out = []
        for r in self.relics:
            if not relic_in_scope(r, scope):
                continue
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
            if cat_set and cat_code not in cat_set:
                continue
            if rank_set and rk_code not in rank_set:
                continue
            if county and r.get("county") != county:
                continue
            if town_set and (r.get("township") or "") not in town_set:
                continue
            if tier and (r.get("tier") or "city") != tier:
                continue
            if condition and r.get("condition_level") != condition:
                continue
            if era_stats_in:
                es = r.get("era_stats") or ""
                eset = set(era_stats_in)
                if not (es in eset or (not es and "__empty__" in eset)):
                    continue
            if has_3d is not None and bool(r.get("has_3d")) != has_3d:
                continue
            if keyword:
                kw = keyword.lower()
                hay = " ".join(
                    str(r.get(f) or "") for f in ("name", "archive_code", "address")
                ).lower()
                if kw not in hay:
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
                "county": r.get("county") or "",
                "condition": r.get("condition_level") or "",
                "tier": r.get("tier") or "city",
            })
            if len(out) >= limit:
                break
        return out

    def search_fulltext(
        self,
        keyword: str,
        limit: int = 20,
        scope: str = SCOPE_PROTECTED,
    ) -> list[dict]:
        """FTS5 全文搜索,返回格式同 query_bbox。
        关键词 >= 3 字走 FTS5 trigram,< 3 字回退 LIKE。"""
        kw = (keyword or "").strip()
        if not kw:
            return []
        canonical_scope = normalize_relic_scope(scope)

        if not self._use_db:
            return self._peek_memory(kw, limit, canonical_scope)

        conn = self._thread_conn()
        scope_sql = (
            "AND r.rank IN ('1','2','3','4') "
            if canonical_scope == SCOPE_PROTECTED else ""
        )
        if len(kw) >= 3:
            sql = (
                "SELECT r.id, r.code, r.name, r.category, r.rank, r.lng, r.lat, r.has_3d, r.county "
                "FROM relics_fts f "
                "JOIN relics_rtree_map m ON m.id_int = f.rowid "
                "JOIN relics r ON r.id = m.relic_id "
                "WHERE f.relics_fts MATCH ? AND r.status = 1 "
                + scope_sql +
                "LIMIT ?"
            )
            # FTS5 MATCH 会按 trigram 切分,双引号需要转义。
            safe_kw = kw.replace('"', '""')
            rows = conn.execute(sql, (f'"{safe_kw}"', int(limit))).fetchall()
        else:
            sql = (
                "SELECT id, code, name, category, rank, lng, lat, has_3d, county "
                "FROM relics WHERE status = 1 "
                + scope_sql +
                "AND name LIKE ? LIMIT ?"
            )
            rows = conn.execute(sql, (f"%{kw}%", int(limit))).fetchall()

        return [
            {
                "id": r["id"], "code": r["code"], "name": r["name"],
                "lng": r["lng"], "lat": r["lat"],
                "category": r["category"], "rank": r["rank"],
                "has_3d": bool(r["has_3d"]),
                "county": r["county"] or "",
            }
            for r in rows
        ]

    def _peek_memory(self, kw: str, limit: int, scope: str = SCOPE_PROTECTED) -> list[dict]:
        """JSON fallback:按 name 子串过滤。"""
        out = []
        for r in self.relics:
            if not relic_in_scope(r, scope):
                continue
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
            arch = self.archive_map.get(code) or {}
            d["archives"] = arch
            if arch.get("sanpu"):
                d["has_archive_spu"] = True
            if arch.get("sipu"):
                d["has_archive_fpu"] = True
            return d
        d = self.relics_map.get(code)
        if d is not None:
            d = dict(d)
            d["archives"] = self.archive_map.get(code) or {}
        return d

    def polygons_of(self, code: str) -> list[dict]:
        """单条文物的两线范围面 [{kind, geometry}],仅 DB 模式有效。"""
        if not self._use_db:
            return []
        conn = self._thread_conn()
        rows = conn.execute(
            "SELECT kind, geom_geojson FROM polygons WHERE relic_code = ? ORDER BY kind DESC",
            (code,),
        ).fetchall()
        out = []
        for row in rows:
            try:
                out.append({"kind": row["kind"], "geometry": json.loads(row["geom_geojson"])})
            except json.JSONDecodeError:
                continue
        return out

    # ── 写入接口 (Admin) ─────────────────────────────────────
    # 乐观锁:UPDATE 必须匹配 expected_version,成功后 version += 1。
    # 所有写操作落 audit_log,记录 before_json / after_json 以便回溯。

    # 允许写入的列白名单(防止通过列名注入)。
    _WRITABLE = {
        "name", "category", "rank",
        "lng", "lat", "alt", "county", "township", "village", "address",
        "era", "era_stats", "tier", "condition",
        "has_3d", "has_archive_spu", "has_archive_fpu", "has_photo",
        "has_boundary", "photo_count", "drawing_count",
        "brief", "attachments", "extra_json", "status",
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
        cols = ["code", "name", "brief", "era", "county", "township", "village"]
        # attachments 列是后加的,旧库的 FTS 表可能没有
        fts_cols = {r[1] for r in conn.execute("PRAGMA table_info(relics_fts)")}
        if "attachments" in fts_cols:
            cols.append("attachments")
        conn.execute(
            f"INSERT INTO relics_fts ({', '.join(cols)}) "
            f"VALUES ({', '.join('?' for _ in cols)})",
            tuple(row.get(c) or "" for c in cols),
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
                    id, code, name, category, rank,
                    lng, lat, alt, county, township, village, address,
                    era, era_stats, tier, condition,
                    has_3d, has_archive_spu, has_archive_fpu, has_photo, has_boundary,
                    photo_count, drawing_count, brief, extra_json,
                    status, version, created_at, updated_at
                ) VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?)""",
                (
                    relic_id, code, name,
                    str(payload.get("category") or "0600"),
                    str(payload.get("rank") or "5"),
                    lng, lat,
                    float(payload["alt"]) if payload.get("alt") not in (None, "") else None,
                    payload.get("county"),
                    payload.get("township"), payload.get("village"), payload.get("address"),
                    payload.get("era"), payload.get("era_stats"),
                    payload.get("tier") or "city",
                    payload.get("condition"),
                    1 if payload.get("has_3d") else 0,
                    1 if payload.get("has_archive_spu") else 0,
                    1 if payload.get("has_archive_fpu") else 0,
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
                "county": payload.get("county"),
                "township": payload.get("township"),
                "village": payload.get("village"),
                "attachments": payload.get("attachments"),
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
            if any(k in patch for k in ("name", "brief", "era", "county", "township", "village", "attachments")):
                self._fts_upsert(conn, {
                    "code": row["code"], "name": row["name"],
                    "brief": row["brief"], "era": row["era"],
                    "county": row["county"],
                    "township": row["township"], "village": row["village"],
                    "attachments": row["attachments"] if "attachments" in row.keys() else "",
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

    # ── 工具 ────────────────────────────────────────────────
    @staticmethod
    def _read_csv(path: Path) -> list[dict]:
        with open(path, "r", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))


store = DataStore()
