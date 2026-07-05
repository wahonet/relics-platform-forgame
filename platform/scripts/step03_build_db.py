"""Step 03 | 把 step01 的产物灌入 SQLite。

读取 `data/output/dataset/` 下:
    relics_full.json           主数据(必需)
    photo_index.csv            照片索引(可选)
    drawing_index.csv          图纸索引(可选)
    relics_polygons.geojson    两线范围面(可选, properties.kind = protection|control)

输出: `data/output/dataset/relics.db`。幂等,每次运行全量重建。
巡查等业务数据在独立的 `data/output/patrol/patrol.db`,重建数据集不影响。

主要表:
- relics          业务主表,code 为业务主键,version 用于乐观锁
- relics_rtree    R-Tree 空间索引(bbox),通过 relics_rtree_map 桥接字符串 id
- relics_fts      FTS5 trigram tokenizer,支持中文子串搜索
- photos / drawings / polygons  关联资源
- audit_log       管理操作审计
- stats_cache     聚合结果(key → JSON)
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
import sys
import time
import uuid
from pathlib import Path

from _common import get_logger, get_paths
from codes import normalize_category, normalize_rank, parse_coord

log = get_logger("step03_build_db")


# ── Schema ──────────────────────────────────────────────────
SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS polygons;
DROP TABLE IF EXISTS drawings;
DROP TABLE IF EXISTS photos;
DROP TABLE IF EXISTS relics_fts;
DROP TABLE IF EXISTS relics_rtree_map;
DROP TABLE IF EXISTS relics_rtree;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS stats_cache;
DROP TABLE IF EXISTS relics;

-- 主表：每条文物一行。category / rank 存国标编码，展示时前端查字典。
CREATE TABLE relics (
    id           TEXT PRIMARY KEY,             -- uuid
    code         TEXT UNIQUE NOT NULL,         -- 编号 如 JN-JX-0284
    name         TEXT NOT NULL,
    category     TEXT NOT NULL,                -- '0100'..'0600' 国标
    rank         TEXT NOT NULL,                -- '1'..'5' (国/省/市/县/未定级)
    lng          REAL NOT NULL,                -- 十进制 WGS84
    lat          REAL NOT NULL,
    alt          REAL,
    county       TEXT,                         -- 县市区(全市视角的行政单元)
    township     TEXT,
    village      TEXT,
    address      TEXT,
    era          TEXT,
    era_stats    TEXT,
    tier         TEXT DEFAULT 'city',          -- city=市级基础层 full=县级全量层
    condition    TEXT,                         -- 保存状况 好/较好/一般/较差/差
    has_3d       INTEGER DEFAULT 0,
    has_archive_spu INTEGER DEFAULT 0,         -- 三普档案
    has_archive_fpu INTEGER DEFAULT 0,         -- 四普档案
    has_photo    INTEGER DEFAULT 0,
    has_boundary INTEGER DEFAULT 0,            -- 是否有两线范围面
    photo_count  INTEGER DEFAULT 0,
    drawing_count INTEGER DEFAULT 0,
    brief        TEXT,                         -- 简介（长文本，by-bbox 不查）
    extra_json   TEXT,                         -- 其余字段（保护范围、建控地带、权属等）
    status       INTEGER DEFAULT 1,            -- 1=正常 0=草稿 -1=下架
    version      INTEGER DEFAULT 1,            -- 乐观锁
    created_at   INTEGER,
    updated_at   INTEGER
);

CREATE INDEX idx_relics_cat       ON relics(category);
CREATE INDEX idx_relics_rank      ON relics(rank);
CREATE INDEX idx_relics_county    ON relics(county);
CREATE INDEX idx_relics_township  ON relics(township);
CREATE INDEX idx_relics_tier      ON relics(tier);
CREATE INDEX idx_relics_cond      ON relics(condition);
CREATE INDEX idx_relics_status    ON relics(status);

-- R-Tree 虚表只能存整数 id，用 relics_rtree_map 桥接字符串 id。
CREATE VIRTUAL TABLE relics_rtree USING rtree(
    id_int, min_lng, max_lng, min_lat, max_lat
);

CREATE TABLE relics_rtree_map (
    id_int   INTEGER PRIMARY KEY,
    relic_id TEXT UNIQUE NOT NULL REFERENCES relics(id) ON DELETE CASCADE
);

-- 全文搜索:trigram tokenizer(SQLite >= 3.34),对中文子串友好。
CREATE VIRTUAL TABLE relics_fts USING fts5(
    code, name, brief, era, county, township, village,
    tokenize = "trigram"
);

CREATE TABLE photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    relic_code  TEXT NOT NULL,
    path        TEXT NOT NULL,
    photo_no    TEXT,                            -- 照片号(Z001...)
    description TEXT,                            -- 文字说明(四普清单)
    thumb_path  TEXT,
    taken_at    INTEGER,
    UNIQUE(relic_code, path)
);
CREATE INDEX idx_photos_relic ON photos(relic_code);

CREATE TABLE drawings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    relic_code   TEXT NOT NULL,
    path         TEXT NOT NULL,
    drawing_no   TEXT,                           -- 图号(T001...)
    drawing_name TEXT,
    UNIQUE(relic_code, path)
);
CREATE INDEX idx_drawings_relic ON drawings(relic_code);

-- 两线范围: 一条文物最多两类面 (保护范围 protection / 建设控制地带 control)。
CREATE TABLE polygons (
    relic_code   TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'protection',
    geom_geojson TEXT NOT NULL,
    PRIMARY KEY (relic_code, kind)
);

CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor        TEXT,
    action       TEXT,                           -- create/update/delete
    relic_code   TEXT,
    before_json  TEXT,
    after_json   TEXT,
    ts           INTEGER
);

CREATE TABLE stats_cache (
    key         TEXT PRIMARY KEY,
    value_json  TEXT,
    updated_at  INTEGER
);
"""


def _bool(v) -> int:
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return 1 if v else 0
    if isinstance(v, str):
        return 1 if v.strip().lower() in ("1", "true", "yes", "y", "是", "有") else 0
    return 0


def _int_or_zero(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


# relics 主表保留的业务字段,其余统一塞入 extra_json。
_MAIN_FIELDS = {
    "archive_code", "name", "category_main", "heritage_level",
    "category_code", "rank_code",
    "center_lng", "center_lat", "center_alt", "county", "township", "village", "address",
    "era", "era_stats", "tier", "condition_level",
    "has_3d", "has_archive_spu", "has_archive_fpu", "has_boundary",
    "photo_count", "drawing_count", "intro",
}


def _load_relics_json(path: Path) -> list[dict]:
    if not path.exists():
        log.error("未找到 %s", path)
        sys.exit(1)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        log.error("relics_full.json 顶层不是数组")
        sys.exit(1)
    return data


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _insert_relics(conn: sqlite3.Connection, relics: list[dict],
                   boundary_codes: set[str]) -> int:
    now = int(time.time())
    inserted = 0
    skipped = 0
    cur = conn.cursor()

    for idx, r in enumerate(relics, start=1):
        code = (r.get("archive_code") or "").strip()
        name = (r.get("name") or "").strip()
        lng = parse_coord(r.get("center_lng"))
        lat = parse_coord(r.get("center_lat"))

        if not code or not name or lng is None or lat is None:
            log.warning("跳过缺字段记录: code=%r name=%r", code, name)
            skipped += 1
            continue

        alt = parse_coord(r.get("center_alt")) or 0.0
        category = r.get("category_code") or normalize_category(r.get("category_main"))
        rank = r.get("rank_code") or normalize_rank(r.get("heritage_level"))

        township_raw = r.get("township") or ""
        township = re.sub(r"^[\d_\-\s]+", "", township_raw).strip() or township_raw

        county = (r.get("county") or "").strip()
        village = r.get("village") or r.get("_village") or ""
        era = r.get("era") or ""
        era_stats = r.get("era_stats") or ""
        address = r.get("address") or ""
        brief = r.get("intro") or ""
        tier = r.get("tier") if r.get("tier") in ("city", "full") else "city"
        condition = r.get("condition_level") or ""

        has_3d = _bool(r.get("has_3d"))
        has_spu = _bool(r.get("has_archive_spu"))
        has_fpu = _bool(r.get("has_archive_fpu"))
        has_boundary = 1 if (code in boundary_codes or _bool(r.get("has_boundary"))) else 0
        photo_count = _int_or_zero(r.get("photo_count"))
        drawing_count = _int_or_zero(r.get("drawing_count"))
        has_photo = 1 if photo_count > 0 else 0

        extra = {k: v for k, v in r.items() if k not in _MAIN_FIELDS}
        extra_json = json.dumps(extra, ensure_ascii=False) if extra else "{}"

        relic_id = str(uuid.uuid4())

        cur.execute(
            """
            INSERT INTO relics (
                id, code, name, category, rank,
                lng, lat, alt, county, township, village, address, era, era_stats,
                tier, condition,
                has_3d, has_archive_spu, has_archive_fpu, has_photo, has_boundary,
                photo_count, drawing_count,
                brief, extra_json, status, version, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, 1, 1, ?, ?
            )
            """,
            (
                relic_id, code, name, category, rank,
                lng, lat, alt, county, township, village, address, era, era_stats,
                tier, condition,
                has_3d, has_spu, has_fpu, has_photo, has_boundary,
                photo_count, drawing_count,
                brief, extra_json, now, now,
            ),
        )

        cur.execute(
            "INSERT INTO relics_rtree_map (id_int, relic_id) VALUES (?, ?)",
            (idx, relic_id),
        )
        cur.execute(
            """
            INSERT INTO relics_rtree (id_int, min_lng, max_lng, min_lat, max_lat)
            VALUES (?, ?, ?, ?, ?)
            """,
            (idx, lng, lng, lat, lat),
        )
        cur.execute(
            """
            INSERT INTO relics_fts (rowid, code, name, brief, era, county, township, village)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (idx, code, name, brief, era, county, township, village),
        )

        inserted += 1

    if skipped:
        log.warning("共跳过 %d 条数据（缺关键字段）", skipped)
    return inserted


def _insert_assets(conn: sqlite3.Connection, photos: list[dict], drawings: list[dict]) -> tuple[int, int]:
    cur = conn.cursor()

    photo_rows = 0
    for p in photos:
        code = (p.get("archive_code") or "").strip()
        path = (p.get("path") or p.get("relative_path") or p.get("photo") or "").strip()
        if not code or not path:
            continue
        try:
            cur.execute(
                "INSERT OR IGNORE INTO photos (relic_code, path, photo_no, description, thumb_path)"
                " VALUES (?, ?, ?, ?, ?)",
                (code, path, p.get("photo_no") or None, p.get("description") or None,
                 p.get("thumb_path") or None),
            )
            if cur.rowcount:
                photo_rows += 1
        except sqlite3.Error as e:
            log.warning("插入 photo 失败 code=%s path=%s: %s", code, path, e)

    drawing_rows = 0
    for d in drawings:
        code = (d.get("archive_code") or "").strip()
        path = (d.get("path") or d.get("relative_path") or d.get("drawing") or "").strip()
        if not code or not path:
            continue
        try:
            cur.execute(
                "INSERT OR IGNORE INTO drawings (relic_code, path, drawing_no, drawing_name)"
                " VALUES (?, ?, ?, ?)",
                (code, path, d.get("drawing_no") or None, d.get("drawing_name") or None),
            )
            if cur.rowcount:
                drawing_rows += 1
        except sqlite3.Error as e:
            log.warning("插入 drawing 失败 code=%s path=%s: %s", code, path, e)

    return photo_rows, drawing_rows


def _load_polygons(geojson_path: Path) -> list[tuple[str, str, str]]:
    """返回 [(code, kind, geom_json)]。kind 取 properties.kind,默认 protection。"""
    if not geojson_path.exists():
        return []
    with geojson_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    out = []
    for feat in data.get("features") or []:
        props = feat.get("properties") or {}
        code = (props.get("archive_code") or props.get("code") or "").strip()
        geom = feat.get("geometry")
        if not code or not geom:
            continue
        kind = props.get("kind") or "protection"
        if kind not in ("protection", "control", "body"):
            kind = "protection"
        out.append((code, kind, json.dumps(geom, ensure_ascii=False)))
    return out


def _refresh_has_photo(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE relics
           SET has_photo = CASE
                WHEN EXISTS (SELECT 1 FROM photos p WHERE p.relic_code = relics.code) THEN 1
                ELSE has_photo
           END
        """
    )


def build_db(db_path: Path, dataset_dir: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # 原地重建(SCHEMA_SQL 自带 DROP TABLE):不删除文件,
    # 这样 WebGIS 服务运行期间也能重建(Windows 上被打开的文件无法 unlink)。
    # WAL 模式下服务端读连接不阻塞本次写入,重建完成后新查询立即看到新数据。
    log.info("[DB] %s %s", "重建" if db_path.exists() else "创建", db_path)
    conn = sqlite3.connect(str(db_path), timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=30000;")
        conn.executescript(SCHEMA_SQL)

        relics = _load_relics_json(dataset_dir / "relics_full.json")
        log.info("[DB] 读到 %d 条文物", len(relics))

        polygons = _load_polygons(dataset_dir / "relics_polygons.geojson")
        boundary_codes = {code for code, _, _ in polygons}

        n_relics = _insert_relics(conn, relics, boundary_codes)
        log.info("[DB] 已插入 relics %d 行", n_relics)

        photos = _read_csv(dataset_dir / "photo_index.csv")
        drawings = _read_csv(dataset_dir / "drawing_index.csv")
        n_photos, n_drawings = _insert_assets(conn, photos, drawings)
        log.info("[DB] 已插入 photos %d 行 / drawings %d 行", n_photos, n_drawings)

        cur = conn.cursor()
        for code, kind, geom in polygons:
            cur.execute(
                "INSERT OR REPLACE INTO polygons (relic_code, kind, geom_geojson) VALUES (?, ?, ?)",
                (code, kind, geom),
            )
        log.info("[DB] 已插入 polygons %d 行", len(polygons))

        _refresh_has_photo(conn)

        conn.commit()
        conn.execute("ANALYZE;")
        conn.commit()
    finally:
        conn.close()

    size_kb = db_path.stat().st_size / 1024
    log.info("[DB] 完成。数据库大小 %.1f KB", size_kb)


def main() -> int:
    paths = get_paths()
    dataset_dir = paths.output_dataset
    db_path = dataset_dir / "relics.db"

    if not (dataset_dir / "relics_full.json").exists():
        log.error("请先运行 step01 生成 relics_full.json")
        return 2

    t0 = time.time()
    build_db(db_path, dataset_dir)
    log.info("[DB] 总耗时 %.2fs", time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
