"""Data pipeline orchestrator.

Usage:
    python run_pipeline.py
    python run_pipeline.py --from 02
    python run_pipeline.py --to 04
    python run_pipeline.py --only 03
    python run_pipeline.py --skip 01 --skip 05
    python run_pipeline.py --list
    python run_pipeline.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from _common import PROJECT_ROOT, detect_features, get_logger, get_paths, load_config

SCRIPTS_DIR = Path(__file__).resolve().parent


STEPS = [
    {
        "id": "00",
        "name": "档案提取",
        "script": "step00_convert_docs.py",
        "requires": ["docs"],
        "optional": True,
    },
    {
        "id": "01",
        "name": "数据导入",
        "script": "step01_import_relics.py",
        "requires": ["relics_source"],
        "optional": False,
    },
    {
        "id": "02",
        "name": "边界处理",
        "script": "step02_prepare_boundaries.py",
        "requires": ["boundaries"],
        "optional": True,
    },
    {
        "id": "03",
        "name": "数据库构建",
        "script": "step03_build_db.py",
        "requires": [],
        "optional": False,
    },
]


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        return str(path)


def _artifact(label: str, path: Path, patterns: tuple[str, ...] = (), kind: str = "dir") -> dict:
    if kind == "file":
        exists = path.exists() and path.is_file() and path.stat().st_size > 0
        count = 1 if exists else 0
    else:
        if not path.exists():
            count = 0
        else:
            count = sum(
                1
                for pattern in patterns
                for item in path.rglob(pattern)
                if item.is_file()
            )
        exists = count > 0
    return {
        "label": label,
        "path": _rel(path),
        "kind": kind,
        "patterns": list(patterns),
        "exists": exists,
        "count": count,
    }


def _step_artifacts(step_id: str) -> dict:
    paths = get_paths()
    md_art = _artifact("Markdown 档案", paths.input_markdown, ("*.md",))
    xls_art = _artifact("台账表格", paths.input_relics, ("*.xlsx", "*.xls", "*.csv"))
    # step01 两种数据源二选一:优先展示已存在的那种,都缺时展示 markdown
    step01_input = md_art if (md_art["exists"] or not xls_art["exists"]) else xls_art
    return {
        "00": {
            "inputs": [_artifact("登记表 docx", paths.input_docs, ("*.docx",))],
            "outputs": [_artifact("Markdown 档案", paths.input_markdown, ("*.md",))],
        },
        "01": {
            "inputs": [step01_input],
            "outputs": [
                _artifact("标准数据集", paths.output_dataset / "relics_full.json", kind="file"),
                _artifact("照片索引", paths.output_dataset / "photo_index.csv", kind="file"),
            ],
        },
        "02": {
            "inputs": [_artifact("边界源数据", paths.input_boundaries, ("*.shp", "*.geojson", "*.json"))],
            "outputs": [_artifact("边界 GeoJSON", paths.output_boundaries, ("*.geojson", "*.json"))],
        },
        "03": {
            "inputs": [_artifact("标准数据集", paths.output_dataset / "relics_full.json", kind="file")],
            "outputs": [_artifact("relics.db", paths.output_dataset / "relics.db", kind="file")],
        },
    }.get(step_id, {"inputs": [], "outputs": []})


def _evaluate_step(step: dict, features: dict) -> dict:
    artifacts = _step_artifacts(step["id"])
    missing_features = [r for r in step["requires"] if not features.get(r, False)]
    missing_inputs = [item for item in artifacts["inputs"] if not item["exists"]]
    missing_outputs = [item for item in artifacts["outputs"] if not item["exists"]]
    return {
        "id": step["id"],
        "name": step["name"],
        "script": step["script"],
        "optional": step["optional"],
        "missing_features": missing_features,
        "inputs": artifacts["inputs"],
        "outputs": artifacts["outputs"],
        "missing_inputs": missing_inputs,
        "missing_outputs": missing_outputs,
    }


def _format_artifact(items: list[dict]) -> str:
    if not items:
        return "none"
    return "; ".join(
        f"{item['label']}={'ok' if item['exists'] else 'missing'}"
        f"({item['count']} @ {item['path']})"
        for item in items
    )


def _manifest_record(step: dict, status: str, started: float, finished: float,
                     features: dict, error: str | None = None) -> dict:
    evaluation = _evaluate_step(step, features)
    return {
        **evaluation,
        "status": status,
        "started": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
        "finished": datetime.fromtimestamp(finished).isoformat(timespec="seconds"),
        "duration_sec": round(finished - started, 3),
        "error": error,
    }


def _write_manifest(records: list[dict], status: str, selected: list[dict]) -> Path:
    paths = get_paths()
    paths.output_logs.mkdir(parents=True, exist_ok=True)
    manifest_path = paths.output_logs / "pipeline_manifest.json"
    payload = {
        "schema_version": 1,
        "status": status,
        "project_root": str(PROJECT_ROOT),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "selected_steps": [s["id"] for s in selected],
        "steps": records,
    }
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest_path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Relics Platform data pipeline")
    p.add_argument("--from", dest="from_id", default=None, help="Start step id, for example 02")
    p.add_argument("--to", dest="to_id", default=None, help="End step id, inclusive, for example 04")
    p.add_argument("--only", dest="only_id", default=None, help="Run only one step id, for example 03")
    p.add_argument("--skip", dest="skip_ids", action="append", default=[],
                   help="Skip a step id. Can be repeated, for example --skip 01 --skip 05")
    p.add_argument("--list", action="store_true", help="List all steps and exit")
    p.add_argument("--dry-run", action="store_true", help="Print planned steps without running them")
    return p.parse_args()


def _list_steps() -> None:
    print("Pipeline steps:")
    for s in STEPS:
        tag = "[optional]" if s["optional"] else "[required]"
        print(f"  {s['id']}  {tag}  {s['name']}  ({s['script']})")


def _select_steps(args: argparse.Namespace) -> list[dict]:
    skip = set(args.skip_ids or [])
    if args.only_id:
        return [s for s in STEPS if s["id"] == args.only_id and s["id"] not in skip]
    selected = STEPS[:]
    if args.from_id:
        selected = [s for s in selected if s["id"] >= args.from_id]
    if args.to_id:
        selected = [s for s in selected if s["id"] <= args.to_id]
    if skip:
        selected = [s for s in selected if s["id"] not in skip]
    return selected


def _run_step(step: dict, log) -> int:
    script_path = SCRIPTS_DIR / step["script"]
    if not script_path.exists():
        log.error("Script not found: %s", script_path)
        return 1
    log.info("-> start step%s: %s", step["id"], step["name"])
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        cwd=str(SCRIPTS_DIR),
    )
    dt = time.time() - t0
    if proc.returncode == 0:
        log.info("OK step%s completed in %.1fs", step["id"], dt)
    elif proc.returncode == 4:
        log.info("STOP step%s 被用户停止,耗时 %.1fs", step["id"], dt)
    else:
        log.error("FAIL step%s exited with %s in %.1fs", step["id"], proc.returncode, dt)
    return proc.returncode


def main() -> int:
    args = _parse_args()
    if args.list:
        _list_steps()
        return 0

    log = get_logger("pipeline")
    log.info("=" * 56)
    log.info("pipeline 启动 | argv: %s", " ".join(sys.argv[1:]) or "(全部步骤)")
    selected = _select_steps(args)

    if not selected:
        log.error("No matching steps")
        return 2

    if not args.dry_run:
        try:
            load_config()
        except FileNotFoundError as e:
            log.error(str(e))
            return 2

    features = detect_features().as_dict

    log.info("Project root: %s", PROJECT_ROOT)
    log.info("Input feature status: %s", features)
    log.info("Planned steps: %d", len(selected))

    manifest_records: list[dict] = []
    for step in selected:
        needs = step["requires"]
        missing = [r for r in needs if not features.get(r, False)]
        evaluation = _evaluate_step(step, features)

        if args.dry_run:
            io_status = (
                f"inputs: {_format_artifact(evaluation['inputs'])}; "
                f"outputs: {_format_artifact(evaluation['outputs'])}"
            )
            if missing and not step["optional"]:
                log.info("[dry-run] step%s: %s (would fail, missing %s; %s)",
                         step["id"], step["name"], missing, io_status)
            elif missing and step["optional"]:
                log.info("[dry-run] step%s: %s (would skip optional, missing %s; %s)",
                         step["id"], step["name"], missing, io_status)
            else:
                log.info("[dry-run] step%s: %s (%s)", step["id"], step["name"], io_status)
            continue

        if missing:
            started = finished = time.time()
            if step["optional"]:
                log.warning("Skip optional step%s, missing input: %s", step["id"], missing)
                manifest_records.append(_manifest_record(step, "skipped", started, finished, features,
                                                         error=f"missing input: {missing}"))
                continue
            log.error("step%s requires missing input: %s", step["id"], missing)
            manifest_records.append(_manifest_record(step, "error", started, finished, features,
                                                     error=f"missing input: {missing}"))
            manifest = _write_manifest(manifest_records, "error", selected)
            log.info("Pipeline manifest written: %s", manifest)
            return 3

        started = time.time()
        rc = _run_step(step, log)
        finished = time.time()
        if rc == 4:
            # step00 的用户主动停止(非错误):中止后续步骤,重跑即可续传
            log.info("用户停止了 step%s,管线中止(重跑即从断点续传)", step["id"])
            manifest_records.append(_manifest_record(step, "stopped", started, finished, features))
            manifest = _write_manifest(manifest_records, "stopped", selected)
            log.info("Pipeline manifest written: %s", manifest)
            return 4
        if rc != 0:
            log.error("Pipeline stopped at step%s", step["id"])
            manifest_records.append(_manifest_record(step, "error", started, finished, features,
                                                     error=f"returncode {rc}"))
            manifest = _write_manifest(manifest_records, "error", selected)
            log.info("Pipeline manifest written: %s", manifest)
            return rc
        manifest_records.append(_manifest_record(step, "done", started, finished, features))

    if args.dry_run:
        log.info("[dry-run] plan printed; no step was executed")
    else:
        manifest = _write_manifest(manifest_records, "done", selected)
        log.info("Pipeline manifest written: %s", manifest)
        log.info("All selected steps completed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
