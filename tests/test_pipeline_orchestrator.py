from __future__ import annotations

import sys
from types import SimpleNamespace

import run_pipeline


def test_pipeline_includes_sqlite_build_step():
    ids = [step["id"] for step in run_pipeline.STEPS]
    assert ids == ["01", "02", "03"]
    assert run_pipeline.STEPS[-1]["script"] == "step03_build_db.py"


def test_select_steps_supports_skip():
    args = SimpleNamespace(only_id=None, from_id=None, to_id=None, skip_ids=["02"])
    selected = run_pipeline._select_steps(args)
    assert [step["id"] for step in selected] == ["01", "03"]


def test_select_steps_supports_range_and_skip():
    args = SimpleNamespace(only_id=None, from_id="02", to_id="03", skip_ids=["02"])
    selected = run_pipeline._select_steps(args)
    assert [step["id"] for step in selected] == ["03"]


def test_dry_run_does_not_require_config(monkeypatch):
    class DummyLogger:
        def info(self, *args, **kwargs):
            pass

        def error(self, *args, **kwargs):
            pass

    def fail_load_config():
        raise AssertionError("dry-run should not load config.yaml")

    monkeypatch.setattr(run_pipeline, "get_logger", lambda _name: DummyLogger())
    monkeypatch.setattr(run_pipeline, "load_config", fail_load_config)
    monkeypatch.setattr(
        run_pipeline,
        "detect_features",
        lambda: SimpleNamespace(
            as_dict={
                "relics_source": False,
                "archive_docs": False,
                "boundaries": False,
                "dem": False,
            }
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["run_pipeline.py", "--dry-run", "--skip", "02"],
    )

    assert run_pipeline.main() == 0
