"""高德地图 Web 服务封装:驾车路径规划 + 导航 URI 生成。

- 平台内部坐标一律 WGS-84;调用高德接口前转 GCJ-02,返回的折线转回 WGS-84。
- 未配置 key 时 plan_driving_route 返回 None,调用方降级为直线连接。
"""
from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request
from typing import Optional

from _common import gcj02_to_wgs84, wgs84_to_gcj02

log = logging.getLogger("uvicorn.error")

# 高德为国内服务,固定直连,不受系统代理开关影响
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_KEY: str = ""


def init(key: str) -> None:
    global _KEY
    k = (key or "").strip()
    _KEY = "" if k.startswith("${") else k
    if _KEY:
        log.info("[高德] Web服务 key 已配置,巡查路线将调用真实路径规划")
    else:
        log.info("[高德] 未配置 key,巡查路线使用直线连接(可在 config.yaml api.amap.web_key 配置)")


def has_key() -> bool:
    return bool(_KEY)


def plan_driving_route(points_wgs84: list[tuple[float, float]]) -> Optional[dict]:
    """按顺序驾车路径规划。points 为 WGS-84 (lng, lat),>=2 个。

    返回 {distance_m, duration_s, polyline: [[lng,lat]... WGS-84]};失败/无 key 返回 None。
    高德驾车 v3 途经点上限 16 个,超出时分段请求拼接。
    """
    if not _KEY or len(points_wgs84) < 2:
        return None

    gcj = [wgs84_to_gcj02(lng, lat) for lng, lat in points_wgs84]

    total_dist = 0.0
    total_dur = 0.0
    full_line: list[list[float]] = []

    # 每段最多 1 起点 + 16 途经 + 1 终点 = 18 个点
    seg_size = 18
    i = 0
    while i < len(gcj) - 1:
        seg = gcj[i:i + seg_size]
        if len(seg) < 2:
            break
        origin = f"{seg[0][0]:.6f},{seg[0][1]:.6f}"
        dest = f"{seg[-1][0]:.6f},{seg[-1][1]:.6f}"
        waypoints = ";".join(f"{p[0]:.6f},{p[1]:.6f}" for p in seg[1:-1])
        params = {
            "key": _KEY,
            "origin": origin,
            "destination": dest,
            "strategy": "0",
            "extensions": "base",
        }
        if waypoints:
            params["waypoints"] = waypoints
        url = "https://restapi.amap.com/v3/direction/driving?" + urllib.parse.urlencode(params)
        try:
            with _DIRECT_OPENER.open(url, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            log.warning("[高德] 路径规划请求失败: %s", e)
            return None
        if str(data.get("status")) != "1" or not (data.get("route") or {}).get("paths"):
            log.warning("[高德] 路径规划返回异常: %s", data.get("info"))
            return None
        path = data["route"]["paths"][0]
        total_dist += float(path.get("distance") or 0)
        total_dur += float(path.get("duration") or 0)
        for step in path.get("steps") or []:
            for pair in (step.get("polyline") or "").split(";"):
                if not pair:
                    continue
                try:
                    glng, glat = (float(x) for x in pair.split(","))
                except ValueError:
                    continue
                wlng, wlat = gcj02_to_wgs84(glng, glat)
                if full_line and abs(full_line[-1][0] - wlng) < 1e-7 and abs(full_line[-1][1] - wlat) < 1e-7:
                    continue
                full_line.append([round(wlng, 6), round(wlat, 6)])
        i += seg_size - 1

    if not full_line:
        return None
    return {"distance_m": total_dist, "duration_s": total_dur, "polyline": full_line}


def nav_uri(stops_wgs84: list[dict], *, mode: str = "car") -> str:
    """生成高德 URI(https),微信内打开后可跳转高德 App 开始导航。

    stops: [{lng, lat, name}] WGS-84,首个为当前段起点之后的第一站。
    多站时中间站写入 via(高德 URI 支持途经点;个别版本忽略时仍导航至终点)。
    """
    if not stops_wgs84:
        return ""
    conv = []
    for s in stops_wgs84:
        glng, glat = wgs84_to_gcj02(float(s["lng"]), float(s["lat"]))
        conv.append({"lng": glng, "lat": glat, "name": (s.get("name") or "巡查点")[:20]})

    dest = conv[-1]
    params = {
        "to": f"{dest['lng']:.6f},{dest['lat']:.6f},{dest['name']}",
        "mode": mode,
        "policy": "1",
        "src": "relics-platform",
        "coordinate": "gaode",
        "callnative": "1",
    }
    vias = conv[:-1]
    if vias:
        params["via"] = ";".join(f"{v['lng']:.6f},{v['lat']:.6f},{v['name']}" for v in vias[:16])
    return "https://uri.amap.com/navigation?" + urllib.parse.urlencode(params, safe=",;")
