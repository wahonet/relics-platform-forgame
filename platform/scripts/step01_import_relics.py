"""Step 01 | 导入文物数据,生成标准化数据集。

数据源(按优先级):
    A. Markdown 档案  data/input/01_relics/markdown/{分组}/*.md
       (step00 从四普登记表 docx 提取的产物,含简介/DMS坐标/本体边界/清单)
       照片与图纸直接从 data/input/00_docs 对应 docx 内嵌图片按清单顺序抽取。
    B. 台账 Excel/CSV data/input/01_relics/*.xlsx|csv (旧格式,兼容保留)

输出:
    data/output/dataset/relics_full.json
    data/output/dataset/relics_points.geojson
    data/output/dataset/relics_polygons.geojson   (本体边界 kind=body + 两线面)
    data/output/dataset/photo_index.csv / drawing_index.csv
    data/output/photos/{code}/... / data/output/drawings/{code}/...
"""
from __future__ import annotations

import csv
import json
import shutil
import sys
from pathlib import Path

from _common import get_logger, get_paths, load_config
from codes import normalize_category, normalize_rank, parse_coord
from md_archive import extract_media_from_docx, parse_archive_md

log = get_logger("step01_import_relics")

# ── 台账中文列名 → 内部字段(Excel 兼容路径用) ─────────────────
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


# ════════════════════════════════════════════════════════════
# A. Markdown 档案导入
# ════════════════════════════════════════════════════════════

def _find_docx_for(md_path: Path, code: str, docs_root: Path) -> Path | None:
    """按分组同名/档案号前缀匹配源 docx(照片图纸内嵌其中)。"""
    if not docs_root.exists():
        return None
    group = md_path.parent.name
    candidates = []
    group_dir = docs_root / group
    if group_dir.exists():
        candidates.append(group_dir / f"{md_path.stem}.docx")
        candidates.extend(sorted(group_dir.glob(f"{code}*.docx")))
    candidates.append(docs_root / f"{md_path.stem}.docx")
    candidates.extend(sorted(docs_root.glob(f"{code}*.docx")))
    for c in candidates:
        if c.exists():
            return c
    return None


def _copy_media_dir(src_root: Path, dst_root: Path, code: str,
                    kinds: tuple[str, ...]) -> list[dict]:
    """input/02_media/{photos|drawings}/{code}/ → output;返回索引行。"""
    index: list[dict] = []
    code_dir = src_root / code
    if not code_dir.exists():
        return index
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


def import_from_markdown(paths, cfg: dict) -> tuple[list[dict], list[dict], list[dict], list[dict]] | None:
    """解析 markdown 档案。返回 (relics, photo_index, drawing_index, boundary_features);
    没有 md 文件时返回 None(让调用方走 Excel 路径)。"""
    md_root = paths.input_markdown
    md_files: list[Path] = []
    if md_root.exists():
        md_files = sorted(p for p in md_root.rglob("*.md") if not p.name.endswith("_QC.md"))
    if not md_files:
        return None

    log.info("[MD] 发现 %d 个 markdown 档案: %s", len(md_files), md_root)

    full_tier_county = ((cfg.get("administrative") or {}).get("full_tier_county") or "").strip()
    src_crs = ((cfg.get("geo") or {}).get("source_crs") or "wgs84").lower()

    relics: list[dict] = []
    photo_index: list[dict] = []
    drawing_index: list[dict] = []
    boundary_features: list[dict] = []
    seen: set[str] = set()
    n_fail = n_media_docx = n_media_dir = 0

    for md_path in md_files:
        group = md_path.parent.name if md_path.parent != md_root else ""
        try:
            r = parse_archive_md(md_path, group_name=group)
        except Exception as e:  # noqa: BLE001
            log.warning("[MD] 解析失败 %s: %s", md_path.name, e)
            n_fail += 1
            continue

        code = r.get("archive_code") or ""
        name = r.get("name") or ""
        if not code or not name:
            log.warning("[MD] 缺编号或名称,跳过: %s", md_path.name)
            n_fail += 1
            continue
        if code in seen:
            log.warning("[MD] 重复编号,跳过: %s (%s)", code, md_path.name)
            continue
        if r.get("center_lng") is None or r.get("center_lat") is None:
            log.warning("[MD] 无有效坐标,跳过: %s %s", code, name)
            n_fail += 1
            continue
        seen.add(code)

        if src_crs == "gcj02":
            from _common import gcj02_to_wgs84
            r["center_lng"], r["center_lat"] = gcj02_to_wgs84(r["center_lng"], r["center_lat"])

        boundary_points = r.pop("_boundary_points", [])
        drawings_meta = r.pop("_drawings_meta", [])
        photos_meta = r.pop("_photos_meta", [])

        # 保存状况兜底 + 层级判定(全量层县 → full)
        cond = r.get("condition_level", "")
        r["condition_level"] = cond if cond in _CONDITIONS else (cond or "一般")
        r["tier"] = "full" if (full_tier_county and full_tier_county in (r.get("county") or "")) else "city"
        r["heritage_level"] = r.get("heritage_level") or "尚未核定公布为文物保护单位的不可移动文物"
        r["category_main"] = r.get("category_main") or "其他"
        if not r.get("era_stats"):
            r["era_stats"] = r.get("era", "")
        r["center_alt"] = r.get("center_alt") if r.get("center_alt") is not None else 0.0
        r["category_code"] = normalize_category(r.get("category_main"))
        r["rank_code"] = normalize_rank(r.get("heritage_level"))

        # 本体边界(≥3 个边界点成面, kind=body)
        r["has_boundary"] = len(boundary_points) >= 3
        r["boundary_count"] = len(boundary_points)
        if r["has_boundary"]:
            ring = [[p["lng"], p["lat"]] for p in boundary_points]
            ring.append(ring[0])
            boundary_features.append({
                "type": "Feature",
                "properties": {"archive_code": code, "kind": "body", "name": name},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })

        # 媒体:优先从源 docx 抽取内嵌图片,否则回退 02_media 目录
        docx = _find_docx_for(md_path, code, paths.input_docs)
        if docx and (drawings_meta or photos_meta):
            try:
                d_rows, p_rows = extract_media_from_docx(
                    docx, code, drawings_meta, photos_meta,
                    paths.output_drawings, paths.output_photos,
                )
                drawing_index.extend(d_rows)
                photo_index.extend(p_rows)
                n_media_docx += 1
            except Exception as e:  # noqa: BLE001
                log.warning("[MD] %s 抽取 docx 图片失败: %s", code, e)
        else:
            p_rows = _copy_media_dir(paths.input_media / "photos", paths.output_photos,
                                     code, (".jpg", ".jpeg", ".png", ".webp"))
            d_rows = _copy_media_dir(paths.input_media / "drawings", paths.output_drawings,
                                     code, (".jpg", ".jpeg", ".png", ".webp", ".pdf"))
            photo_index.extend(p_rows)
            drawing_index.extend(d_rows)
            if p_rows or d_rows:
                n_media_dir += 1

        relics.append(r)

    log.info("[MD] 解析成功 %d / 失败 %d;媒体来源: docx %d 处 / 目录 %d 处",
             len(relics), n_fail, n_media_docx, n_media_dir)
    return relics, photo_index, drawing_index, boundary_features


# ════════════════════════════════════════════════════════════
# B. Excel/CSV 台账导入(旧格式兼容)
# ════════════════════════════════════════════════════════════

def _find_source(input_dir: Path) -> Path | None:
    for pat in ("*.xlsx", "*.xls", "*.csv"):
        files = sorted(p for p in input_dir.glob(pat) if not p.name.startswith("~"))
        if files:
            return files[0]
    return None


def _read_rows(src: Path) -> list[dict]:
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


def import_from_excel(paths, cfg: dict) -> tuple[list[dict], list[dict], list[dict], list[dict]] | None:
    src = _find_source(paths.input_relics)
    if not src:
        return None
    src_crs = ((cfg.get("geo") or {}).get("source_crs") or "wgs84").lower()

    log.info("[Excel] 台账: %s", src.name)
    raw_rows = _read_rows(src)
    log.info("[Excel] 读到 %d 行", len(raw_rows))

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
        r["category_code"] = normalize_category(r.get("category_main"))
        r["rank_code"] = normalize_rank(r.get("heritage_level"))
        relics.append(r)

    if not relics:
        log.error("有效记录为 0,请检查台账列名与内容")
        return None

    photo_index = _copy_media(paths.input_media / "photos", paths.output_photos,
                              (".jpg", ".jpeg", ".png", ".webp"))
    drawing_index = _copy_media(paths.input_media / "drawings", paths.output_drawings,
                                (".jpg", ".jpeg", ".png", ".webp", ".pdf"))
    return relics, photo_index, drawing_index, []


# ════════════════════════════════════════════════════════════
# 公共产物输出
# ════════════════════════════════════════════════════════════

def _scan_archive_docs(root: Path) -> dict[str, dict[str, int]]:
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


def _write_polygons_geojson(boundary_features: list[dict], paths, out: Path) -> None:
    """本体边界(md 解析) + 两线范围面(protection_zones.geojson,若有)合并输出。"""
    feats = list(boundary_features)
    zones = paths.input_relics / "protection_zones.geojson"
    if zones.exists():
        try:
            data = json.loads(zones.read_text(encoding="utf-8"))
            extra = data.get("features") or []
            feats.extend(extra)
            log.info("[导出] 合并两线范围面 %d 个要素", len(extra))
        except Exception as e:  # noqa: BLE001
            log.warning("[导出] protection_zones.geojson 解析失败: %s", e)
    if not feats:
        return
    out.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False),
        encoding="utf-8",
    )
    log.info("[导出] relics_polygons.geojson: %d 个面", len(feats))


def _write_index_csv(rows: list[dict], out: Path, fields: list[str]) -> None:
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    paths = get_paths()
    cfg = load_config()

    result = import_from_markdown(paths, cfg)
    source = "markdown"
    if result is None:
        result = import_from_excel(paths, cfg)
        source = "excel"
    if result is None:
        if (paths.output_dataset / "relics_full.json").exists():
            log.info("未找到 markdown 档案或台账,但 relics_full.json 已存在,跳过导入。")
            return 0
        log.error("未找到数据源。请把 markdown 档案放入 %s,或台账 Excel/CSV 放入 %s。",
                  paths.input_markdown, paths.input_relics)
        return 2

    relics, photo_index, drawing_index, boundary_features = result

    # 普查档案 PDF / 三维模型标记 + 媒体计数
    archives = _scan_archive_docs(paths.input_archive_docs)
    models_root = paths.input_models_3d

    photo_count: dict[str, int] = {}
    for p in photo_index:
        photo_count[p["archive_code"]] = photo_count.get(p["archive_code"], 0) + 1
    drawing_count: dict[str, int] = {}
    for d in drawing_index:
        drawing_count[d["archive_code"]] = drawing_count.get(d["archive_code"], 0) + 1

    for r in relics:
        code = r["archive_code"]
        r["photo_count"] = photo_count.get(code, 0)
        r["drawing_count"] = drawing_count.get(code, 0)
        arch = archives.get(code, {})
        r["has_archive_spu"] = bool(arch.get("sanpu"))
        r["has_archive_fpu"] = bool(arch.get("sipu"))
        model_dir = models_root / code
        r["has_3d"] = model_dir.exists() and any(model_dir.iterdir()) if model_dir.exists() else bool(r.get("has_3d"))

    paths.output_dataset.mkdir(parents=True, exist_ok=True)
    out_json = paths.output_dataset / "relics_full.json"
    out_json.write_text(json.dumps(relics, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("[导出] relics_full.json: %d 条 (数据源: %s)", len(relics), source)

    _write_points_geojson(relics, paths.output_dataset / "relics_points.geojson")
    _write_polygons_geojson(boundary_features, paths, paths.output_dataset / "relics_polygons.geojson")

    _write_index_csv(photo_index, paths.output_dataset / "photo_index.csv",
                     ["archive_code", "path", "photo_no", "description"])
    _write_index_csv(drawing_index, paths.output_dataset / "drawing_index.csv",
                     ["archive_code", "path", "drawing_no", "drawing_name"])
    log.info("[导出] 照片 %d 张 / 图纸 %d 张", len(photo_index), len(drawing_index))

    by_tier = {"city": 0, "full": 0}
    for r in relics:
        by_tier[r.get("tier", "city")] = by_tier.get(r.get("tier", "city"), 0) + 1
    log.info("[导出] 完成。基础层 %d 条 / 全量层 %d 条", by_tier.get("city", 0), by_tier.get("full", 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
