"""基础边界底图的种子恢复。

仓库 `boundary/` 目录自带本市的市界/县界 GeoJSON(GCJ-02,来自 DataV),
它们是地图的"底子"(市界发光描边 + 域外遮罩 + 县界),不属于业务数据。
清除全部数据后调用 restore_seed_boundaries() 自动重建
data/output/boundaries/{city,county}.geojson,避免地图变成一片黑。

乡镇/村界不在种子范围内:乡镇可在系统管理页在线下载(OSM/DataV),
村界走 step02 离线 SHP 流程。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from _common import PROJECT_ROOT, gcj02_to_wgs84, get_paths  # noqa: E402

SEED_DIR = PROJECT_ROOT / "boundary"

# 种子文件名后缀 → 输出文件。文件名形如 "济宁市_市.geojson" / "济宁市_县.geojson",
# 前缀是项目所在市名,按后缀识别层级即可,换地区部署也能用。
_SUFFIX_TO_OUTPUT = {
    "_市.geojson": "city.geojson",
    "_县.geojson": "county.geojson",
}


def _convert_ring(ring: list) -> list:
    out = []
    for pt in ring:
        if not pt or len(pt) < 2:
            continue
        lng, lat = gcj02_to_wgs84(float(pt[0]), float(pt[1]))
        out.append([lng, lat])
    return out


def _flatten_features(gj: dict) -> list[dict]:
    """GCJ-02 → WGS-84,MultiPolygon 拆平为 Polygon Feature(与 BoundaryLayer 契约一致)。"""
    feats: list[dict] = []
    for f in gj.get("features") or []:
        props = dict(f.get("properties") or {})
        name = props.get("name") or props.get("XZQMC") or ""
        props.setdefault("XZQMC", name)
        props.setdefault("_county_name", name)
        geom = f.get("geometry") or {}
        t = geom.get("type")
        polys = []
        if t == "Polygon":
            polys = [geom.get("coordinates") or []]
        elif t == "MultiPolygon":
            polys = geom.get("coordinates") or []
        for rings in polys:
            if not rings:
                continue
            converted = [_convert_ring(r) for r in rings if len(r) >= 3]
            if not converted or len(converted[0]) < 3:
                continue
            feats.append({
                "type": "Feature",
                "properties": dict(props),
                "geometry": {"type": "Polygon", "coordinates": converted},
            })
    return feats


def restore_seed_boundaries() -> list[str]:
    """从 boundary/ 种子重建 city.geojson / county.geojson。
    返回已恢复的文件名列表;种子目录缺失时返回空列表(静默跳过)。"""
    if not SEED_DIR.exists():
        return []
    out_dir = get_paths().output_boundaries
    out_dir.mkdir(parents=True, exist_ok=True)

    restored: list[str] = []
    for src in sorted(SEED_DIR.glob("*.geojson")):
        # 跳过省级种子(如 山东省_市.geojson 是全省 16 市,不是本市轮廓)
        prefix = src.name.split("_")[0]
        if prefix.endswith(("省", "自治区")):
            continue
        target = None
        for suffix, output in _SUFFIX_TO_OUTPUT.items():
            if src.name.endswith(suffix):
                target = output
                break
        if not target:
            continue
        try:
            gj = json.loads(src.read_text(encoding="utf-8"))
            feats = _flatten_features(gj)
            if not feats:
                continue
            (out_dir / target).write_text(
                json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False),
                encoding="utf-8",
            )
            restored.append(target)
        except (OSError, json.JSONDecodeError, ValueError):
            continue
    return restored
