"""系统管理 API:可视化跑管线 + API Key 配置。

- GET  /api/admin/pipeline        管线各步骤输入/产物状态 + 上次运行清单
- POST /api/admin/pipeline/run    后台运行管线(可选 only=步骤号 / demo=生成演示数据)
- GET  /api/admin/pipeline/task   当前/上次任务状态与日志尾部
- GET  /api/admin/config          外部 API key 配置状态(脱敏)
- PUT  /api/admin/config          写入 config.yaml 并热更新 AI / 高德服务

受 AuthMiddleware 保护(enable_auth 开启时需登录)。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from _common import CONFIG_PATH, PROJECT_ROOT, detect_features, load_config
import run_pipeline as _pipeline
from services import ai_service, amap_service

router = APIRouter(prefix="/admin", tags=["系统管理"])

SCRIPTS_DIR = PROJECT_ROOT / "platform" / "scripts"
TOOLS_DIR = PROJECT_ROOT / "platform" / "tools"

# main.py 注册的回调:保存配置后刷新其模块级 _CONFIG。
_on_config_saved = None


def init_admin(on_config_saved=None) -> None:
    global _on_config_saved
    _on_config_saved = on_config_saved


# ── 管线状态 ────────────────────────────────────────────────
@router.get("/pipeline")
async def pipeline_status():
    features = detect_features().as_dict
    steps = [_pipeline._evaluate_step(s, features) for s in _pipeline.STEPS]

    manifest = None
    manifest_path = PROJECT_ROOT / "data" / "output" / "logs" / "pipeline_manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            manifest = None

    return {"features": features, "steps": steps, "last_manifest": manifest}


# ── 任务运行(单并发) ────────────────────────────────────────
_task_lock = threading.Lock()
_task: dict = {}  # id/label/status/started/finished/returncode/log


def _run_subprocess(task: dict, cmd: list[str]) -> None:
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            task["log"].append(line.rstrip("\n"))
            # 日志上限,避免内存无限增长
            if len(task["log"]) > 2000:
                del task["log"][:500]
        proc.wait()
        task["returncode"] = proc.returncode
        task["status"] = "done" if proc.returncode == 0 else "error"
    except Exception as e:  # noqa: BLE001
        task["log"].append(f"[admin] 任务异常: {e}")
        task["status"] = "error"
        task["returncode"] = -1
    finally:
        task["finished"] = time.time()


class RunBody(BaseModel):
    only: Optional[str] = None   # "01" / "02" / "03";None = 全部
    demo: bool = False           # True = 先生成演示数据


@router.post("/pipeline/run")
async def pipeline_run(body: RunBody):
    global _task
    with _task_lock:
        if _task and _task.get("status") == "running":
            raise HTTPException(409, "已有任务在运行,请等待完成")

        if body.demo:
            script = TOOLS_DIR / "generate_demo_data.py"
            if not script.exists():
                raise HTTPException(404, "演示数据生成器不存在")
            cmd = [sys.executable, str(script)]
            label = "生成演示数据"
        else:
            cmd = [sys.executable, str(SCRIPTS_DIR / "run_pipeline.py")]
            label = "运行数据管线"
            if body.only:
                if body.only not in {s["id"] for s in _pipeline.STEPS}:
                    raise HTTPException(400, f"未知步骤: {body.only}")
                cmd += ["--only", body.only]
                label = f"运行 step{body.only}"

        _task = {
            "id": int(time.time() * 1000),
            "label": label,
            "status": "running",
            "started": time.time(),
            "finished": None,
            "returncode": None,
            "log": [f"$ {' '.join(Path(c).name if '/' in c else c for c in cmd)}"],
        }
        threading.Thread(target=_run_subprocess, args=(_task, cmd), daemon=True).start()
    return {"id": _task["id"], "label": label, "status": "running"}


@router.get("/pipeline/task")
async def pipeline_task(tail: int = 200):
    if not _task:
        return {"status": "idle"}
    return {
        "id": _task["id"],
        "label": _task["label"],
        "status": _task["status"],
        "started": _task["started"],
        "finished": _task["finished"],
        "returncode": _task["returncode"],
        "log": _task["log"][-tail:],
    }


# ── API Key 配置 ────────────────────────────────────────────
def _mask(value: str) -> str:
    v = (value or "").strip()
    if not v or (v.startswith("${") and v.endswith("}")):
        return ""
    if len(v) <= 8:
        return "*" * len(v)
    return f"{v[:3]}{'*' * 6}{v[-4:]}"


def _configured(value: str) -> bool:
    v = (value or "").strip()
    return bool(v) and not (v.startswith("${") and v.endswith("}"))


@router.get("/config")
async def get_api_config():
    cfg = load_config()
    api = cfg.get("api") or {}
    sf = api.get("siliconflow") or {}
    amap = api.get("amap") or {}
    ion = api.get("cesium_ion") or {}
    return {
        "siliconflow": {
            "configured": _configured(sf.get("key", "")),
            "masked": _mask(sf.get("key", "")),
            "base_url": sf.get("base_url", ""),
            "default_model": sf.get("default_model", ""),
        },
        "amap": {
            "configured": _configured(amap.get("web_key", "")),
            "masked": _mask(amap.get("web_key", "")),
        },
        "cesium_ion": {
            "configured": _configured(ion.get("token", "")),
            "masked": _mask(ion.get("token", "")),
        },
        "config_path": str(CONFIG_PATH),
        "runtime": {
            "ai_ready": ai_service.ready(),
            "amap_ready": amap_service.has_key(),
        },
    }


class ConfigBody(BaseModel):
    siliconflow_key: Optional[str] = None
    amap_web_key: Optional[str] = None
    cesium_ion_token: Optional[str] = None


def _replace_yaml_scalar(text: str, section: str, key: str, value: str) -> str:
    """在 `section:` 块内把 `key:` 的值替换为带引号的 value,保留注释与格式。

    仅依赖缩进定位:找到 section 行后,在其子层级(缩进更深)内匹配第一个 key 行,
    遇到缩进回退(离开该块)即停止。config.yaml 中三个目标 section 均唯一。
    """
    lines = text.split("\n")
    sec_re = re.compile(rf"^(\s*){re.escape(section)}:\s*(#.*)?$")
    sec_idx = sec_indent = None
    for i, line in enumerate(lines):
        m = sec_re.match(line)
        if m:
            sec_idx, sec_indent = i, len(m.group(1))
            break
    if sec_idx is None:
        raise ValueError(f"config.yaml 中找不到 {section}: 段")

    key_re = re.compile(rf"^(\s*){re.escape(key)}:\s*(.*)$")
    for i in range(sec_idx + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            indent = len(line) - len(line.lstrip())
            if indent <= sec_indent:
                break  # 已离开 section 块
            m = key_re.match(line)
            if m and len(m.group(1)) > sec_indent:
                # 保留行尾注释
                rest = m.group(2)
                comment = ""
                cm = re.search(r"\s+#.*$", rest)
                if cm:
                    comment = cm.group(0)
                escaped = value.replace("\\", "\\\\").replace('"', '\\"')
                lines[i] = f'{m.group(1)}{key}: "{escaped}"{comment}'
                return "\n".join(lines)
    raise ValueError(f"config.yaml 的 {section}: 段内找不到 {key}:")


@router.put("/config")
async def save_api_config(body: ConfigBody):
    if not CONFIG_PATH.exists():
        raise HTTPException(404, f"未找到 {CONFIG_PATH},请先复制 config.example.yaml")

    text = CONFIG_PATH.read_text(encoding="utf-8")
    updates = [
        ("siliconflow", "key", body.siliconflow_key),
        ("amap", "web_key", body.amap_web_key),
        ("cesium_ion", "token", body.cesium_ion_token),
    ]
    changed = False
    for section, key, value in updates:
        if value is None or not value.strip():
            continue  # 留空表示不修改
        try:
            text = _replace_yaml_scalar(text, section, key, value.strip())
            changed = True
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    if not changed:
        return {"ok": True, "changed": False, "message": "没有需要保存的修改"}

    CONFIG_PATH.write_text(text, encoding="utf-8")

    # 热更新:AI 客户端与高德 key 立即生效,无需重启
    cfg = load_config()
    ai_service.init(cfg)
    amap_service.init(((cfg.get("api") or {}).get("amap") or {}).get("web_key", ""))
    if _on_config_saved:
        try:
            _on_config_saved(cfg)
        except Exception:  # noqa: BLE001
            pass

    return {
        "ok": True,
        "changed": True,
        "runtime": {"ai_ready": ai_service.ready(), "amap_ready": amap_service.has_key()},
        "message": "已保存并生效(Cesium Ion token 需刷新页面)",
    }
