from __future__ import annotations

import json
from types import SimpleNamespace

import run_pipeline


def _fake_paths(root):
    return SimpleNamespace(
        input_relics=root / "data" / "input" / "01_relics",
        input_media=root / "data" / "input" / "02_media",
        input_boundaries=root / "data" / "input" / "03_boundaries",
        input_dem=root / "data" / "input" / "04_dem",
        input_models_3d=root / "data" / "input" / "05_models_3d",
        input_archive_docs=root / "data" / "input" / "06_archive_docs",
        output_dataset=root / "data" / "output" / "dataset",
        output_photos=root / "data" / "output" / "photos",
        output_drawings=root / "data" / "output" / "drawings",
        output_boundaries=root / "data" / "output" / "boundaries",
        output_patrol=root / "data" / "output" / "patrol",
        output_logs=root / "data" / "output" / "logs",
    )


def test_step_evaluation_reports_inputs_and_outputs(tmp_path, monkeypatch):
    paths = _fake_paths(tmp_path)
    paths.input_relics.mkdir(parents=True)
    paths.output_dataset.mkdir(parents=True)
    (paths.input_relics / "relics.csv").write_text("编号,名称", encoding="utf-8")

    monkeypatch.setattr(run_pipeline, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(run_pipeline, "get_paths", lambda: paths)

    step = next(s for s in run_pipeline.STEPS if s["id"] == "01")
    result = run_pipeline._evaluate_step(step, features={})

    assert result["inputs"][0]["exists"] is True
    assert result["inputs"][0]["count"] == 1
    assert result["outputs"][0]["exists"] is False
    assert result["missing_outputs"][0]["label"] == "relics_full.json"


def test_manifest_writer_records_selected_steps(tmp_path, monkeypatch):
    paths = _fake_paths(tmp_path)
    monkeypatch.setattr(run_pipeline, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(run_pipeline, "get_paths", lambda: paths)

    selected = [run_pipeline.STEPS[0]]
    manifest_path = run_pipeline._write_manifest(
        [{"id": "01", "status": "done"}],
        "done",
        selected,
    )

    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["status"] == "done"
    assert payload["selected_steps"] == ["01"]
    assert payload["steps"] == [{"id": "01", "status": "done"}]
