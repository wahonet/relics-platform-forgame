"""Step 07 | 把 step02 ~ step04 / step06 的产物灌入 SQLite。

读取 `data/output/dataset/` 下:
    relics_full.json           主数据(必需)
    photo_index.csv            照片索引(可选)
    drawing_index.csv          图纸索引(可选)
    relics_polygons.geojson    面几何(可选)

输出: `data/output/dataset/relics.db`。幂等,每次运行全量重建。

主要表:
- relics          业务主表,code 为业务主键,version 用于乐观锁
- relics_rtree    R-Tree 空间索引(bbox),通过 relics_rtree_map 桥接字符串 id
- relics_fts      FTS5 trigram tokenizer,支持中文子串搜索
- photos / drawings / polygons  关联资源
- audit_log       管理操作审计
- stats_cache     聚合结果(key → JSON),Admin 写入后异步刷新
"""
from __future__ import annotations

import csv
import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path

from _common import PROJECT_ROOT, get_logger, get_paths
from codes import (
    normalize_category,
    normalize_rank,
    normalize_search_type,
    parse_coord,
)

log = get_logger("step07_build_db")


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
    code         TEXT UNIQUE NOT NULL,         -- 档案号 如 370829-0284
    name         TEXT NOT NULL,
    category     TEXT NOT NULL,                -- '0100'..'0600' 国标
    rank         TEXT NOT NULL,                -- '1'..'5'
    search_type  TEXT,                         -- '2'/'12'/'110301'
    lng          REAL NOT NULL,                -- 十进制 WGS84
    lat          REAL NOT NULL,
    alt          REAL,
    township     TEXT,
    village      TEXT,
    address      TEXT,
    era          TEXT,
    era_stats    TEXT,
    has_3d       INTEGER DEFAULT 0,
    has_pdf      INTEGER DEFAULT 0,
    has_photo    INTEGER DEFAULT 0,
    has_boundary INTEGER DEFAULT 0,
    photo_count  INTEGER DEFAULT 0,
    drawing_count INTEGER DEFAULT 0,
    brief        TEXT,                         -- intro 简介（长文本，by-bbox 不查）
    extra_json   TEXT,                         -- 其余字段（owner、industry、risk_factors 等）
    status       INTEGER DEFAULT 1,            -- 1=正常 0=草稿 -1=下架
    version      INTEGER DEFAULT 1,            -- 乐观锁
    created_at   INTEGER,
    updated_at   INTEGER
);

CREATE INDEX idx_relics_cat       ON relics(category);
CREATE INDEX idx_relics_rank      ON relics(rank);
CREATE INDEX idx_relics_township  ON relics(township);
CREATE INDEX idx_relics_status    ON relics(status);
CREATE INDEX idx_relics_search    ON relics(search_type);

-- R-Tree 虚表只能存整数 id，用 relics_rtree_map 桥接字符串 id。
CREATE VIRTUAL TABLE relics_rtree USING rtree(
    id_int, min_lng, max_lng, min_lat, max_lat
);

CREATE TABLE relics_rtree_map (
    id_int   INTEGER PRIMARY KEY,
    relic_id TEXT UNIQUE NOT NULL REFERENCES relics(id) ON DELETE CASCADE
);

-- 全文搜索:trigram tokenizer(SQLite >= 3.34),对中文子串友好。
-- 若 SQLite 未编译 trigram,可回退 unicode61 但不支持中文分词。
CREATE VIRTUAL TABLE relics_fts USING fts5(
    code, name, brief, era, township, village,
    tokenize = "trigram"
);

CREATE TABLE photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    relic_code  TEXT NOT NULL,
    path        TEXT NOT NULL,
    thumb_path  TEXT,
    taken_at    INTEGER,
    UNIQUE(relic_code, path)
);
CREATE INDEX idx_photos_relic ON photos(relic_code);

CREATE TABLE drawings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    relic_code  TEXT NOT NULL,
    path        TEXT NOT NULL,
    UNIQUE(relic_code, path)
);
CREATE INDEX idx_drawings_relic ON drawings(relic_code);

CREATE TABLE polygons (
    relic_code   TEXT PRIMARY KEY,
    geom_geojson TEXT NOT NULL
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
    "archive_code", "name", "category_main", "heritage_level", "survey_type",
    "center_lng", "center_lat", "center_alt", "township", "address",
    "era", "era_stats", "has_3d", "has_boundary", "photo_count", "drawing_count",
    "intro", "boundary_points",
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


def _insert_relics(conn: sqlite3.Connection, relics: list[dict], pdf_map: dict[str, str]) -> int:
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
        category = normalize_category(r.get("category_main"))
        rank = normalize_rank(r.get("heritage_level"))
        search_type = normalize_search_type(r.get("survey_type"))

        township_raw = r.get("township") or ""
        # 去掉乡镇名的排序前缀(如 "01示范街道") 再入库。
        import re
        township = re.sub(r"^[\d_\-\s]+", "", township_raw).strip() or township_raw

        village = r.get("village") or r.get("_village") or ""
        era = r.get("era") or ""
        era_stats = r.get("era_stats") or ""
        address = r.get("address") or ""
        brief = r.get("intro") or ""

        has_3d = _bool(r.get("has_3d"))
        has_boundary = _bool(r.get("has_boundary"))
        photo_count = _int_or_zero(r.get("photo_count"))
        drawing_count = _int_or_zero(r.get("drawing_count"))
        has_photo = 1 if photo_count > 0 else 0
        has_pdf = 1 if pdf_map.get(code) else 0

        # 非主字段整体塞入 extra_json,供详情页与老前端使用。
        extra = {k: v for k, v in r.items() if k not in _MAIN_FIELDS}
        extra_json = json.dumps(extra, ensure_ascii=False) if extra else "{}"

        relic_id = str(uuid.uuid4())

        cur.execute(
            """
            INSERT INTO relics (
                id, code, name, category, rank, search_type,
                lng, lat, alt, township, village, address, era, era_stats,
                has_3d, has_pdf, has_photo, has_boundary,
                photo_count, drawing_count,
                brief, extra_json, status, version, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, 1, 1, ?, ?
            )
            """,
            (
                relic_id, code, name, category, rank, search_type,
                lng, lat, alt, township, village, address, era, era_stats,
                has_3d, has_pdf, has_photo, has_boundary,
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
            INSERT INTO relics_fts (rowid, code, name, brief, era, township, village)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (idx, code, name, brief, era, township, village),
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
        path = (p.get("path") or p.get("photo") or "").strip()
        if not code or not path:
            continue
        try:
            cur.execute(
                "INSERT OR IGNORE INTO photos (relic_code, path, thumb_path) VALUES (?, ?, ?)",
                (code, path, p.get("thumb_path") or None),
            )
            if cur.rowcount:
                photo_rows += 1
        except sqlite3.Error as e:
            log.warning("插入 photo 失败 code=%s path=%s: %s", code, path, e)

    drawing_rows = 0
    for d in drawings:
        code = (d.get("archive_code") or "").strip()
        path = (d.get("path") or d.get("drawing") or "").strip()
        if not code or not path:
            continue
        try:
            cur.execute(
                "INSERT OR IGNORE INTO drawings (relic_code, path) VALUES (?, ?)",
                (code, path),
            )
            if cur.rowcount:
                drawing_rows += 1
        except sqlite3.Error as e:
            log.warning("插入 drawing 失败 code=%s path=%s: %s", code, path, e)

    return photo_rows, drawing_rows


def _insert_polygons(conn: sqlite3.Connection, geojson_path: Path) -> int:
    if not geojson_path.exists():
        return 0
    with geojson_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    features = data.get("features") or []
    cur = conn.cursor()
    n = 0
    for feat in features:
        props = feat.get("properties") or {}
        code = (props.get("archive_code") or "").strip()
        geom = feat.get("geometry")
        if not code or not geom:
            continue
        try:
            cur.execute(
                "INSERT OR REPLACE INTO polygons (relic_code, geom_geojson) VALUES (?, ?)",
                (code, json.dumps(geom, ensure_ascii=False)),
            )
            n += 1
        except sqlite3.Error as e:
            log.warning("插入 polygon 失败 code=%s: %s", code, e)
    return n


def _scan_pdf_dir(pdf_dir: Path) -> dict[str, str]:
    """扫描 `data/input/01_archives_pdf/<code>/*.pdf`,返回 `{code: first_pdf}`。"""
    result: dict[str, str] = {}
    if not pdf_dir.exists():
        return result
    for sub in pdf_dir.iterdir():
        if not sub.is_dir():
            continue
        pdfs = sorted(sub.glob("*.pdf"))
        if pdfs:
            result[sub.name] = f"{sub.name}/{pdfs[0].name}"
    return result


def _refresh_has_photo(conn: sqlite3.Connection) -> None:
    """根据 photos 表实际记录回填 relics.has_photo。"""
    conn.execute(
        """
        UPDATE relics
           SET has_photo = CASE
                WHEN EXISTS (SELECT 1 FROM photos p WHERE p.relic_code = relics.code) THEN 1
                ELSE has_photo
           END
        """
    )


def build_db(db_path: Path, dataset_dir: Path, pdf_dir: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # 全量重建:先删后建。
    if db_path.exists():
        db_path.unlink()

    log.info("[DB] 创建 %s", db_path)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(SCHEMA_SQL)

        relics = _load_relics_json(dataset_dir / "relics_full.json")
        log.info("[DB] 读到 %d 条文物", len(relics))

        pdf_map = _scan_pdf_dir(pdf_dir)
        if pdf_map:
            log.info("[DB] 匹配到 %d 个档案 PDF", len(pdf_map))

        n_relics = _insert_relics(conn, relics, pdf_map)
        log.info("[DB] 已插入 relics %d 行", n_relics)

        photos = _read_csv(dataset_dir / "photo_index.csv")
        drawings = _read_csv(dataset_dir / "drawing_index.csv")
        n_photos, n_drawings = _insert_assets(conn, photos, drawings)
        log.info("[DB] 已插入 photos %d 行 / drawings %d 行", n_photos, n_drawings)

        n_poly = _insert_polygons(conn, dataset_dir / "relics_polygons.geojson")
        log.info("[DB] 已插入 polygons %d 行", n_poly)

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
    pdf_dir = PROJECT_ROOT / "data" / "input" / "01_archives_pdf"
    db_path = dataset_dir / "relics.db"

    if not (dataset_dir / "relics_full.json").exists():
        log.error("请先运行 step02 生成 relics_full.json")
        return 2

    t0 = time.time()
    build_db(db_path, dataset_dir, pdf_dir)
    log.info("[DB] 总耗时 %.2fs", time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
