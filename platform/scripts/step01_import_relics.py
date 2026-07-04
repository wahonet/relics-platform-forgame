"""Step 01 | 从文物台账 Excel/CSV 导入,生成标准化数据集。

输入:
    data/input/01_relics/*.xlsx | *.csv     文物台账(第一个匹配文件)
    data/input/01_relics/protection_zones.geojson   两线范围面(可选)
    data/input/02_media/photos/{code}/*     照片(可选)
    data/input/02_media/drawings/{code}/*   图纸(可选)
    data/input/06_archive_docs/{code}/{sanpu|sipu}/*.pdf   普查档案(可选)

输出:
    data/output/dataset/relics_full.json
    data/output/dataset/relics_points.geojson
    data/output/dataset/relics_polygons.geojson   (若有两线面数据)
    data/output/dataset/photo_index.csv / drawing_index.csv
    data/output/photos/{code}/... / data/output/drawings/{code}/...

台账列名(容错匹配,详见 _COLUMN_ALIASES):
    编号 名称 级别 类别 年代 县区 乡镇 村 地址 经度 纬度 高程
    简介 保存状况 保护范围 建设控制地带 数据层级 公布批次
"""
from __future__ import annotations

import csv
import json
import shutil
import sys
from pathlib import Path

from _common import get_logger, get_paths, load_config
from codes import normalize_category, normalize_rank, parse_coord

log = get_logger("step01_import_relics")

# 台账中文列名 → 内部字段
_COLUMN_ALIASES: dict[str, str] = {
    "编号": "archive_code", "档案编号": "archive_code", "文物编号": "archive_code", "code": "archive_code",
    "名称": "name", "文物名称": "name", "name": "name",
    "级别": "heritage_level", "保护级别": "heritage_level", "文物级别": "heritage_level",
    "类别": "category_main", "文物类别": "category_main", "分类": "category_main",
    "年代": "era", "时代": "era",
    "年代分期": "era_stats",
    "县区": "county", "县市区": "county", "区县": "county", "所在县区": "county",
    "乡镇": "township", "乡镇街道": "township", "镇街": "township",
    "村": "village", "行政村": "village", "村庄": "village",
    "地址": "address", "详细地址": "address", "位置": "address",
    "经度": "center_lng", "lng": "center_lng",
    "纬度": "center_lat", "lat": "center_lat",
    "高程": "center_alt", "海拔": "center_alt",
    "简介": "intro", "文物简介": "intro", "概况": "intro",
    "保存状况": "condition_level", "保存现状": "condition_level", "现状评估": "condition_level",
    "保护范围": "protection_scope",
    "建设控制地带": "control_zone", "建控地带": "control_zone",
    "数据层级": "tier", "层级": "tier",
    "公布批次": "batch", "批次": "batch",
    "面积": "area",
    "权属": "ownership_type", "产权": "ownership_type",
}

_TIER_ALIASES = {
    "基础": "city", "全市": "city", "city": "city", "市级框架": "city",
    "全量": "full", "嘉祥": "full", "full": "full", "县级全量": "full",
}

_CONDITIONS = ("好", "较好", "一般", "较差", "差")


def _find_source(input_dir: Path) -> Path | None:
    for pat in ("*.xlsx", "*.xls", "*.csv"):
        files = sorted(p for p in input_dir.glob(pat) if not p.name.startswith("~"))
        if files:
            return files[0]
    return None


def _read_rows(src: Path) -> list[dict]:
    """读台账 → [{中文列: 值}]。"""
    if src.suffix.lower() == ".csv":
        with src.open("r", encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))

    try:
        from openpyxl import load_workbook
    except ImportError:
        log.error("未安装 openpyxl,无法读取 Excel。请 pip install openpyxl,或改用 CSV。")
        sys.exit(1)

    wb = load_workbook(src, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        header = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
    except StopIteration:
        return []
    out = []
    for values in rows_iter:
        if values is None or all(v in (None, "") for v in values):
            continue
        out.append({header[i]: values[i] for i in range(min(len(header), len(values)))})
    wb.close()
    return out


def _normalize_row(raw: dict) -> dict:
    """中文列 → 内部字段,并做基础清洗。"""
    r: dict = {}
    for k, v in raw.items():
        key = _COLUMN_ALIASES.get(str(k).strip())
        if not key:
            continue
        if v is None:
            continue
        s = str(v).strip()
        if s:
            r[key] = s

    code = r.get("archive_code", "")
    name = r.get("name", "")
    lng = parse_coord(r.get("center_lng"))
    lat = parse_coord(r.get("center_lat"))
    if not code or not name or lng is None or lat is None:
        return {}

    r["archive_code"] = code
    r["center_lng"] = lng
    r["center_lat"] = lat
    alt = parse_coord(r.get("center_alt"))
    r["center_alt"] = alt if alt is not None else 0.0

    r["heritage_level"] = r.get("heritage_level") or "未定级"
    r["category_main"] = r.get("category_main") or "其他"
    cond = r.get("condition_level", "")
    r["condition_level"] = cond if cond in _CONDITIONS else (cond or "一般")

    tier_raw = r.get("tier", "")
    r["tier"] = _TIER_ALIASES.get(tier_raw, "full" if tier_raw == "full" else "city")

    if not r.get("era_stats"):
        r["era_stats"] = r.get("era", "")
    return r


def _copy_media(src_root: Path, dst_root: Path, kinds: tuple[str, ...]) -> list[dict]:
    """input/02_media/{photos|drawings}/{code}/* → output/{photos|drawings}/{code}/*。
    返回索引 [{archive_code, path}]。已存在的同名文件跳过。"""
    index: list[dict] = []
    if not src_root.exists():
        return index
    for code_dir in sorted(src_root.iterdir()):
        if not code_dir.is_dir():
            continue
        code = code_dir.name
        for f in sorted(code_dir.rglob("*")):
            if not f.is_file() or f.suffix.lower() not in kinds:
                continue
            rel = f"{code}/{f.name}"
            dst = dst_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists():
                shutil.copy2(f, dst)
            index.append({"archive_code": code, "path": rel})
    return index


def _scan_archive_docs(root: Path) -> dict[str, dict[str, int]]:
    """{code: {"sanpu": n, "sipu": n}}"""
    out: dict[str, dict[str, int]] = {}
    if not root.exists():
        return out
    for code_dir in root.iterdir():
        if not code_dir.is_dir():
            continue
        entry = {"sanpu": 0, "sipu": 0}
        for kind in ("sanpu", "sipu"):
            d = code_dir / kind
            if d.exists():
                entry[kind] = sum(1 for p in d.glob("*.pdf")) + sum(1 for p in d.glob("*.PDF"))
        if entry["sanpu"] or entry["sipu"]:
            out[code_dir.name] = entry
    return out


def _write_points_geojson(relics: list[dict], out: Path) -> None:
    feats = []
    for r in relics:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["center_lng"], r["center_lat"]]},
            "properties": {
                "archive_code": r["archive_code"],
                "name": r["name"],
                "heritage_level": r.get("heritage_level", ""),
                "county": r.get("county", ""),
            },
        })
    out.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False),
        encoding="utf-8",
    )


def main() -> int:
    paths = get_paths()
    cfg = load_config()
    src_crs = ((cfg.get("geo") or {}).get("source_crs") or "wgs84").lower()

    src = _find_source(paths.input_relics)
    if not src:
        if (paths.output_dataset / "relics_full.json").exists():
            log.info("未找到台账,但 relics_full.json 已存在(可能来自演示数据生成器),跳过导入。")
            return 0
        log.error("未在 %s 找到台账 (*.xlsx / *.csv)。可先运行 tools/generate_demo_data.py 生成演示数据。",
                  paths.input_relics)
        return 2

    log.info("[导入] 台账: %s", src.name)
    raw_rows = _read_rows(src)
    log.info("[导入] 读到 %d 行", len(raw_rows))

    relics: list[dict] = []
    seen: set[str] = set()
    for raw in raw_rows:
        r = _normalize_row(raw)
        if not r:
            continue
        if r["archive_code"] in seen:
            log.warning("重复编号,跳过: %s", r["archive_code"])
            continue
        seen.add(r["archive_code"])

        if src_crs == "gcj02":
            from _common import gcj02_to_wgs84
            r["center_lng"], r["center_lat"] = gcj02_to_wgs84(r["center_lng"], r["center_lat"])

        relics.append(r)

    if not relics:
        log.error("有效记录为 0,请检查台账列名与内容")
        return 2

    # 媒体归位 + 计数
    photo_index = _copy_media(paths.input_media / "photos", paths.output_photos,
                              (".jpg", ".jpeg", ".png", ".webp"))
    drawing_index = _copy_media(paths.input_media / "drawings", paths.output_drawings,
                                (".jpg", ".jpeg", ".png", ".webp", ".pdf"))
    photo_count: dict[str, int] = {}
    for p in photo_index:
        photo_count[p["archive_code"]] = photo_count.get(p["archive_code"], 0) + 1
    drawing_count: dict[str, int] = {}
    for d in drawing_index:
        drawing_count[d["archive_code"]] = drawing_count.get(d["archive_code"], 0) + 1

    archives = _scan_archive_docs(paths.input_archive_docs)
    models_root = paths.input_models_3d

    for r in relics:
        code = r["archive_code"]
        r["photo_count"] = photo_count.get(code, 0)
        r["drawing_count"] = drawing_count.get(code, 0)
        arch = archives.get(code, {})
        r["has_archive_spu"] = bool(arch.get("sanpu"))
        r["has_archive_fpu"] = bool(arch.get("sipu"))
        model_dir = models_root / code
        r["has_3d"] = model_dir.exists() and any(model_dir.iterdir()) if model_dir.exists() else bool(r.get("has_3d"))
        r["category_code"] = normalize_category(r.get("category_main"))
        r["rank_code"] = normalize_rank(r.get("heritage_level"))

    paths.output_dataset.mkdir(parents=True, exist_ok=True)
    out_json = paths.output_dataset / "relics_full.json"
    out_json.write_text(json.dumps(relics, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("[导入] relics_full.json: %d 条", len(relics))

    _write_points_geojson(relics, paths.output_dataset / "relics_points.geojson")

    zones = paths.input_relics / "protection_zones.geojson"
    if zones.exists():
        shutil.copy2(zones, paths.output_dataset / "relics_polygons.geojson")
        log.info("[导入] 两线范围面: 已复制 protection_zones.geojson")

    with (paths.output_dataset / "photo_index.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["archive_code", "path"])
        w.writeheader()
        w.writerows(photo_index)
    with (paths.output_dataset / "drawing_index.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["archive_code", "path"])
        w.writeheader()
        w.writerows(drawing_index)
    log.info("[导入] 照片 %d 张 / 图纸 %d 张", len(photo_index), len(drawing_index))

    by_tier = {"city": 0, "full": 0}
    for r in relics:
        by_tier[r.get("tier", "city")] = by_tier.get(r.get("tier", "city"), 0) + 1
    log.info("[导入] 完成。基础层 %d 条 / 全量层 %d 条", by_tier.get("city", 0), by_tier.get("full", 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
