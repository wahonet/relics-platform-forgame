"""巡查业务库与核心逻辑。

独立 SQLite (data/output/patrol/patrol.db),与数据集库 relics.db 分离——
重建数据集不影响巡查历史。

表:
- patrol_routes    巡查路线 (relic_codes 有序 JSON, token 供移动端扫码)
- patrol_records   打卡记录 (照片、定位比对、AI 评估)

巡查频次策略(可在 config.patrol.frequency_days 覆盖):
    差 → 30 天 / 较差 → 60 / 一般 → 90 / 较好 → 180 / 好 → 180
"""
from __future__ import annotations

import json
import math
import secrets
import sqlite3
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, Optional

DEFAULT_FREQUENCY_DAYS = {"差": 30, "较差": 60, "一般": 90, "较好": 180, "好": 180}
_FALLBACK_DAYS = 120  # 状况未知时

_LEVEL_ORDER = {"1": 0, "2": 1, "3": 2, "4": 3, "5": 4}

SCHEMA = """
CREATE TABLE IF NOT EXISTS patrol_routes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    plan_date    TEXT,                          -- YYYY-MM-DD
    mode         TEXT DEFAULT 'manual',         -- manual / area / ai / monthly
    relic_codes  TEXT NOT NULL,                 -- JSON 有序数组
    note         TEXT,
    token        TEXT UNIQUE NOT NULL,          -- 移动端访问令牌(二维码)
    status       TEXT DEFAULT 'planned',        -- planned / in_progress / done
    distance_m   REAL,
    duration_s   REAL,
    polyline     TEXT,                          -- 高德路径 JSON [[lng,lat],...] (WGS84)
    created_by   TEXT,
    created_at   INTEGER,
    updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS patrol_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id      INTEGER NOT NULL REFERENCES patrol_routes(id) ON DELETE CASCADE,
    relic_code    TEXT NOT NULL,
    photo_path    TEXT,                         -- 相对 data/output/patrol/photos/
    photo_lat     REAL,
    photo_lng     REAL,
    gps_source    TEXT,                         -- exif / browser / none
    distance_m    REAL,                         -- 照片定位与文物坐标距离
    verified      INTEGER DEFAULT 0,            -- 1=现场核验通过 0=未通过/无定位
    note          TEXT,
    ai_condition  TEXT,                         -- AI 判定保存状况
    ai_summary    TEXT,                         -- AI 评估说明
    created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_precords_route ON patrol_records(route_id);
CREATE INDEX IF NOT EXISTS idx_precords_code  ON patrol_records(relic_code);
"""


def haversine_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """两点球面距离(米)。"""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def order_nearest_neighbor(points: list[dict], start: Optional[tuple[float, float]] = None) -> list[dict]:
    """最近邻贪心排序巡查点(TSP 近似,点数 <= 30 足够好)。
    points: [{code, lng, lat, ...}]"""
    if len(points) <= 2:
        return list(points)
    remain = list(points)
    ordered: list[dict] = []
    if start is None:
        cur = remain.pop(0)
    else:
        idx = min(range(len(remain)),
                  key=lambda i: haversine_m(start[0], start[1], remain[i]["lng"], remain[i]["lat"]))
        cur = remain.pop(idx)
    ordered.append(cur)
    while remain:
        idx = min(range(len(remain)),
                  key=lambda i: haversine_m(cur["lng"], cur["lat"], remain[i]["lng"], remain[i]["lat"]))
        cur = remain.pop(idx)
        ordered.append(cur)
    return ordered


class PatrolDB:
    def __init__(self) -> None:
        self._db_path: Optional[Path] = None
        self._tls = threading.local()
        self.photos_dir: Optional[Path] = None
        self.frequency_days: dict[str, int] = dict(DEFAULT_FREQUENCY_DAYS)

    def init(self, patrol_dir: str | Path, frequency_days: Optional[dict] = None) -> None:
        d = Path(patrol_dir)
        d.mkdir(parents=True, exist_ok=True)
        self._db_path = d / "patrol.db"
        self.photos_dir = d / "photos"
        self.photos_dir.mkdir(parents=True, exist_ok=True)
        if frequency_days:
            merged = dict(DEFAULT_FREQUENCY_DAYS)
            for k, v in frequency_days.items():
                try:
                    merged[str(k)] = int(v)
                except (TypeError, ValueError):
                    continue
            self.frequency_days = merged
        conn = self._conn()
        conn.executescript(SCHEMA)
        conn.commit()

    def _conn(self) -> sqlite3.Connection:
        if not self._db_path:
            raise RuntimeError("PatrolDB 未初始化")
        c = getattr(self._tls, "conn", None)
        if c is None:
            c = sqlite3.connect(str(self._db_path), check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL;")
            c.execute("PRAGMA foreign_keys=ON;")
            self._tls.conn = c
        return c

    @property
    def ready(self) -> bool:
        return self._db_path is not None

    # ── 路线 CRUD ───────────────────────────────────────────
    def create_route(
        self,
        *,
        name: str,
        relic_codes: list[str],
        plan_date: str = "",
        mode: str = "manual",
        note: str = "",
        created_by: str = "",
        distance_m: Optional[float] = None,
        duration_s: Optional[float] = None,
        polyline: Optional[list] = None,
    ) -> dict:
        if not relic_codes:
            raise ValueError("路线至少需要 1 处文物")
        now = int(time.time())
        token = secrets.token_urlsafe(12)
        conn = self._conn()
        cur = conn.execute(
            """INSERT INTO patrol_routes
               (name, plan_date, mode, relic_codes, note, token, status,
                distance_m, duration_s, polyline, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?, 'planned', ?,?,?,?,?,?)""",
            (
                name, plan_date or date.today().isoformat(), mode,
                json.dumps(list(relic_codes), ensure_ascii=False), note, token,
                distance_m, duration_s,
                json.dumps(polyline, ensure_ascii=False) if polyline else None,
                created_by, now, now,
            ),
        )
        conn.commit()
        return self.get_route(int(cur.lastrowid))

    def update_route(self, route_id: int, patch: dict) -> dict:
        allowed = {"name", "plan_date", "note", "status", "relic_codes",
                   "distance_m", "duration_s", "polyline"}
        sets, params = [], []
        for k, v in patch.items():
            if k not in allowed:
                continue
            if k in ("relic_codes", "polyline") and not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            sets.append(f"{k} = ?")
            params.append(v)
        if not sets:
            raise ValueError("没有可更新的字段")
        sets.append("updated_at = ?")
        params.append(int(time.time()))
        params.append(route_id)
        conn = self._conn()
        conn.execute(f"UPDATE patrol_routes SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        return self.get_route(route_id)

    def delete_route(self, route_id: int) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM patrol_routes WHERE id = ?", (route_id,))
        conn.commit()

    def get_route(self, route_id: int) -> Optional[dict]:
        row = self._conn().execute(
            "SELECT * FROM patrol_routes WHERE id = ?", (route_id,)).fetchone()
        return self._route_row(row) if row else None

    def get_route_by_token(self, token: str) -> Optional[dict]:
        row = self._conn().execute(
            "SELECT * FROM patrol_routes WHERE token = ?", (token,)).fetchone()
        return self._route_row(row) if row else None

    def list_routes(self, *, limit: int = 100, status: Optional[str] = None) -> list[dict]:
        sql = "SELECT * FROM patrol_routes"
        params: list = []
        if status:
            sql += " WHERE status = ?"
            params.append(status)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [self._route_row(r) for r in self._conn().execute(sql, params).fetchall()]

    @staticmethod
    def _route_row(row: sqlite3.Row) -> dict:
        d = {k: row[k] for k in row.keys()}
        try:
            d["relic_codes"] = json.loads(d.get("relic_codes") or "[]")
        except json.JSONDecodeError:
            d["relic_codes"] = []
        if d.get("polyline"):
            try:
                d["polyline"] = json.loads(d["polyline"])
            except json.JSONDecodeError:
                d["polyline"] = None
        return d

    # ── 打卡记录 ────────────────────────────────────────────
    def add_record(
        self,
        *,
        route_id: int,
        relic_code: str,
        photo_path: str = "",
        photo_lat: Optional[float] = None,
        photo_lng: Optional[float] = None,
        gps_source: str = "none",
        distance_m: Optional[float] = None,
        verified: bool = False,
        note: str = "",
    ) -> dict:
        conn = self._conn()
        cur = conn.execute(
            """INSERT INTO patrol_records
               (route_id, relic_code, photo_path, photo_lat, photo_lng,
                gps_source, distance_m, verified, note, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (route_id, relic_code, photo_path, photo_lat, photo_lng,
             gps_source, distance_m, 1 if verified else 0, note, int(time.time())),
        )
        conn.execute(
            "UPDATE patrol_routes SET status = CASE WHEN status='planned' THEN 'in_progress' ELSE status END,"
            " updated_at = ? WHERE id = ?",
            (int(time.time()), route_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM patrol_records WHERE id = ?", (cur.lastrowid,)).fetchone()
        return {k: row[k] for k in row.keys()}

    def set_record_ai(self, record_id: int, condition: str, summary: str) -> None:
        conn = self._conn()
        conn.execute(
            "UPDATE patrol_records SET ai_condition = ?, ai_summary = ? WHERE id = ?",
            (condition, summary, record_id),
        )
        conn.commit()

    def list_records(self, *, route_id: Optional[int] = None,
                     relic_code: Optional[str] = None, limit: int = 500) -> list[dict]:
        sql = "SELECT * FROM patrol_records"
        conds, params = [], []
        if route_id is not None:
            conds.append("route_id = ?")
            params.append(route_id)
        if relic_code:
            conds.append("relic_code = ?")
            params.append(relic_code)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        rows = self._conn().execute(sql, params).fetchall()
        return [{k: r[k] for k in r.keys()} for r in rows]

    def get_record(self, record_id: int) -> Optional[dict]:
        row = self._conn().execute(
            "SELECT * FROM patrol_records WHERE id = ?", (record_id,)).fetchone()
        return {k: row[k] for k in row.keys()} if row else None

    def last_patrol_map(self) -> dict[str, int]:
        """{relic_code: 最近一次打卡时间戳}"""
        rows = self._conn().execute(
            "SELECT relic_code, MAX(created_at) AS ts FROM patrol_records GROUP BY relic_code"
        ).fetchall()
        return {r["relic_code"]: r["ts"] for r in rows}

    # ── 巡查到期计算 ────────────────────────────────────────
    def freq_days_for(self, condition: str) -> int:
        return self.frequency_days.get(condition or "", _FALLBACK_DAYS)

    def compute_due(self, relics: Iterable[dict], *, today: Optional[date] = None) -> list[dict]:
        """按保存状况频次策略,计算逾期/临期文物清单。

        relics 项需含 archive_code/name/condition_level/center_lng/center_lat,
        可选 last_patrol_at (ISO 日期,演示种子)。
        返回按逾期天数降序的列表,附 due_in_days(负数=已逾期)。
        """
        today = today or date.today()
        last_map = self.last_patrol_map() if self.ready else {}
        out = []
        for r in relics:
            code = r.get("archive_code") or ""
            cond = r.get("condition_level") or ""
            freq = self.freq_days_for(cond)

            ts = last_map.get(code)
            if ts:
                last = date.fromtimestamp(ts)
            else:
                seed = r.get("last_patrol_at") or ""
                try:
                    last = datetime.strptime(str(seed)[:10], "%Y-%m-%d").date()
                except ValueError:
                    last = None
            if last is None:
                overdue = freq  # 从未巡查,视为整周期逾期
                last_str = ""
            else:
                overdue = (today - last).days - freq
                last_str = last.isoformat()
            out.append({
                "archive_code": code,
                "name": r.get("name") or "",
                "county": r.get("county") or "",
                "township": r.get("township") or "",
                "condition_level": cond,
                "heritage_level": r.get("heritage_level") or "",
                "lng": r.get("center_lng"),
                "lat": r.get("center_lat"),
                "freq_days": freq,
                "last_patrol": last_str,
                "due_in_days": -overdue,
                "rank_order": _LEVEL_ORDER.get(str(r.get("_rank_code") or "5"), 4),
            })
        out.sort(key=lambda x: (x["due_in_days"], x["rank_order"]))
        return out


patrol_db = PatrolDB()
