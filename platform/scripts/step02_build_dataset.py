"""Step 02 | 结构化 Markdown → 数据集。

输入:  data/output/markdown/<township>/*.md  (step01 产物)
输出:  data/output/dataset/
    relics_master.csv          主表
    relics_full.json           含简介 / 边界点的完整 JSON
    relics_points.geojson      点位图层
    relics_polygons.geojson    >= 3 个边界点的文物面
    by_township/*.{csv,json}   按乡镇拆分
    high_risk_relics.csv       风险评分 Top N
    township_stats.csv         乡镇汇总
    category_stats.csv         大类 / 年代 / 级别等维度汇总
    parse_failures.txt         解析失败列表(有失败时写入)

坐标按 config.geo.source_crs 统一到 WGS-84(wgs84 / cgcs2000 原样,gcj02 做修正)。
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from _common import gcj02_to_wgs84, get_logger, get_paths, load_config

STEP_ID = "step02"


def make_crs_converter(source_crs: str):
    cs = (source_crs or "wgs84").strip().lower()
    if cs in ("gcj02", "gcj-02"):
        return gcj02_to_wgs84
    return lambda lng, lat: (lng, lat)


def dms_to_decimal(dms_str: str) -> float | None:
    pattern = re.compile(r'(\d+)[°度]\s*(\d+)[′\']\s*(\d+\.?\d*)[″"]')
    m = pattern.search(str(dms_str))
    if not m:
        return None
    d, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
    return round(d + mi / 60 + s / 3600, 8)


def get_section_text(md: str, section_name: str) -> str:
    pattern = re.compile(
        rf'## {re.escape(section_name)}\s*\n(.*?)(?=\n## |\Z)',
        re.DOTALL,
    )
    m = pattern.search(md)
    return m.group(1).strip() if m else ""


def get_table_value(section_text: str, field_name: str) -> str:
    pattern = re.compile(
        rf'\|\s*{re.escape(field_name)}\s*\|\s*(.+?)\s*\|'
    )
    m = pattern.search(section_text)
    if not m:
        return ""
    val = m.group(1).strip()
    if val in ["（无）", "（）", "无", ""]:
        return ""
    return val


def get_field(md: str, section: str, field: str) -> str:
    return get_table_value(get_section_text(md, section), field)


def parse_coordinates(md: str, convert) -> dict:
    result = {
        "center_lat": None,
        "center_lng": None,
        "center_alt": None,
        "boundary_points": [],
        "marker_points": [],
        "all_points": [],
    }
    section = get_section_text(md, "坐标数据")
    if not section:
        return result

    rows = [
        line for line in section.split('\n')
        if line.strip().startswith('|')
        and '---' not in line
        and '序号' not in line
        and '测点类型' not in line
    ]

    for row in rows:
        cols = [c.strip() for c in row.split('|')]
        cols = [c for c in cols if c != '']
        if len(cols) < 6:
            continue
        try:
            point_type = cols[2] if len(cols) > 2 else ""
            lat_str = cols[3] if len(cols) > 3 else ""
            lng_str = cols[4] if len(cols) > 4 else ""
            alt_str = cols[5] if len(cols) > 5 else ""
            desc = cols[6] if len(cols) > 6 else ""
            lat = dms_to_decimal(lat_str)
            lng = dms_to_decimal(lng_str)
            alt_m = re.search(r'(\d+\.?\d*)', alt_str)
            alt = float(alt_m.group(1)) if alt_m else None
            if lat is None or lng is None:
                continue

            lng_w, lat_w = convert(lng, lat)

            point = {
                "type": point_type,
                "lat": lat_w,
                "lng": lng_w,
                "alt": alt,
                "desc": desc,
            }
            result["all_points"].append(point)

            if "中心" in point_type:
                if result["center_lat"] is None:
                    result["center_lat"] = lat_w
                    result["center_lng"] = lng_w
                    result["center_alt"] = alt
            elif "边界" in point_type:
                result["boundary_points"].append(point)
            elif "标志" in point_type:
                result["marker_points"].append(point)
        except (IndexError, ValueError):
            continue

    if result["center_lat"] is None and result["boundary_points"]:
        lats = [p["lat"] for p in result["boundary_points"]]
        lngs = [p["lng"] for p in result["boundary_points"]]
        result["center_lat"] = round(sum(lats) / len(lats), 8)
        result["center_lng"] = round(sum(lngs) / len(lngs), 8)

    return result


def count_table_rows(md: str, section_name: str) -> int:
    section = get_section_text(md, section_name)
    count = 0
    for line in section.split('\n'):
        if (line.strip().startswith('|')
                and '---' not in line
                and '序号' not in line
                and '图纸编号' not in line
                and '照片编号' not in line):
            cols = [c.strip() for c in line.split('|') if c.strip()]
            real_cols = [c for c in cols if c not in ['（无）', '（）', '']]
            if real_cols:
                count += 1
    return count


def parse_area_numeric(area_str: str) -> float | None:
    m = re.search(r'(\d+\.?\d*)', str(area_str))
    return float(m.group(1)) if m else None


def parse_intro(md: str) -> str:
    section = get_section_text(md, "简介")
    if section in ["（完整复制原文简介）", "（无）", ""]:
        return ""
    return section.strip()


def parse_single_md(md_path: Path, township_name: str, convert) -> dict:
    content = md_path.read_text(encoding='utf-8')
    title_m = re.search(r'^# (.+)$', content, re.MULTILINE)
    name = title_m.group(1).strip() if title_m else ""

    bi = "基本信息"
    archive_code = get_field(content, bi, "档案编号")
    survey_type = get_field(content, bi, "普查性质")
    category_main = get_field(content, bi, "文物大类")
    province = get_field(content, bi, "省份")
    city = get_field(content, bi, "地级市")
    county = get_field(content, bi, "县区")
    surveyors = get_field(content, bi, "调查人")
    survey_date = get_field(content, bi, "调查日期")
    reviewer = get_field(content, bi, "审定人")
    review_date = get_field(content, bi, "审定日期")

    li = "位置信息"
    address = get_field(content, li, "详细地址")
    is_relocated = get_field(content, li, "是否整体迁移")
    is_changed = get_field(content, li, "是否变更或消失")

    coords = parse_coordinates(content, convert)

    fa = "文物属性"
    area_raw = get_field(content, fa, "总面积")
    heritage_level = get_field(content, fa, "文物级别")
    prot_unit = get_field(content, fa, "所属文物保护单位名称")
    has_prot_zone = get_field(content, fa, "已公布保护范围")
    has_ctrl_zone = get_field(content, fa, "已公布建设控制地带")
    era = get_field(content, fa, "年代")
    era_stats = get_field(content, fa, "统计年代")
    category_sub = get_field(content, fa, "类别（细分）")

    ow = "权属与使用"
    ownership_type = get_field(content, ow, "所有权性质")
    owner = get_field(content, ow, "产权单位或人")
    user = get_field(content, ow, "使用单位或人")
    managing_org = get_field(content, ow, "上级管理机构")
    industry = get_field(content, ow, "所属行业或系统")
    is_open = get_field(content, ow, "开放状况")
    usage = get_field(content, ow, "使用用途")

    ps = "保存现状"
    condition_level = get_field(content, ps, "现状评估")
    prot_measures = get_field(content, ps, "已完成保护措施")
    risk_factors = get_field(content, ps, "主要影响因素")

    audit_result = get_field(content, "审核信息", "审核意见")

    remark_section = get_section_text(content, "备注")
    remark = "" if remark_section in ["（无）", "（完整复制原文备注，若无则填（无））"] else remark_section

    intro = parse_intro(content)

    drawing_count = count_table_rows(content, "图纸清单")
    photo_count = count_table_rows(content, "照片清单")
    area_numeric = parse_area_numeric(area_raw)

    risk_score = 0
    risk_map = {"差": 5, "较差": 4, "一般": 2, "较好": 1, "好": 0}
    risk_score += risk_map.get(condition_level, 0)
    if not prot_measures:
        risk_score += 3
    if "全国重点" in heritage_level:
        risk_score += 2
    elif "省级" in heritage_level:
        risk_score += 1

    return {
        "archive_code": archive_code, "name": name, "survey_type": survey_type,
        "category_main": category_main, "category_sub": category_sub,
        "era": era, "era_stats": era_stats, "heritage_level": heritage_level,
        "province": province, "city": city, "county": county,
        "township": township_name, "address": address,
        "center_lat": coords["center_lat"],
        "center_lng": coords["center_lng"],
        "center_alt": coords["center_alt"],
        "has_boundary": len(coords["boundary_points"]) >= 3,
        "boundary_count": len(coords["boundary_points"]),
        "area": area_raw, "area_numeric": area_numeric,
        "prot_unit": prot_unit,
        "has_prot_zone": has_prot_zone, "has_ctrl_zone": has_ctrl_zone,
        "ownership_type": ownership_type, "owner": owner, "user": user,
        "managing_org": managing_org, "industry": industry,
        "is_open": is_open, "usage": usage,
        "is_relocated": is_relocated, "is_changed": is_changed,
        "condition_level": condition_level, "prot_measures": prot_measures,
        "risk_factors": risk_factors, "audit_result": audit_result,
        "surveyors": surveyors, "survey_date": survey_date,
        "reviewer": reviewer, "review_date": review_date,
        "drawing_count": drawing_count, "photo_count": photo_count,
        "risk_score": risk_score,
        "intro": intro, "remark": remark,
        "source_file": md_path.name,
        "source_path": str(md_path),
        "_boundary_points": coords["boundary_points"],
    }


def apply_3d_mapping(records: list[dict], models_dir: Path, log) -> int:
    """按目录名关联 3D tileset 到文物。
    命中顺序:name 精确 → 目录名以 archive_code 开头 → 双向子串包含。
    命中后写入 has_3d=True 与 model_3d_path='05_models_3d/<folder>'。"""
    for r in records:
        r["has_3d"] = False
        r["model_3d_path"] = ""

    if not models_dir.exists():
        return 0

    candidates = []
    for sub in sorted(models_dir.iterdir()):
        if not sub.is_dir():
            continue
        # 兼容两种布局:<name>/tileset.json 与 <name>/3dtiles/tileset.json。
        if (sub / "tileset.json").exists() or (sub / "3dtiles" / "tileset.json").exists():
            candidates.append(sub.name)

    if not candidates:
        return 0

    by_name = {r["name"]: r for r in records if r["name"]}
    by_code = {r["archive_code"]: r for r in records if r["archive_code"]}
    matched = 0
    unmatched_folders: list[str] = []

    for folder in candidates:
        r = by_name.get(folder)
        if r is None:
            for code, rc in by_code.items():
                if folder.startswith(code):
                    r = rc
                    break
        if r is None:
            for name, rc in by_name.items():
                if folder in name or name in folder:
                    r = rc
                    break
        if r is None:
            unmatched_folders.append(folder)
            continue
        r["has_3d"] = True
        r["model_3d_path"] = f"05_models_3d/{folder}"
        matched += 1

    log.info(f"  3D 模型候选文件夹: {len(candidates)}  已匹配: {matched}")
    if unmatched_folders:
        log.warning(
            f"  {len(unmatched_folders)} 个模型文件夹未能自动匹配到文物，"
            f"可手动重命名为对应 archive_code 或文物名（示例: {unmatched_folders[:3]}）"
        )
    return matched


CSV_FIELDS = [
    "archive_code", "name", "survey_type",
    "category_main", "category_sub",
    "era", "era_stats", "heritage_level",
    "province", "city", "county", "township", "address",
    "center_lat", "center_lng", "center_alt",
    "has_boundary", "boundary_count",
    "area", "area_numeric",
    "prot_unit", "has_prot_zone", "has_ctrl_zone",
    "ownership_type", "owner", "user",
    "managing_org", "industry", "is_open", "usage",
    "is_relocated", "is_changed",
    "condition_level", "prot_measures", "risk_factors",
    "audit_result",
    "surveyors", "survey_date", "reviewer", "review_date",
    "drawing_count", "photo_count", "risk_score",
    "intro", "remark",
    "has_3d", "model_3d_path",
    "source_file",
]


def save_csv(records: list[dict], path: Path, log) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)
    log.info(f"  ✓ CSV 已保存: {path.name} ({len(records)} 行)")


def save_json(records: list[dict], path: Path, log) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = []
    for r in records:
        item = {k: v for k, v in r.items() if not k.startswith('_')}
        item["boundary_points"] = r.get("_boundary_points", [])
        clean.append(item)
    path.write_text(
        json.dumps(clean, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    log.info(f"  ✓ JSON 已保存: {path.name} ({len(clean)} 条)")


def save_points_geojson(records: list[dict], path: Path, log) -> None:
    features = []
    skipped = 0
    for r in records:
        if r["center_lat"] is None or r["center_lng"] is None:
            skipped += 1
            continue
        props = {k: v for k, v in r.items()
                 if not k.startswith('_') and k not in ("intro", "remark")}
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r["center_lng"], r["center_lat"]],
            },
            "properties": props,
        })
    geojson = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(geojson, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    log.info(f"  ✓ 点图层: {path.name} ({len(features)} 个点，跳过 {skipped} 无坐标)")


def save_polygons_geojson(records: list[dict], path: Path, log) -> None:
    features = []
    skipped = 0
    for r in records:
        boundary = r.get("_boundary_points", [])
        if len(boundary) < 3:
            skipped += 1
            continue
        ring = [[p["lng"], p["lat"]] for p in boundary]
        ring.append(ring[0])
        props = {k: v for k, v in r.items()
                 if not k.startswith('_') and k not in ("intro", "remark")}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": props,
        })
    geojson = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(geojson, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    log.info(f"  ✓ 面图层: {path.name} ({len(features)} 个面)")


def save_by_township(records: list[dict], out_dir: Path, log) -> None:
    by_town: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_town[r["township"]].append(r)

    tdir = out_dir / "by_township"
    tdir.mkdir(parents=True, exist_ok=True)

    for township, recs in sorted(by_town.items()):
        csv_path = tdir / f"{township}.csv"
        with csv_path.open('w', newline='', encoding='utf-8-sig') as f:
            writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(recs)
        json_path = tdir / f"{township}.json"
        clean = []
        for r in recs:
            item = {k: v for k, v in r.items() if not k.startswith('_')}
            item["boundary_points"] = r.get("_boundary_points", [])
            clean.append(item)
        json_path.write_text(
            json.dumps(clean, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        log.info(f"  ✓ [{township}] {len(recs)} 处")


def save_high_risk(records: list[dict], path: Path, top_n: int, log) -> None:
    srt = sorted(records, key=lambda x: -x.get("risk_score", 0))
    top = srt[:top_n]
    fields = [
        "risk_score", "archive_code", "name", "township",
        "category_main", "era", "heritage_level",
        "condition_level", "prot_measures", "risk_factors",
        "ownership_type", "address",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(top)
    log.info(f"  ✓ 高风险清单: {path.name} (Top {len(top)})")


def save_township_stats(records: list[dict], path: Path, log) -> None:
    by_town: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_town[r["township"]].append(r)

    cond_levels = ["好", "较好", "一般", "较差", "差"]
    # 四普六大类,顺序按国家文物局口径固定。
    cat_levels = [
        "古遗址", "古墓葬", "古建筑", "石窟寺及石刻",
        "近现代重要史迹及代表性建筑", "其他",
    ]

    rows = []
    for township, recs in sorted(by_town.items()):
        total = len(recs)
        cond_count = Counter(r["condition_level"] for r in recs)
        cat_count = Counter(r["category_main"] for r in recs)
        no_prot = sum(1 for r in recs if not r["prot_measures"])
        poor = sum(1 for r in recs if r["condition_level"] in ["较差", "差"])
        poor_no_prot = sum(
            1 for r in recs
            if r["condition_level"] in ["较差", "差"] and not r["prot_measures"]
        )
        has_coord = sum(1 for r in recs if r["center_lat"] is not None)
        row = {
            "乡镇": township, "文物总数": total, "有坐标": has_coord,
            "无保护措施": no_prot, "保存差或较差": poor,
            "高风险（差且无保护）": poor_no_prot,
        }
        for lv in cond_levels:
            row[f"现状_{lv}"] = cond_count.get(lv, 0)
        for cat in cat_levels:
            row[f"类别_{cat}"] = cat_count.get(cat, 0)
        rows.append(row)

    fields = (
        ["乡镇", "文物总数", "有坐标", "无保护措施", "保存差或较差", "高风险（差且无保护）"]
        + [f"现状_{lv}" for lv in cond_levels]
        + [f"类别_{cat}" for cat in cat_levels]
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    log.info(f"  ✓ 乡镇汇总: {path.name} ({len(rows)} 个乡镇)")


def save_type_stats(records: list[dict], path: Path, log) -> None:
    rows = []
    total = len(records) or 1

    def _append(group: str, counter: Counter, missing_label: str) -> None:
        for val, cnt in counter.most_common():
            rows.append({
                "维度": group, "值": val or missing_label,
                "数量": cnt, "占比": f"{cnt / total * 100:.1f}%",
            })
        rows.append({"维度": "──", "值": "", "数量": "", "占比": ""})

    _append("文物大类", Counter(r["category_main"] for r in records), "未知")
    _append("统计年代", Counter(r["era_stats"] for r in records if r.get("era_stats")), "")
    _append("文物级别", Counter(r["heritage_level"] for r in records), "未填")
    _append("保存现状", Counter(r["condition_level"] for r in records), "未填")
    _append("所有权", Counter(r["ownership_type"] for r in records), "未填")

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=["维度", "值", "数量", "占比"],
                                extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    log.info(f"  ✓ 类型统计: {path.name}")


def print_overview(records: list[dict], log) -> None:
    total = len(records) or 1
    log.info("-" * 60)
    log.info(f"数据概览 — 文物总数: {total}")
    cat_c = Counter(r["category_main"] for r in records)
    for cat, cnt in cat_c.most_common():
        log.info(f"  [大类] {cat or '未知':<20} {cnt:>4}  ({cnt/total*100:.1f}%)")
    has_coord = sum(1 for r in records if r["center_lat"] is not None)
    has_bound = sum(1 for r in records if r.get("has_boundary"))
    no_prot = sum(1 for r in records if not r["prot_measures"])
    poor = sum(1 for r in records if r["condition_level"] in ["较差", "差"])
    high_risk = sum(1 for r in records
                    if r["condition_level"] in ["较差", "差"] and not r["prot_measures"])
    n3d = sum(1 for r in records if r.get("has_3d"))
    log.info(f"  有坐标: {has_coord}/{total}  有边界面: {has_bound}  "
             f"无保护: {no_prot}  较差/差: {poor}  高风险: {high_risk}  3D: {n3d}")
    log.info("-" * 60)


def main() -> int:
    log = get_logger(STEP_ID)
    cfg = load_config()
    paths = get_paths()

    src_crs = (cfg.get("geo") or {}).get("source_crs", "wgs84")
    convert = make_crs_converter(src_crs)

    pipe_cfg = (cfg.get("pipeline") or {}).get("step02_build_dataset") or {}
    top_n = int(pipe_cfg.get("high_risk_top_n", 50))

    md_root = paths.output_markdown
    out_dir = paths.output_dataset

    log.info("=" * 70)
    log.info("Step 02 | Markdown → 结构化数据集")
    log.info(f"  输入: {md_root}")
    log.info(f"  输出: {out_dir}")
    log.info(f"  源坐标系: {src_crs}  → WGS-84")
    log.info("=" * 70)

    if not md_root.exists() or not any(md_root.iterdir()):
        log.error(f"未找到 Markdown 输入: {md_root}，请先运行 step01。")
        return 11

    out_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict] = []
    fail_list: list[str] = []

    log.info("正在解析 Markdown 文件...")
    for township_dir in sorted(md_root.iterdir()):
        if not township_dir.is_dir():
            continue
        # 允许目录名带排序前缀(如 "01示范街道"),去掉前缀后与边界层乡镇名对齐。
        township_name = re.sub(r"^[\d_\-\s]+", "", township_dir.name) or township_dir.name
        for md_path in sorted(township_dir.glob("*.md")):
            if md_path.name.endswith("_QC.md"):
                continue
            try:
                records.append(parse_single_md(md_path, township_name, convert))
            except Exception as e:
                log.warning(f"  ⚠ 解析失败: {md_path.name} | {e}")
                fail_list.append(str(md_path))

    log.info(f"解析完成: {len(records)} 成功, {len(fail_list)} 失败")
    if not records:
        log.error("没有解析到任何记录。")
        return 12

    log.info("正在关联三维模型...")
    apply_3d_mapping(records, paths.input_models_3d, log)

    print_overview(records, log)

    log.info("正在生成输出文件...")
    save_csv(records, out_dir / "relics_master.csv", log)
    save_json(records, out_dir / "relics_full.json", log)
    save_points_geojson(records, out_dir / "relics_points.geojson", log)
    save_polygons_geojson(records, out_dir / "relics_polygons.geojson", log)
    save_by_township(records, out_dir, log)
    save_high_risk(records, out_dir / "high_risk_relics.csv", top_n, log)
    save_township_stats(records, out_dir / "township_stats.csv", log)
    save_type_stats(records, out_dir / "category_stats.csv", log)

    if fail_list:
        fail_path = out_dir / "parse_failures.txt"
        fail_path.write_text("\n".join(fail_list), encoding='utf-8')
        log.warning(f"{len(fail_list)} 个文件解析失败，详见: {fail_path}")

    log.info("=" * 70)
    log.info(f"全部完成 — 输出目录: {out_dir}")
    log.info("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
