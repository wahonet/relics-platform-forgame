"""Markdown 文物档案解析库(四普登记表提取产物)。

移植自参照项目《文物数据处理》的 build_dataset.py / extract_photos.py:
- 章节/表格字段提取、度分秒坐标转换、中心点与边界点解析
- 图纸清单 / 照片清单解析
- 从源 docx 按清单顺序抽取内嵌图片(图纸在前、照片在后)

step01_import_relics.py 调用本模块;不直接依赖 config。
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Optional

_EMPTY_VALUES = {"（无）", "（）", "无", "-", "—", ""}

_DMS_RE = re.compile(r'(\d+)[°度]\s*(\d+)[′\']\s*(\d+\.?\d*)[″"]')


def dms_to_decimal(dms_str: str) -> Optional[float]:
    """度分秒 → 十进制度。'35°23′14.3925″' → 35.38733125;兼容纯十进制。"""
    s = str(dms_str).strip()
    m = _DMS_RE.search(s)
    if m:
        d, mi, sec = float(m.group(1)), float(m.group(2)), float(m.group(3))
        return round(d + mi / 60 + sec / 3600, 8)
    try:
        v = float(s)
        return round(v, 8)
    except ValueError:
        return None


def get_section_text(md: str, section: str) -> str:
    """提取 `## 章节` 的全部文本(到下一个 ## 或文末)。"""
    m = re.search(rf"## {re.escape(section)}\s*\n(.*?)(?=\n## |\Z)", md, re.DOTALL)
    return m.group(1).strip() if m else ""


def get_table_value(section_text: str, field: str) -> str:
    """从 `| 字段 | 值 |` 形式的表格取值,空值统一归一为 ''。"""
    m = re.search(rf"\|\s*{re.escape(field)}\s*\|\s*(.+?)\s*\|", section_text)
    if not m:
        return ""
    val = m.group(1).strip()
    return "" if val in _EMPTY_VALUES else val


def get_field(md: str, section: str, field: str) -> str:
    return get_table_value(get_section_text(md, section), field)


def _table_rows(section_text: str) -> list[list[str]]:
    """解析章节内的 markdown 表格数据行(跳过表头/分隔线),返回单元格列表。"""
    rows: list[list[str]] = []
    for line in section_text.split("\n"):
        line = line.strip()
        if not line.startswith("|"):
            continue
        if "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows.append(cells)
    return rows


def parse_coordinates(md: str) -> dict:
    """解析「坐标数据」章节。

    返回 center_lat/lng/alt、boundary_points、marker_points、all_points。
    无中心点时用边界点质心兜底。
    """
    result = {
        "center_lat": None, "center_lng": None, "center_alt": None,
        "boundary_points": [], "marker_points": [], "all_points": [],
    }
    section = get_section_text(md, "坐标数据")
    if not section:
        return result

    for cells in _table_rows(section):
        if not cells or cells[0] in ("序号",):
            continue
        if len(cells) < 6:
            continue
        # 列序:序号|分组|测点类型|纬度|经度|海拔(m)|测点说明|备注
        point_type = cells[2] if len(cells) > 2 else ""
        lat = dms_to_decimal(cells[3]) if len(cells) > 3 else None
        lng = dms_to_decimal(cells[4]) if len(cells) > 4 else None
        alt_m = re.search(r"(\d+\.?\d*)", cells[5]) if len(cells) > 5 else None
        desc = cells[6] if len(cells) > 6 else ""
        if lat is None or lng is None:
            continue
        point = {
            "type": point_type, "lat": lat, "lng": lng,
            "alt": float(alt_m.group(1)) if alt_m else None,
            "desc": "" if desc in _EMPTY_VALUES else desc,
        }
        result["all_points"].append(point)
        if "中心" in point_type:
            if result["center_lat"] is None:
                result["center_lat"] = lat
                result["center_lng"] = lng
                result["center_alt"] = point["alt"]
        elif "边界" in point_type:
            result["boundary_points"].append(point)
        elif "标志" in point_type:
            result["marker_points"].append(point)

    if result["center_lat"] is None and result["boundary_points"]:
        lats = [p["lat"] for p in result["boundary_points"]]
        lngs = [p["lng"] for p in result["boundary_points"]]
        result["center_lat"] = round(sum(lats) / len(lats), 8)
        result["center_lng"] = round(sum(lngs) / len(lngs), 8)
    return result


def parse_media_lists(md: str) -> tuple[list[dict], list[dict]]:
    """解析「图纸清单」「照片清单」,返回 (drawings, photos) 元数据列表。"""
    drawings: list[dict] = []
    section = get_section_text(md, "图纸清单")
    for cells in _table_rows(section):
        if not cells or cells[0] in ("序号",):
            continue
        real = [c for c in cells if c not in _EMPTY_VALUES]
        if not real:
            continue
        drawings.append({
            "drawing_code": cells[1] if len(cells) > 1 else "",
            "drawing_name": cells[2] if len(cells) > 2 else "",
            "drawing_no": cells[3] if len(cells) > 3 else "",
            "scale": cells[4] if len(cells) > 4 else "",
            "drafter": cells[5] if len(cells) > 5 else "",
            "draft_date": cells[6] if len(cells) > 6 else "",
        })

    photos: list[dict] = []
    section = get_section_text(md, "照片清单")
    for cells in _table_rows(section):
        if not cells or cells[0] in ("序号",):
            continue
        real = [c for c in cells if c not in _EMPTY_VALUES]
        if not real:
            continue
        photos.append({
            "photo_code": cells[1] if len(cells) > 1 else "",
            "photo_name": cells[2] if len(cells) > 2 else "",
            "photo_no": cells[3] if len(cells) > 3 else "",
            "photographer": cells[4] if len(cells) > 4 else "",
            "shoot_date": cells[5] if len(cells) > 5 else "",
            "direction": cells[6] if len(cells) > 6 else "",
            "description": cells[7] if len(cells) > 7 else "",
        })
    return drawings, photos


def parse_archive_md(md_path: Path, group_name: str = "") -> dict:
    """解析单个 markdown 档案为完整字段字典(键与平台 relics_full.json 对齐)。"""
    content = md_path.read_text(encoding="utf-8")

    title = re.search(r"^# (.+)$", content, re.MULTILINE)
    name = title.group(1).strip() if title else ""

    bi = "基本信息"
    fa = "文物属性"
    ow = "权属与使用"
    ps = "保存现状"

    coords = parse_coordinates(content)
    drawings_meta, photos_meta = parse_media_lists(content)

    intro = get_section_text(content, "简介")
    if intro in ("（完整复制原文简介）", "（无）"):
        intro = ""
    remark = get_section_text(content, "备注")
    if remark in ("（无）", "（完整复制原文备注，若无则填（无））"):
        remark = ""

    area_raw = get_field(content, fa, "总面积")
    area_num = re.search(r"(\d+\.?\d*)", area_raw)

    # 乡镇:分组文件夹名形如"05仲山镇/卧龙山街道"时采用;
    # 文件夹是县区名或"未定级文物"这类分类名时,改从详细地址解析
    township = group_name if re.search(r"[镇乡]$|街道$", group_name) else ""
    if not township:
        address = get_field(content, "位置信息", "详细地址")
        m = re.search(r"[县区市]([^省市县区]{1,10}?(?:[镇乡]|街道))", address)
        township = m.group(1) if m else ""

    return {
        "archive_code": get_field(content, bi, "档案编号"),
        "name": name,
        "survey_type": get_field(content, bi, "普查性质"),
        "category_main": get_field(content, fa, "类别（大类）") or get_field(content, bi, "文物大类"),
        "category_sub": get_field(content, fa, "类别（细分）"),
        "era": get_field(content, fa, "年代"),
        "era_stats": get_field(content, fa, "统计年代"),
        "heritage_level": get_field(content, fa, "文物级别"),
        "province": get_field(content, bi, "省份"),
        "city": get_field(content, bi, "地级市"),
        "county": get_field(content, bi, "县区"),
        "township": township,
        "address": get_field(content, "位置信息", "详细地址"),
        "is_relocated": get_field(content, "位置信息", "是否整体迁移"),
        "is_changed": get_field(content, "位置信息", "是否变更或消失"),
        "center_lat": coords["center_lat"],
        "center_lng": coords["center_lng"],
        "center_alt": coords["center_alt"],
        "area": area_raw,
        "area_numeric": float(area_num.group(1)) if area_num else None,
        "prot_unit": get_field(content, fa, "所属文物保护单位名称"),
        "has_prot_zone": get_field(content, fa, "已公布保护范围"),
        "has_ctrl_zone": get_field(content, fa, "已公布建设控制地带"),
        "protection_scope": "",
        "control_zone": "",
        "ownership_type": get_field(content, ow, "所有权性质"),
        "owner": get_field(content, ow, "产权单位或人"),
        "user": get_field(content, ow, "使用单位或人"),
        "managing_org": get_field(content, ow, "上级管理机构"),
        "industry": get_field(content, ow, "所属行业或系统"),
        "is_open": get_field(content, ow, "开放状况"),
        "usage": get_field(content, ow, "使用用途"),
        "condition_level": get_field(content, ps, "现状评估"),
        "prot_measures": get_field(content, ps, "已完成保护措施"),
        "risk_factors": get_field(content, ps, "主要影响因素"),
        "audit_result": get_field(content, "审核信息", "审核意见"),
        "surveyors": get_field(content, bi, "调查人"),
        "survey_date": get_field(content, bi, "调查日期"),
        "reviewer": get_field(content, bi, "审定人"),
        "review_date": get_field(content, bi, "审定日期"),
        "intro": intro,
        "remark": remark,
        "source_file": md_path.name,
        # 私有字段:step01 用完即弃,不进 relics_full.json
        "_boundary_points": coords["boundary_points"],
        "_drawings_meta": drawings_meta,
        "_photos_meta": photos_meta,
    }


# ── docx 内嵌图片抽取 ────────────────────────────────────────

def docx_image_sequence(docx_path: Path) -> list[str]:
    """按正文出现顺序返回 docx 内嵌图片的 zip 内部路径。"""
    ordered: list[str] = []
    with zipfile.ZipFile(docx_path, "r") as z:
        rels_root = ET.fromstring(z.read("word/_rels/document.xml.rels"))
        ns = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
        rid_map = {}
        for rel in rels_root.findall("rel:Relationship", ns):
            target = rel.get("Target") or ""
            if target.startswith("media/"):
                rid_map[rel.get("Id")] = f"word/{target}"

        doc_str = z.read("word/document.xml").decode("utf-8", "replace")
        rids = re.findall(r'r:embed="([^"]+)"', doc_str)
        rids += re.findall(r'r:id="([^"]+)"', doc_str)
        seen: set[str] = set()
        for rid in rids:
            if rid in rid_map and rid not in seen:
                seen.add(rid)
                ordered.append(rid_map[rid])
    return ordered


def _safe_name(name: str) -> str:
    return re.sub(r'[\/\\:\*\?"<>\|]', "_", name or "").strip() or "未命名"


def extract_media_from_docx(
    docx_path: Path,
    code: str,
    drawings_meta: list[dict],
    photos_meta: list[dict],
    out_drawings_dir: Path,
    out_photos_dir: Path,
) -> tuple[list[dict], list[dict]]:
    """按清单顺序从 docx 抽取图片:前 N 张对应图纸清单,其后对应照片清单。

    返回 (drawing_index_rows, photo_index_rows),行内 path 为 `{code}/{文件名}`。
    目标文件已存在且非空时跳过写出(幂等)。
    """
    images = docx_image_sequence(docx_path)
    drawing_rows: list[dict] = []
    photo_rows: list[dict] = []

    with zipfile.ZipFile(docx_path, "r") as z:
        def _write(zip_path: str, dst: Path) -> None:
            if dst.exists() and dst.stat().st_size > 0:
                return
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(z.read(zip_path))

        for i, meta in enumerate(drawings_meta):
            if i >= len(images):
                break
            zip_path = images[i]
            ext = Path(zip_path).suffix.lower() or ".jpg"
            no = meta.get("drawing_no") or f"T{i + 1:03d}"
            fname = f"{code}_{no}_{_safe_name(meta.get('drawing_name', ''))}{ext}"
            _write(zip_path, out_drawings_dir / code / fname)
            drawing_rows.append({
                "archive_code": code,
                "path": f"{code}/{fname}",
                "drawing_no": no,
                "drawing_name": meta.get("drawing_name", ""),
            })

        base = len(drawings_meta)
        for i, meta in enumerate(photos_meta):
            idx = base + i
            if idx >= len(images):
                break
            zip_path = images[idx]
            ext = Path(zip_path).suffix.lower() or ".jpg"
            no = meta.get("photo_no") or f"Z{i + 1:03d}"
            fname = f"{code}_{no}_{_safe_name(meta.get('photo_name', ''))}{ext}"
            _write(zip_path, out_photos_dir / code / fname)
            photo_rows.append({
                "archive_code": code,
                "path": f"{code}/{fname}",
                "photo_no": no,
                "description": meta.get("description", "") or meta.get("photo_name", ""),
            })

    return drawing_rows, photo_rows
