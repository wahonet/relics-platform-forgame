"""文物巡查模块 API。

PC 端(/api/patrol/*):路线规划(手选/片区/AI)、路线管理、二维码、AI 评估、巡查报告
移动端(/api/m/*, /m/r/{token}):扫码打开 H5、高德导航、拍照打卡(EXIF 定位比对)

设计要点:
- 保存状况决定巡查频次(差 30 天 → 好 180 天,config.patrol.frequency_days 可调)
- AI 规划: LLM 解析意图,规则兜底;点位排序用最近邻;配了高德 key 则调真实驾车路径
- 打卡核验: 优先读照片 EXIF GPS,缺失时用浏览器定位;与文物坐标距离 <= verify_radius_m 判定到场
"""
from __future__ import annotations

import calendar
import io
import re
import sys
import time
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from data_loader import store  # noqa: E402
from services import ai_service, amap_service  # noqa: E402
from services.exif_gps import extract_gps  # noqa: E402
from services.patrol_service import haversine_m, order_nearest_neighbor, patrol_db  # noqa: E402

router = APIRouter(tags=["巡查"])
mobile_router = APIRouter(tags=["巡查-移动端"])

# 运行时配置(init_patrol 填充)
_VERIFY_RADIUS_M = 200.0
_SUSPECT_RADIUS_M = 500.0
_PUBLIC_BASE_URL = ""
_SERVER_PORT = 8000
_PHOTOS_ROOT: Optional[Path] = None
_OUTPUT_PHOTOS: Optional[Path] = None
_TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "templates" / "mobile_route.html"


def init_patrol(cfg: dict, paths) -> None:
    global _VERIFY_RADIUS_M, _SUSPECT_RADIUS_M, _PUBLIC_BASE_URL, _SERVER_PORT
    global _PHOTOS_ROOT, _OUTPUT_PHOTOS
    pc = cfg.get("patrol") or {}
    _VERIFY_RADIUS_M = float(pc.get("verify_radius_m", 200))
    _SUSPECT_RADIUS_M = float(pc.get("suspect_radius_m", 500))
    _PUBLIC_BASE_URL = str((cfg.get("server") or {}).get("public_base_url") or "").rstrip("/")
    _SERVER_PORT = int((cfg.get("server") or {}).get("port", 8000))
    patrol_db.init(paths.output_patrol, pc.get("frequency_days"))
    _PHOTOS_ROOT = patrol_db.photos_dir
    _OUTPUT_PHOTOS = paths.output_photos
    amap_service.init(((cfg.get("api") or {}).get("amap") or {}).get("web_key", ""))


# ── 工具 ────────────────────────────────────────────────────
def _is_private_ip(ip: str) -> bool:
    return (ip.startswith("192.168.") or ip.startswith("10.")
            or any(ip.startswith(f"172.{i}.") for i in range(16, 32)))


def _lan_ip() -> str:
    """探测本机局域网 IP(供手机扫码访问)。
    透明代理(fake-IP)环境下 UDP 探测可能拿到保留段地址,需过滤后回退接口枚举。"""
    import socket

    candidates: list[str] = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("223.5.5.5", 80))
        candidates.append(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass
    for ip in candidates:
        if _is_private_ip(ip):
            return ip
    for ip in candidates:
        if not ip.startswith("127.") and not ip.startswith("169.254."):
            return ip
    return "127.0.0.1"


def _base_url(request: Optional[Request] = None) -> str:
    """移动端访问用的基地址:优先 config.server.public_base_url,否则探测局域网 IP。"""
    if _PUBLIC_BASE_URL:
        return _PUBLIC_BASE_URL
    return f"http://{_lan_ip()}:{_SERVER_PORT}"


def _stop_of(code: str) -> Optional[dict]:
    r = store.get_relic(code)
    if not r:
        return None
    return {
        "code": code,
        "name": r.get("name") or "",
        "lng": r.get("center_lng"),
        "lat": r.get("center_lat"),
        "county": r.get("county") or "",
        "township": r.get("township") or "",
        "address": r.get("address") or "",
        "condition": r.get("condition_level") or "",
        "heritage_level": r.get("heritage_level") or "",
        "category": r.get("category_main") or "",
    }


def _resolve_stops(codes: list[str]) -> list[dict]:
    stops = []
    for c in codes:
        s = _stop_of(c)
        if s and s["lng"] is not None and s["lat"] is not None:
            stops.append(s)
    return stops


def _route_payload(route: dict, *, with_records: bool = False, request: Optional[Request] = None) -> dict:
    stops = _resolve_stops(route["relic_codes"])
    records = patrol_db.list_records(route_id=route["id"])
    checked = {r["relic_code"] for r in records}
    verified = {r["relic_code"] for r in records if r["verified"]}
    d = {
        **route,
        "stops": stops,
        "stop_count": len(stops),
        "checked_count": len(checked & {s["code"] for s in stops}),
        "verified_count": len(verified & {s["code"] for s in stops}),
        "mobile_url": f"{_base_url(request)}/m/r/{route['token']}",
    }
    if with_records:
        d["records"] = records
    return d


def _straight_stats(stops: list[dict]) -> tuple[float, float]:
    """直线距离合计与估算时长(40km/h)。"""
    dist = 0.0
    for a, b in zip(stops, stops[1:]):
        dist += haversine_m(a["lng"], a["lat"], b["lng"], b["lat"])
    return dist, dist / (40000 / 3600)


def _plan_geometry(stops: list[dict], start: Optional[dict] = None) -> dict:
    """尝试高德路径;失败用直线。返回 {distance_m, duration_s, polyline, source}。
    start 为可选出发点 {lng, lat},提供时路线几何从出发点开始。"""
    seq = list(stops)
    if start and start.get("lng") is not None and start.get("lat") is not None:
        seq = [{"lng": float(start["lng"]), "lat": float(start["lat"])}] + seq
    pts = [(s["lng"], s["lat"]) for s in seq]
    if len(pts) >= 2:
        amap = amap_service.plan_driving_route(pts)
        if amap:
            return {**amap, "source": "amap"}
    dist, dur = _straight_stats(seq)
    return {
        "distance_m": dist,
        "duration_s": dur,
        "polyline": [[s["lng"], s["lat"]] for s in seq],
        "source": "straight",
    }


# ── 配置与到期清单 ──────────────────────────────────────────
@router.get("/patrol/config")
async def patrol_config():
    return {
        "frequency_days": patrol_db.frequency_days,
        "verify_radius_m": _VERIFY_RADIUS_M,
        "suspect_radius_m": _SUSPECT_RADIUS_M,
        "amap_enabled": amap_service.has_key(),
        "ai_enabled": ai_service.ready(),
    }


@router.get("/patrol/due")
async def patrol_due(
    county: str | None = Query(None),
    only_overdue: bool = Query(False),
    limit: int = Query(100, ge=1, le=2000),
):
    """按保存状况频次策略计算的巡查到期清单(due_in_days<0 已逾期)。"""
    relics = store.relics
    if county:
        relics = [r for r in relics if (r.get("county") or "") == county]
    due = patrol_db.compute_due(relics)
    if only_overdue:
        due = [d for d in due if d["due_in_days"] < 0]
    return {"data": due[:limit], "total": len(due)}


# ── AI / 规则规划 ───────────────────────────────────────────
# 单日巡查最多 30 处:即使用户要求 100 处,也按 30 截断。
MAX_STOPS_HARD_LIMIT = 30


class PlanRequest(BaseModel):
    text: str
    max_stops: int = MAX_STOPS_HARD_LIMIT


def _find_relic_by_name(name: str) -> Optional[dict]:
    name = (name or "").strip()
    if not name:
        return None
    # 精确 → 包含 → FTS
    for r in store.relics:
        if r.get("name") == name:
            return r
    for r in store.relics:
        if name in (r.get("name") or ""):
            return r
    hits = store.search_fulltext(name, limit=1)
    if hits:
        return store.get_relic(hits[0]["code"])
    return None


def _nearest_relics(anchor: dict, count: int, *, exclude: set[str]) -> list[dict]:
    lng0, lat0 = anchor.get("center_lng"), anchor.get("center_lat")
    scored = []
    for r in store.relics:
        code = r.get("archive_code")
        if code in exclude or r is anchor:
            continue
        lng, lat = r.get("center_lng"), r.get("center_lat")
        if lng is None or lat is None:
            continue
        scored.append((haversine_m(lng0, lat0, lng, lat), r))
    scored.sort(key=lambda x: x[0])
    return [r for _, r in scored[:count]]


def _month_label() -> str:
    t = date.today()
    return f"{t.year}年{t.month}月"


def _chunk_routes(due: list[dict], *, chunk: int = 8, max_routes: int = 4) -> list[list[dict]]:
    """把到期清单切成若干条按地理就近排序的路线。"""
    pool = [d for d in due if d.get("lng") is not None and d.get("lat") is not None]
    routes: list[list[dict]] = []
    while pool and len(routes) < max_routes:
        seed = pool.pop(0)
        group = [seed]
        pool.sort(key=lambda d: haversine_m(seed["lng"], seed["lat"], d["lng"], d["lat"]))
        while pool and len(group) < chunk:
            group.append(pool.pop(0))
        ordered = order_nearest_neighbor(
            [{"code": g["archive_code"], "lng": g["lng"], "lat": g["lat"], **g} for g in group]
        )
        routes.append(ordered)
    return routes


def _resolve_origin(origin_name: str) -> Optional[dict]:
    """把出发地名称解析成坐标:先按文物名匹配台账,再走高德地理编码。
    返回 {lng, lat, name} 或 None。"""
    name = (origin_name or "").strip()
    if not name:
        return None
    r = _find_relic_by_name(name)
    if r and r.get("center_lng") is not None and r.get("center_lat") is not None:
        return {"lng": float(r["center_lng"]), "lat": float(r["center_lat"]),
                "name": r.get("name") or name}
    from _common import load_config
    city = ((load_config().get("project") or {}).get("name") or "").strip()
    g = amap_service.geocode(name, city=city)
    if g:
        return {"lng": g["lng"], "lat": g["lat"], "name": name}
    return None


@router.post("/patrol/plan")
async def patrol_plan(req: PlanRequest):
    """自然语言 → 巡查路线建议(不落库,由前端确认后 POST /patrol/routes 保存)。"""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "请输入巡查需求")

    intent = ai_service.parse_patrol_intent(text)
    itype = intent.get("type") or "condition"

    # 出发地:「从XX出发」→ 文物名匹配 / 高德地理编码 → 路线起点
    start = _resolve_origin(intent.get("origin") or "")
    start_xy = (start["lng"], start["lat"]) if start else None
    origin_note = ""
    if intent.get("origin") and not start:
        origin_note = f"(出发地「{intent['origin']}」未能定位,已忽略)"
    # 用户明确说了数量才按数量截断;只给筛选条件(县区/级别/状况)时,
    # 把符合条件的都排进去。上限一律 30 处(单日体力上限)。
    hard_cap = max(1, min(req.max_stops, MAX_STOPS_HARD_LIMIT))
    raw_count = intent.get("count")
    has_filter = bool(intent.get("county") or intent.get("level") or intent.get("condition"))
    if raw_count:
        count = max(1, min(int(raw_count), hard_cap))
    else:
        count = hard_cap if has_filter else 5
    explanation = ""
    suggestions: list[dict] = []

    if itype == "monthly":
        due = patrol_db.compute_due(store.relics)
        county = intent.get("county")
        if county:
            due = [d for d in due if d["county"] == county]
        overdue = [d for d in due if d["due_in_days"] <= 7]  # 已逾期或 7 天内到期
        groups = _chunk_routes(overdue, chunk=8, max_routes=4)
        for i, g in enumerate(groups, 1):
            main_county = max({x["county"] for x in g}, key=lambda c: sum(1 for x in g if x["county"] == c)) if g else ""
            suggestions.append({
                "name": f"{_month_label()}巡查·第{i}组({main_county})",
                "codes": [x["code"] for x in g],
            })
        explanation = (f"{_month_label()}共有 {len(overdue)} 处文物已到巡查周期"
                       f"(按保存状况频次策略),已按地理就近分成 {len(groups)} 条路线。")
    elif itype == "near":
        anchor = _find_relic_by_name(intent.get("anchor") or "")
        if not anchor:
            raise HTTPException(404, f"未找到锚点文物「{intent.get('anchor')}」")
        near = _nearest_relics(anchor, count, exclude=set())
        stops = [anchor] + near
        ordered = order_nearest_neighbor([
            {"code": r["archive_code"], "lng": r["center_lng"], "lat": r["center_lat"], "name": r["name"]}
            for r in stops
        ], start=start_xy)
        suggestions.append({
            "name": f"{anchor['name']}周边巡查",
            "codes": [s["code"] for s in ordered],
        })
        explanation = f"以「{anchor['name']}」为中心选取周边 {len(near)} 处文物,按最近邻排序。"
    elif itype == "list":
        codes = []
        missing = []
        for nm in intent.get("names") or []:
            r = _find_relic_by_name(nm)
            if r:
                codes.append(r["archive_code"])
            else:
                missing.append(nm)
        if not codes:
            raise HTTPException(404, "未匹配到点名的文物")
        ordered = order_nearest_neighbor(_resolve_stops(codes), start=start_xy)
        suggestions.append({"name": "自定义点名巡查", "codes": [s["code"] for s in ordered]})
        explanation = "已按最近邻排序点名文物。" + (f"未找到: {'、'.join(missing)}" if missing else "")
    else:  # condition / county
        from codes import normalize_rank

        relics = store.relics
        county = intent.get("county")
        township = intent.get("township")
        cond = intent.get("condition")
        level = (intent.get("level") or "").strip()
        rank_code = normalize_rank(level) if level else ""
        if county:
            matched = [r for r in relics if (r.get("county") or "") == county]
            # 县区名容错:全等匹配不到时按"去掉县/区/市后缀"模糊匹配
            if not matched:
                stem = county.rstrip("县区市")
                matched = [r for r in relics if stem and stem in (r.get("county") or "")]
            relics = matched
        if township:
            relics = [r for r in relics if township in (r.get("township") or "")]
        if cond:
            relics = [r for r in relics if (r.get("condition_level") or "") == cond]
        if level:
            relics = [r for r in relics
                      if normalize_rank(r.get("heritage_level")) == rank_code]
        if not relics:
            cond_desc = "".join(filter(None, [county, township, level, cond and f"保存{cond}"]))
            raise HTTPException(404, f"按条件({cond_desc})未筛到文物")
        due = patrol_db.compute_due(relics)[:count]
        ordered = order_nearest_neighbor(
            [{"code": d["archive_code"], "lng": d["lng"], "lat": d["lat"], **d} for d in due
             if d["lng"] is not None],
            start=start_xy,
        )
        stamp = date.today().strftime("%Y%m%d")
        label = f"{stamp}{county or ''}{level or ''}{('保存' + cond) if cond else ''}巡查"
        suggestions.append({"name": label, "codes": [s["code"] for s in ordered]})
        filter_desc = "、".join(filter(None, [
            county, township, level and f"{level}单位", cond and f"保存状况{cond}",
        ]))
        explanation = (f"按{filter_desc or '巡查紧迫度'}筛选出 {len(relics)} 处,"
                       f"取紧迫度(逾期优先)前 {len(ordered)} 处,已按最近邻排序。")

    if raw_count and int(raw_count) > hard_cap:
        explanation += f"(要求 {raw_count} 处超出单日上限,已按 {hard_cap} 处安排)"
    if start:
        explanation = f"从「{start['name']}」出发," + explanation
    elif origin_note:
        explanation += origin_note

    out_routes = []
    for s in suggestions:
        stops = _resolve_stops(s["codes"])
        geom = _plan_geometry(stops, start=start)
        out_routes.append({**s, "stops": stops, **geom})

    return {
        "intent": intent,
        "explanation": explanation,
        "routes": out_routes,
        "parser": intent.get("_parser", ""),
        "start": start,
    }


# ── 路线 CRUD ───────────────────────────────────────────────
class RouteStart(BaseModel):
    lng: float
    lat: float
    name: str = ""


class RouteCreate(BaseModel):
    name: str
    codes: list[str]
    plan_date: str = ""
    mode: str = "manual"          # manual / area / ai / monthly
    note: str = ""
    optimize: bool = True         # 是否用最近邻重排
    created_by: str = ""
    start: Optional[RouteStart] = None  # 自定义出发点


class RoutePatch(BaseModel):
    name: Optional[str] = None
    plan_date: Optional[str] = None
    note: Optional[str] = None
    status: Optional[str] = None
    codes: Optional[list[str]] = None


def _default_route_name(stops: list[dict]) -> str:
    """按途经点自动命名:日期 + 主要县区,如 20260706嘉祥县巡查。"""
    counties = [s.get("county") or "" for s in stops if s.get("county")]
    main = max(set(counties), key=counties.count) if counties else ""
    return f"{date.today().strftime('%Y%m%d')}{main}巡查"


@router.post("/patrol/routes")
async def create_route(body: RouteCreate, request: Request):
    stops = _resolve_stops(body.codes)
    if not stops:
        raise HTTPException(400, "路线中没有有效文物点")
    start = body.start.dict() if body.start else None
    if body.optimize and len(stops) > 2:
        # 有出发点时按"离出发点最近"作为第一站做最近邻排序
        origin = (start["lng"], start["lat"]) if start else None
        stops = order_nearest_neighbor(stops, start=origin)
    geom = _plan_geometry(stops, start=start)
    route = patrol_db.create_route(
        name=body.name.strip() or _default_route_name(stops),
        relic_codes=[s["code"] for s in stops],
        plan_date=body.plan_date,
        mode=body.mode,
        note=body.note,
        created_by=body.created_by,
        distance_m=geom["distance_m"],
        duration_s=geom["duration_s"],
        polyline=geom["polyline"],
        start=start,
    )
    return _route_payload(route, request=request)


@router.get("/patrol/routes")
async def list_routes(request: Request, status: str | None = Query(None),
                      limit: int = Query(100, ge=1, le=500)):
    routes = patrol_db.list_routes(limit=limit, status=status)
    return {"data": [_route_payload(r, request=request) for r in routes]}


@router.get("/patrol/routes/{route_id}")
async def get_route(route_id: int, request: Request):
    route = patrol_db.get_route(route_id)
    if not route:
        raise HTTPException(404, "路线不存在")
    return _route_payload(route, with_records=True, request=request)


@router.patch("/patrol/routes/{route_id}")
async def patch_route(route_id: int, body: RoutePatch, request: Request):
    route = patrol_db.get_route(route_id)
    if not route:
        raise HTTPException(404, "路线不存在")
    patch = {k: v for k, v in body.dict().items() if v is not None}
    if "codes" in patch:
        stops = _resolve_stops(patch.pop("codes"))
        if not stops:
            raise HTTPException(400, "路线中没有有效文物点")
        geom = _plan_geometry(stops)
        patch["relic_codes"] = [s["code"] for s in stops]
        patch["distance_m"] = geom["distance_m"]
        patch["duration_s"] = geom["duration_s"]
        patch["polyline"] = geom["polyline"]
    route = patrol_db.update_route(route_id, patch)
    return _route_payload(route, request=request)


@router.delete("/patrol/routes/{route_id}")
async def delete_route(route_id: int):
    if not patrol_db.get_route(route_id):
        raise HTTPException(404, "路线不存在")
    patrol_db.delete_route(route_id)
    return {"ok": True}


@router.get("/patrol/routes/{route_id}/qr.png")
async def route_qr(route_id: int, request: Request):
    route = patrol_db.get_route(route_id)
    if not route:
        raise HTTPException(404, "路线不存在")
    url = f"{_base_url(request)}/m/r/{route['token']}"
    try:
        import qrcode
    except ImportError:
        raise HTTPException(500, "服务器未安装 qrcode 库: pip install qrcode[pil]")
    img = qrcode.make(url, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "no-store", "X-Mobile-Url": url})


# ── AI 照片评估与报告 ───────────────────────────────────────
def _baseline_photo_bytes(code: str) -> Optional[bytes]:
    if _OUTPUT_PHOTOS is None:
        return None
    photos = store.get_photos(code)
    if not photos:
        return None
    p = _OUTPUT_PHOTOS / (photos[0].get("path") or "")
    if p.exists() and p.is_file():
        try:
            return p.read_bytes()
        except OSError:
            return None
    return None


def _fallback_assess(record: dict, relic: dict) -> dict:
    """无视觉模型时的规则兜底:沿用档案状况,给出核验说明。"""
    verified = bool(record.get("verified"))
    return {
        "same_site": verified or None,
        "condition": relic.get("condition_level") or "一般",
        "changes": "未接入视觉模型,沿用档案记录状况" + ("(定位核验通过)" if verified else ""),
        "risks": "建议接入视觉模型后复评",
        "suggestion": "按现行频次继续巡查",
        "_engine": "rules",
    }


@router.post("/patrol/records/{record_id}/assess")
async def assess_record(record_id: int):
    """对单条打卡照片做 AI 保存状况评估(与档案基准照对比)。"""
    record = patrol_db.get_record(record_id)
    if not record:
        raise HTTPException(404, "打卡记录不存在")
    relic = store.get_relic(record["relic_code"]) or {}

    result = None
    if record.get("photo_path") and _PHOTOS_ROOT is not None:
        photo_file = _PHOTOS_ROOT / record["photo_path"]
        if photo_file.exists():
            baseline = _baseline_photo_bytes(record["relic_code"])
            result = ai_service.assess_patrol_photo(photo_file.read_bytes(), baseline, relic)
            if result:
                result["_engine"] = "vision"
    if not result:
        result = _fallback_assess(record, relic)

    cond = str(result.get("condition") or "")
    summary = " / ".join(
        str(result.get(k) or "") for k in ("changes", "risks", "suggestion") if result.get(k)
    )
    patrol_db.set_record_ai(record_id, cond, summary)
    return {"record_id": record_id, "assessment": result}


@router.get("/patrol/routes/{route_id}/report")
async def route_report(route_id: int, prose: bool = Query(False)):
    """巡查报告:核验统计 + 每站评估 + (可选)LLM 生成的报告正文。"""
    route = patrol_db.get_route(route_id)
    if not route:
        raise HTTPException(404, "路线不存在")
    stops = _resolve_stops(route["relic_codes"])
    records = patrol_db.list_records(route_id=route_id)
    rec_by_code: dict[str, list[dict]] = {}
    for r in records:
        rec_by_code.setdefault(r["relic_code"], []).append(r)

    items = []
    worse = []
    for s in stops:
        recs = rec_by_code.get(s["code"], [])
        latest = recs[0] if recs else None
        ai_cond = (latest or {}).get("ai_condition") or ""
        if ai_cond and s["condition"] and ai_cond != s["condition"]:
            order = ["好", "较好", "一般", "较差", "差"]
            if ai_cond in order and s["condition"] in order and order.index(ai_cond) > order.index(s["condition"]):
                worse.append(s["name"])
        items.append({
            **s,
            "checked": bool(recs),
            "verified": bool(latest and latest.get("verified")),
            "record_id": (latest or {}).get("id"),
            "distance_m": (latest or {}).get("distance_m"),
            "photo": f"/patrol-photos/{latest['photo_path']}" if latest and latest.get("photo_path") else "",
            "ai_condition": ai_cond,
            "ai_summary": (latest or {}).get("ai_summary") or "",
            "checked_at": (latest or {}).get("created_at"),
        })

    checked_n = sum(1 for i in items if i["checked"])
    verified_n = sum(1 for i in items if i["verified"])
    summary = {
        "route_name": route["name"],
        "plan_date": route["plan_date"],
        "stop_count": len(stops),
        "checked_count": checked_n,
        "verified_count": verified_n,
        "verify_rate": round(verified_n / len(stops) * 100, 1) if stops else 0.0,
        "distance_km": round((route.get("distance_m") or 0) / 1000, 1),
        "condition_worse": worse,
    }

    prose_text = ""
    if prose:
        compact = "\n".join(
            f"- {i['name']}({i['code']}): 打卡{'√' if i['checked'] else '×'} 核验{'√' if i['verified'] else '×'}"
            f" 档案状况:{i['condition'] or '未知'} AI评估:{i['ai_condition'] or '—'} {i['ai_summary'] or ''}"
            for i in items
        )
        prompt = (
            f"根据以下巡查数据,写一份约300字的文物巡查工作报告(标题、巡查概况、发现问题、处置建议四部分,用词专业平实):\n"
            f"路线: {route['name']} 计划日期: {route['plan_date']}\n"
            f"应巡 {len(stops)} 处,实际打卡 {checked_n} 处,定位核验通过 {verified_n} 处。\n{compact}"
        )
        prose_text = ai_service.complete_text(prompt, max_tokens=800)
        if not prose_text:
            prose_text = (
                f"# {route['name']} 巡查报告\n\n"
                f"本次巡查计划于 {route['plan_date']} 执行,应巡文物 {len(stops)} 处,"
                f"实际完成打卡 {checked_n} 处,定位核验通过 {verified_n} 处"
                f"(核验半径 {int(_VERIFY_RADIUS_M)} 米)。\n\n"
                + (f"AI 对比档案照片发现 {len(worse)} 处文物保存状况疑似下降:{'、'.join(worse)},"
                   f"建议安排复查并按频次策略提高巡查等级。\n" if worse else
                   "各巡查点位保存状况与档案记录基本一致,未见明显异常。\n")
                + "\n后续请按平台频次策略持续开展巡查,并及时上传打卡照片供 AI 复核。"
            )
    return {"summary": summary, "items": items, "prose": prose_text}


# ── 移动端(公开,凭 token) ──────────────────────────────────
@mobile_router.get("/m/r/{token}", response_class=HTMLResponse)
async def mobile_page(token: str):
    route = patrol_db.get_route_by_token(token)
    if not route:
        return HTMLResponse("<h3 style='font-family:sans-serif;padding:40px'>路线不存在或已删除</h3>", status_code=404)
    html = _TEMPLATE_PATH.read_text(encoding="utf-8")
    return HTMLResponse(html.replace("{{TOKEN}}", token))


@mobile_router.get("/api/m/route/{token}")
async def mobile_route(token: str):
    route = patrol_db.get_route_by_token(token)
    if not route:
        raise HTTPException(404, "路线不存在")
    stops = _resolve_stops(route["relic_codes"])
    records = patrol_db.list_records(route_id=route["id"])
    latest: dict[str, dict] = {}
    for r in records:
        if r["relic_code"] not in latest:
            latest[r["relic_code"]] = r

    nav_stops = [{"lng": s["lng"], "lat": s["lat"], "name": s["name"]} for s in stops]
    # H5 URI 只支持 1 个途经点(高德官方限制),App scheme 支持 16 个;
    # 页面优先唤起 App,失败回退 H5。
    full_nav = amap_service.nav_uri(nav_stops)
    full_nav_app = amap_service.nav_uri_app(nav_stops)
    out_stops = []
    for s in stops:
        rec = latest.get(s["code"])
        out_stops.append({
            **s,
            "nav_uri": amap_service.nav_uri([{"lng": s["lng"], "lat": s["lat"], "name": s["name"]}]),
            "checked": bool(rec),
            "verified": bool(rec and rec.get("verified")),
            "distance_m": (rec or {}).get("distance_m"),
        })
    return {
        "name": route["name"],
        "plan_date": route["plan_date"],
        "status": route["status"],
        "note": route.get("note") or "",
        "stops": out_stops,
        "nav_uri_full": full_nav,
        "nav_uri_full_app": full_nav_app,
        "verify_radius_m": _VERIFY_RADIUS_M,
    }


@mobile_router.post("/api/m/route/{token}/checkin")
async def mobile_checkin(
    token: str,
    relic_code: str = Form(...),
    photo: UploadFile = File(...),
    client_lat: float | None = Form(None),
    client_lng: float | None = Form(None),
    note: str = Form(""),
):
    """拍照打卡:读 EXIF GPS(缺失则用浏览器定位),与文物坐标比对。"""
    route = patrol_db.get_route_by_token(token)
    if not route:
        raise HTTPException(404, "路线不存在")
    if relic_code not in route["relic_codes"]:
        raise HTTPException(400, "该文物不在本条路线中")
    relic = store.get_relic(relic_code)
    if not relic:
        raise HTTPException(404, "文物不存在")

    raw = await photo.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "照片超过 20MB")

    gps = extract_gps(raw)
    src = "none"
    lat, lng = gps.get("lat"), gps.get("lng")
    if lat is not None and lng is not None:
        src = "exif"
    elif client_lat is not None and client_lng is not None:
        lat, lng = float(client_lat), float(client_lng)
        src = "browser"

    dist = None
    verified = False
    verdict = "no_gps"
    if lat is not None and lng is not None:
        dist = haversine_m(float(lng), float(lat), float(relic["center_lng"]), float(relic["center_lat"]))
        if dist <= _VERIFY_RADIUS_M:
            verified, verdict = True, "verified"
        elif dist <= _SUSPECT_RADIUS_M:
            verdict = "near"
        else:
            verdict = "far"

    # 保存照片
    assert _PHOTOS_ROOT is not None
    safe_code = re.sub(r"[^0-9A-Za-z_\-]", "_", relic_code)
    rel = f"{route['id']}/{int(time.time())}_{safe_code}.jpg"
    dst = _PHOTOS_ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(raw)

    record = patrol_db.add_record(
        route_id=route["id"], relic_code=relic_code,
        photo_path=rel, photo_lat=lat, photo_lng=lng,
        gps_source=src, distance_m=dist, verified=verified, note=note,
    )

    # 全部站点打卡后自动置为 done
    records = patrol_db.list_records(route_id=route["id"])
    if {r["relic_code"] for r in records} >= set(route["relic_codes"]):
        patrol_db.update_route(route["id"], {"status": "done"})

    return {
        "ok": True,
        "record_id": record["id"],
        "verdict": verdict,           # verified / near / far / no_gps
        "verified": verified,
        "gps_source": src,
        "distance_m": round(dist, 1) if dist is not None else None,
        "verify_radius_m": _VERIFY_RADIUS_M,
        "relic_name": relic.get("name") or "",
    }


# ── 巡查统计(供数据门面) ────────────────────────────────────
@router.get("/patrol/stats")
async def patrol_stats():
    routes = patrol_db.list_routes(limit=500)
    records = patrol_db.list_records(limit=5000)
    due = patrol_db.compute_due(store.relics)
    overdue = sum(1 for d in due if d["due_in_days"] < 0)
    t = date.today()
    month_start = int(time.mktime((t.year, t.month, 1, 0, 0, 0, 0, 0, -1)))
    month_records = [r for r in records if (r.get("created_at") or 0) >= month_start]
    return {
        "route_total": len(routes),
        "route_done": sum(1 for r in routes if r["status"] == "done"),
        "record_total": len(records),
        "record_this_month": len(month_records),
        "verified_total": sum(1 for r in records if r["verified"]),
        "overdue_count": overdue,
        "due_7days": sum(1 for d in due if 0 <= d["due_in_days"] <= 7),
        "month_days": calendar.monthrange(t.year, t.month)[1],
    }
