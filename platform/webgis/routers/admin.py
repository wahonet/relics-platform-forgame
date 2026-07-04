"""管理后台 API。

覆盖管线脚本触发、任务查询、DOCX 上传/即时处理、分步进度与详情、
文物 CRUD / 审计 / 批量 / 导入导出等接口。所有路径均走 `_common.get_paths()`,
禁止硬编码。
"""
from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from _common import get_paths  # noqa: E402
from routers import admin_relic_routes, admin_task_service as task_service  # noqa: E402

router = APIRouter(prefix="/admin", tags=["管理"])
router.include_router(admin_relic_routes.router)

# 脚本注册表,同时接受 stepNN 完整名称与前端短别名。
SCRIPTS = task_service.SCRIPTS
SCRIPT_ALIAS = task_service.SCRIPT_ALIAS


def _resolve_script(name: str) -> str:
    """把短别名或 stepNN_xxx 解析为真实脚本键。"""
    if name in SCRIPTS or name in SCRIPT_ALIAS:
        return task_service.resolve_script(name)
    raise HTTPException(400, f"未知脚本: {name}")


# task_id -> {status, script, started, log[], returncode, finished?}
_tasks = task_service.tasks


# ── 文件统计工具 ────────────────────────────────────────────
def _count_files(d: Path, pattern: str = "*") -> int:
    if not d.exists():
        return 0
    return sum(1 for _ in d.rglob(pattern) if _.is_file())


def _count_docx(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(1 for f in d.rglob("*.docx") if not f.name.startswith("~$"))


def _mtime_str(p: Path) -> Optional[str]:
    if p.exists():
        return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    return None


def _count_csv_rows(p: Path) -> int:
    if not p.exists():
        return 0
    try:
        with p.open("r", encoding="utf-8-sig") as f:
            return sum(1 for _ in f) - 1
    except Exception:
        return 0


def _count_json_array(p: Path) -> int:
    if not p.exists():
        return 0
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return len(data) if isinstance(data, list) else 0
    except Exception:
        return 0


def _progress_pct(done: int, total: int) -> float:
    """进度百分比。total=0 且 done>0 视为 100%(demo / 归档场景)。"""
    if total <= 0:
        return 100.0 if done > 0 else 0.0
    return round(min(100.0, done / total * 100), 1)


def _count_geojson_features(p: Path) -> int:
    if not p.exists():
        return 0
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return len(data.get("features", []) or [])
    except Exception:
        return 0


def _last_task_for(script_name: str) -> Optional[dict]:
    """取该脚本最近一次任务,供管线卡片显示"最近运行时间"。"""
    return task_service.last_task_for(script_name)


def _township_dirs() -> list[str]:
    """01_archives/ 下的一级子目录名,视作乡镇。"""
    ap = get_paths().input_archives
    if not ap.exists():
        return []
    return sorted(d.name for d in ap.iterdir() if d.is_dir())


def _strip_ordinal(name: str) -> str:
    """去掉目录序号前缀:'01示范街道' → '示范街道'(与 step02 一致)。"""
    return re.sub(r"^[\d_\-\s]+", "", name) or name


# ── 基础状态 API(兼容旧前端) ─────────────────────────────
@router.get("/status")
async def pipeline_status():
    paths = get_paths()
    townships = _township_dirs()

    docx_count = _count_docx(paths.input_archives)
    md_count = _count_files(paths.output_markdown, "*.md")
    photo_count = _count_files(paths.output_photos)
    drawing_count = _count_files(paths.output_drawings)

    master_csv = paths.output_dataset / "relics_master.csv"
    relics_json = paths.output_dataset / "relics_full.json"

    return {
        "townships": townships,
        "docx_count": docx_count,
        "md_count": md_count,
        "photo_count": photo_count,
        "drawing_count": drawing_count,
        "csv_exists": master_csv.exists(),
        "json_exists": relics_json.exists(),
        "csv_mtime": _mtime_str(master_csv),
        "json_mtime": _mtime_str(relics_json),
        "tasks": {
            tid: {"status": t["status"], "script": t["script"], "started": t["started"]}
            for tid, t in _tasks.items()
        },
    }


@router.get("/townships")
async def list_townships():
    paths = get_paths()
    result = []
    for name in _township_dirs():
        inp = paths.input_archives / name
        out = paths.output_markdown / name
        docx_n = sum(1 for f in inp.glob("*.docx") if not f.name.startswith("~$"))
        md_n = sum(1 for _ in out.glob("*.md")) if out.exists() else 0
        result.append({"name": name, "docx_count": docx_n, "md_count": md_n})
    return result


# ── 新:整条管线分步状态 ─────────────────────────────────
@router.get("/pipeline")
async def pipeline_detailed():
    """六步管线逐步进度,供后台竖排流程图使用。

    每步字段:id / name / icon / desc / flow / input / output / progress /
    pending / runnable / last_run / artifact_mtime。
    """
    paths = get_paths()

    # step01: docx → md (按 archive_code 一一对应)
    docx_total = _count_docx(paths.input_archives)
    md_total = _count_files(paths.output_markdown, "*.md")
    step01 = {
        "id": "step01_convert_docs",
        "name": "文档结构化提取",
        "icon": "📄",
        "desc": "调用 AI 大模型把 .docx 四普档案规范化为 Markdown",
        "flow": "DOCX → Markdown",
        "input": {"total": docx_total, "label": "docx 档案"},
        "output": {"total": md_total, "label": "markdown 文件"},
        "pending": max(0, docx_total - md_total),
        # input 为空而 output 有产物(demo 预烘焙场景)视为 100%。
        "progress": _progress_pct(md_total, docx_total),
        "runnable": docx_total > 0,
        "last_run": _last_task_for("step01_convert_docs"),
        "artifact_mtime": _mtime_str(paths.output_markdown),
    }

    # step02: md → dataset (单次全量,csv 存在即视为 100%)
    master_csv = paths.output_dataset / "relics_master.csv"
    relics_json = paths.output_dataset / "relics_full.json"
    points_geo = paths.output_dataset / "relics_points.geojson"
    polygons_geo = paths.output_dataset / "relics_polygons.geojson"
    csv_rows = _count_csv_rows(master_csv)
    step02 = {
        "id": "step02_build_dataset",
        "name": "数据集生成",
        "icon": "📊",
        "desc": "汇总 Markdown → 结构化 CSV / JSON / GeoJSON,生成统计表与风险打分",
        "flow": "Markdown → Dataset",
        "input": {"total": md_total, "label": "markdown 文件"},
        "output": {
            "total": csv_rows,
            "label": "文物记录",
            "extra": {
                "relics_master.csv": csv_rows,
                "relics_points.geojson": _count_geojson_features(points_geo),
                "relics_polygons.geojson": _count_geojson_features(polygons_geo),
                "relics_full.json": _count_json_array(relics_json),
            },
        },
        "pending": max(0, md_total - csv_rows) if master_csv.exists() else md_total,
        "progress": round(csv_rows / md_total * 100, 1) if md_total else (100.0 if master_csv.exists() else 0.0),
        "runnable": md_total > 0,
        "last_run": _last_task_for("step02_build_dataset"),
        "artifact_mtime": _mtime_str(master_csv),
    }

    # step03: docx → photos (按 photo_index 覆盖的 archive_code 计完成)
    photo_index = paths.output_dataset / "photo_index.csv"
    photo_covered = _codes_in_index(photo_index)
    step03 = {
        "id": "step03_extract_photos",
        "name": "照片提取",
        "icon": "📷",
        "desc": "从 .docx 中按顺序抽取照片,生成 photo_index 供前端调取",
        "flow": "DOCX → 照片库",
        "input": {"total": docx_total, "label": "docx 档案"},
        "output": {
            "total": len(photo_covered),
            "label": "条档案已抽图",
            "extra": {"照片总数": _count_files(paths.output_photos)},
        },
        "pending": max(0, docx_total - len(photo_covered)),
        "progress": _progress_pct(len(photo_covered), docx_total),
        "runnable": docx_total > 0,
        "last_run": _last_task_for("step03_extract_photos"),
        "artifact_mtime": _mtime_str(photo_index),
    }

    # step04: docx → drawings
    drawing_index = paths.output_dataset / "drawing_index.csv"
    drawing_covered = _codes_in_index(drawing_index)
    step04 = {
        "id": "step04_extract_drawings",
        "name": "图纸提取",
        "icon": "📐",
        "desc": "从 .docx 中抽取图纸,生成 drawing_index 供前端调取",
        "flow": "DOCX → 图纸库",
        "input": {"total": docx_total, "label": "docx 档案"},
        "output": {
            "total": len(drawing_covered),
            "label": "条档案已抽图",
            "extra": {"图纸总数": _count_files(paths.output_drawings)},
        },
        "pending": max(0, docx_total - len(drawing_covered)),
        "progress": _progress_pct(len(drawing_covered), docx_total),
        "runnable": docx_total > 0,
        "last_run": _last_task_for("step04_extract_drawings"),
        "artifact_mtime": _mtime_str(drawing_index),
    }

    # step05: worklog xlsx → pdf (可选,无数据时跳过)
    worklog_xlsx = _count_files(paths.input_worklogs, "*.xlsx") + _count_files(paths.input_worklogs, "*.xls")
    worklog_pdf = _count_files(paths.output_worklogs, "*.pdf")
    step05 = {
        "id": "step05_convert_worklogs",
        "name": "工作日志转 PDF",
        "icon": "📋",
        "desc": "把外业日志 Excel 按天排版成 A4 PDF,供日志查看器嵌入",
        "flow": "Excel → PDF",
        "input": {"total": worklog_xlsx, "label": "日志表"},
        "output": {"total": worklog_pdf, "label": "日志 PDF"},
        "pending": max(0, worklog_xlsx - worklog_pdf),
        "progress": _progress_pct(worklog_pdf, worklog_xlsx),
        "runnable": worklog_xlsx > 0,
        "optional": True,
        "last_run": _last_task_for("step05_convert_worklogs"),
        "artifact_mtime": _mtime_str(paths.output_worklogs),
    }

    # step06: boundaries shp → geojson
    shp_total = _count_files(paths.input_boundaries, "*.shp") + _count_files(paths.input_boundaries, "*.geojson")
    b_county = paths.output_boundaries / "county.geojson"
    b_town = paths.output_boundaries / "townships.geojson"
    b_village = paths.output_boundaries / "villages.geojson"
    boundary_out = sum(1 for p in (b_county, b_town, b_village) if p.exists())
    step06 = {
        "id": "step06_prepare_boundaries",
        "name": "行政边界处理",
        "icon": "🗺️",
        "desc": "把 Shapefile / GeoJSON 反投影到 WGS-84,并切分成县/镇/村三级",
        "flow": "SHP → WGS-84 GeoJSON",
        "input": {"total": shp_total, "label": "shp/geojson 原始"},
        "output": {
            "total": boundary_out,
            "label": "边界层",
            "extra": {
                "county.geojson": _count_geojson_features(b_county),
                "townships.geojson": _count_geojson_features(b_town),
                "villages.geojson": _count_geojson_features(b_village),
            },
        },
        "pending": max(0, 3 - boundary_out),
        "progress": round(boundary_out / 3 * 100, 1),
        "runnable": shp_total > 0,
        "optional": True,
        "last_run": _last_task_for("step06_prepare_boundaries"),
        "artifact_mtime": _mtime_str(paths.output_boundaries),
    }

    db_file = paths.output_dataset / "relics.db"
    relics_json_count = _count_json_array(relics_json)
    step07 = {
        "id": "step07_build_db",
        "name": "SQLite DB Build",
        "icon": "DB",
        "desc": "Build relics.db from dataset artifacts for R-Tree, FTS5, audit log and Admin writes",
        "flow": "Dataset -> SQLite",
        "input": {"total": relics_json_count, "label": "relic JSON records"},
        "output": {
            "total": 1 if db_file.exists() else 0,
            "label": "relics.db",
            "extra": {
                "size_kb": round(db_file.stat().st_size / 1024, 1) if db_file.exists() else 0,
            },
        },
        "pending": 0 if db_file.exists() else (1 if relics_json_count > 0 else 0),
        "progress": 100.0 if db_file.exists() else 0.0,
        "runnable": relics_json.exists(),
        "optional": False,
        "last_run": _last_task_for("step07_build_db"),
        "artifact_mtime": _mtime_str(db_file),
    }

    return {
        "steps": [step01, step02, step03, step04, step05, step06, step07],
        "tasks": {
            tid: {
                "status": t["status"],
                "script": t["script"],
                "started": t["started"],
                "finished": t.get("finished"),
            }
            for tid, t in _tasks.items()
        },
    }


def _codes_in_index(index_csv: Path) -> set[str]:
    if not index_csv.exists():
        return set()
    codes: set[str] = set()
    try:
        with index_csv.open("r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                code = row.get("archive_code") or row.get("code") or ""
                if code:
                    codes.add(code.strip())
    except Exception:
        pass
    return codes


# ── 新:某一步的明细条目 ─────────────────────────────────
@router.get("/step/{step_id}/items")
async def step_items(step_id: str):
    """返回指定步骤的条目级详情,供前端"查看详情"折叠区使用。

    step01/03/04 按乡镇分组列出 docx 状态;
    step02 按 archive_code 列出生成状态;
    step05 按 Excel 文件列出转换状态;
    step06 按县/镇/村边界层列出产出状态。
    """
    step_id = _resolve_script(step_id)
    paths = get_paths()

    if step_id == "step01_convert_docs":
        return _items_step01(paths)
    if step_id == "step02_build_dataset":
        return _items_step02(paths)
    if step_id == "step03_extract_photos":
        return _items_docx_based(paths, index_name="photo_index.csv")
    if step_id == "step04_extract_drawings":
        return _items_docx_based(paths, index_name="drawing_index.csv")
    if step_id == "step05_convert_worklogs":
        return _items_step05(paths)
    if step_id == "step06_prepare_boundaries":
        return _items_step06(paths)
    if step_id == "step07_build_db":
        return _items_step07(paths)

    raise HTTPException(400, f"不支持查看 {step_id} 的详情")


def _items_step01(paths) -> dict:
    groups = []
    for twd in sorted(paths.input_archives.iterdir()) if paths.input_archives.exists() else []:
        if not twd.is_dir():
            continue
        township = _strip_ordinal(twd.name)
        out_dir = paths.output_markdown / twd.name
        if not out_dir.exists():
            out_dir_alt = paths.output_markdown / f"01{township}"
            if out_dir_alt.exists():
                out_dir = out_dir_alt
        md_names = {p.stem.split("_")[-1]: p for p in out_dir.glob("*.md")} if out_dir.exists() else {}
        md_by_full_stem = {p.stem: p for p in out_dir.glob("*.md")} if out_dir.exists() else {}
        items = []
        for docx in sorted(twd.glob("*.docx")):
            if docx.name.startswith("~$"):
                continue
            stem = docx.stem
            # md 命名形如 <archive_code>_<name>_<ts>.md 或 <stem>_*.md
            out_md = None
            for md in md_by_full_stem.values():
                if md.stem.startswith(stem) or stem in md.stem:
                    out_md = md
                    break
            done = out_md is not None
            items.append({
                "id": stem,
                "name": docx.name,
                "status": "done" if done else "pending",
                "input_size_kb": round(docx.stat().st_size / 1024, 1),
                "output": out_md.name if out_md else None,
                "output_size_kb": round(out_md.stat().st_size / 1024, 1) if out_md else 0,
                "output_mtime": _mtime_str(out_md) if out_md else None,
            })
        done_n = sum(1 for i in items if i["status"] == "done")
        groups.append({
            "name": township,
            "total": len(items),
            "done": done_n,
            "pending": len(items) - done_n,
            "items": items,
        })
    return {"step": "step01_convert_docs", "groups": groups}


def _items_step02(paths) -> dict:
    master_csv = paths.output_dataset / "relics_master.csv"
    if not master_csv.exists():
        return {"step": "step02_build_dataset", "groups": []}
    md_by_stem: dict[str, Path] = {}
    if paths.output_markdown.exists():
        for md in paths.output_markdown.rglob("*.md"):
            md_by_stem[md.stem] = md

    records: list[dict] = []
    with master_csv.open("r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            records.append(row)

    groups_map: dict[str, list[dict]] = {}
    for r in records:
        twp = r.get("township") or "未分类"
        groups_map.setdefault(twp, []).append({
            "id": r.get("archive_code", ""),
            "name": r.get("name", ""),
            "status": "done",
            "category": r.get("category_main", ""),
            "era_stats": r.get("era_stats", ""),
            "condition": r.get("condition_level", ""),
            "risk_score": r.get("risk_score", ""),
            "has_boundary": r.get("has_boundary", "") in ("True", "true", "1"),
            "source_file": r.get("source_file", ""),
        })

    groups = []
    for name, items in sorted(groups_map.items()):
        groups.append({
            "name": name,
            "total": len(items),
            "done": len(items),
            "pending": 0,
            "items": items,
        })
    return {"step": "step02_build_dataset", "groups": groups}


def _items_docx_based(paths, index_name: str) -> dict:
    """step03 / step04:按乡镇列出 docx 是否已被索引覆盖。"""
    covered = _codes_in_index(paths.output_dataset / index_name)
    groups = []
    for twd in sorted(paths.input_archives.iterdir()) if paths.input_archives.exists() else []:
        if not twd.is_dir():
            continue
        items = []
        for docx in sorted(twd.glob("*.docx")):
            if docx.name.startswith("~$"):
                continue
            # 档案编号形如 XXXXXX-XXXX。
            m = re.match(r"([\d]{6}-[\d\-A-Za-z]+)", docx.stem)
            code = m.group(1) if m else docx.stem
            done = code in covered
            items.append({
                "id": code,
                "name": docx.name,
                "status": "done" if done else "pending",
                "input_size_kb": round(docx.stat().st_size / 1024, 1),
            })
        done_n = sum(1 for i in items if i["status"] == "done")
        groups.append({
            "name": _strip_ordinal(twd.name),
            "total": len(items),
            "done": done_n,
            "pending": len(items) - done_n,
            "items": items,
        })
    return {"step": "input_docx", "groups": groups, "index_covered": len(covered)}


def _items_step05(paths) -> dict:
    in_dir = paths.input_worklogs
    out_dir = paths.output_worklogs
    items = []
    for xlsx in sorted(in_dir.rglob("*.xlsx")) if in_dir.exists() else []:
        if xlsx.name.startswith("~$"):
            continue
        m = re.search(r"(20\d{6})", xlsx.stem)
        date_key = m.group(1) if m else xlsx.stem
        pdf = out_dir / f"{date_key}.pdf"
        items.append({
            "id": date_key,
            "name": xlsx.name,
            "status": "done" if pdf.exists() else "pending",
            "output": pdf.name if pdf.exists() else None,
            "output_size_kb": round(pdf.stat().st_size / 1024, 1) if pdf.exists() else 0,
        })
    done_n = sum(1 for i in items if i["status"] == "done")
    return {
        "step": "step05_convert_worklogs",
        "groups": [{"name": "工作日志", "total": len(items), "done": done_n,
                    "pending": len(items) - done_n, "items": items}],
    }


def _items_step06(paths) -> dict:
    layers = [
        ("county", "县界", paths.output_boundaries / "county.geojson"),
        ("townships", "乡镇界", paths.output_boundaries / "townships.geojson"),
        ("villages", "村界", paths.output_boundaries / "villages.geojson"),
    ]
    items = []
    for key, label, path in layers:
        n = _count_geojson_features(path)
        items.append({
            "id": key,
            "name": label,
            "status": "done" if path.exists() else "pending",
            "feature_count": n,
            "output": path.name if path.exists() else None,
            "output_size_kb": round(path.stat().st_size / 1024, 1) if path.exists() else 0,
            "output_mtime": _mtime_str(path),
        })
    done_n = sum(1 for i in items if i["status"] == "done")
    return {
        "step": "step06_prepare_boundaries",
        "groups": [{"name": "行政边界层", "total": len(items), "done": done_n,
                    "pending": len(items) - done_n, "items": items}],
    }


# ── 任务执行 ────────────────────────────────────────────────
def _items_step07(paths) -> dict:
    relics_json = paths.output_dataset / "relics_full.json"
    db_file = paths.output_dataset / "relics.db"
    json_count = _count_json_array(relics_json)
    items = [
        {
            "id": "relics_full.json",
            "name": "relics_full.json",
            "status": "done" if relics_json.exists() else "pending",
            "feature_count": json_count,
            "output": relics_json.name if relics_json.exists() else None,
            "output_size_kb": round(relics_json.stat().st_size / 1024, 1) if relics_json.exists() else 0,
            "output_mtime": _mtime_str(relics_json),
        },
        {
            "id": "relics.db",
            "name": "relics.db",
            "status": "done" if db_file.exists() else "pending",
            "feature_count": json_count if db_file.exists() else 0,
            "output": db_file.name if db_file.exists() else None,
            "output_size_kb": round(db_file.stat().st_size / 1024, 1) if db_file.exists() else 0,
            "output_mtime": _mtime_str(db_file),
        },
    ]
    done_n = sum(1 for i in items if i["status"] == "done")
    return {
        "step": "step07_build_db",
        "groups": [{"name": "SQLite DB", "total": len(items), "done": done_n,
                    "pending": len(items) - done_n, "items": items}],
    }


@router.post("/run/{script_name}")
async def run_script(script_name: str):
    """后台异步执行脚本。支持短别名与 stepNN 完整名;同脚本并发时返回 409。"""
    return task_service.start_script_task(script_name)


@router.get("/task/{task_id}")
async def get_task(task_id: str):
    t = _tasks.get(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    return t


@router.get("/tasks")
async def list_tasks(limit: int = 30):
    """最近的任务历史(默认 30 条,含日志末行摘要)。"""
    items = []
    for tid, t in _tasks.items():
        items.append({
            "task_id": tid,
            "script": t["script"],
            "status": t["status"],
            "started": t["started"],
            "finished": t.get("finished"),
            "returncode": t.get("returncode"),
            "last_log": t.get("log", [])[-1] if t.get("log") else "",
        })
    items.sort(key=lambda x: x["started"], reverse=True)
    return items[:limit]


@router.post("/upload-single")
async def upload_single(
    file: UploadFile = File(...),
    township: str = Form(...),
):
    """单文件上传: data/input/01_archives/<township>/<filename>.docx。"""
    if not file.filename or not file.filename.endswith(".docx"):
        raise HTTPException(400, "仅支持 .docx 文件")

    target_dir = get_paths().input_archives / township
    if not target_dir.exists():
        raise HTTPException(400, f"乡镇文件夹不存在: {township}")

    dest = target_dir / file.filename
    content = await file.read()
    dest.write_bytes(content)

    return {
        "message": f"已保存到 {dest}",
        "township": township,
        "filename": file.filename,
        "size_kb": round(len(content) / 1024, 1),
    }


@router.post("/process-single")
async def process_single(
    file: UploadFile = File(...),
    township: str = Form(...),
):
    """上传 docx 并立即触发 step01。step01 会跳过已有的有效 md,重复触发安全。"""
    if not file.filename or not file.filename.endswith(".docx"):
        raise HTTPException(400, "仅支持 .docx 文件")

    target_dir = get_paths().input_archives / township
    if not target_dir.exists():
        raise HTTPException(400, f"乡镇文件夹不存在: {township}")

    dest = target_dir / file.filename
    content = await file.read()
    dest.write_bytes(content)

    task = task_service.start_script_task(
        "step01_convert_docs",
        initial_log=[f"Uploaded {file.filename} -> {township}"],
        extra_fields={"single_file": file.filename},
    )
    return {
        "task_id": task["task_id"],
        "message": f"Uploaded {file.filename} and started extraction",
        "township": township,
    }
