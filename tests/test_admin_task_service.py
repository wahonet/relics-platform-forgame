from __future__ import annotations

from routers import admin_task_service


def test_build_db_alias_resolves_to_step07():
    assert admin_task_service.resolve_script("build_db") == "step07_build_db"


def test_registered_script_paths_include_sqlite_builder():
    script = admin_task_service.SCRIPTS["step07_build_db"]
    assert script.name == "step07_build_db.py"
    assert script.exists()

