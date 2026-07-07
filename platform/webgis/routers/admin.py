"""系统管理 API:可视化跑管线 + API Key 配置。

- GET  /api/admin/pipeline        管线各步骤输入/产物状态 + 上次运行清单
- POST /api/admin/pipeline/run    后台运行管线(可选 only=步骤号 / demo=生成演示数据)
- GET  /api/admin/pipeline/task   当前/上次任务状态与日志尾部
- POST /api/admin/data/clear      清除全部已生成数据(需输入确认口令)
- GET  /api/admin/config          外部 API key 配置状态(脱敏)
- PUT  /api/admin/config          写入 config.yaml 并热更新 AI / 高德服务

受 AuthMiddleware 保护(enable_auth 开启时需登录)。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from _common import CONFIG_PATH, PROJECT_ROOT, detect_features, get_paths, load_config
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


ADMIN_TASK_LOG_DIR = PROJECT_ROOT / "data" / "output" / "logs" / "admin_tasks"


def _reload_store() -> bool:
    """管线跑完后热重载数据集与 AI 上下文,不用重启服务。"""
    try:
        from _common import get_paths, load_config as _load_cfg
        from data_loader import store
        from routers import chat as _chat

        paths = get_paths()
        cfg = _load_cfg()
        b = (cfg.get("geo") or {}).get("bounds") or {}
        bbox = (
            b.get("west", -180.0), b.get("south", -90.0),
            b.get("east", 180.0), b.get("north", 90.0),
        )
        store.load(
            str(paths.output_dataset),
            archive_docs_dir=str(paths.input_archive_docs) if paths.input_archive_docs.exists() else "",
            bounds=bbox,
        )
        try:
            _chat.init_chat()
        except Exception:  # noqa: BLE001
            pass
        return True
    except Exception:  # noqa: BLE001
        return False


def _run_subprocess(task: dict, cmd: list[str]) -> None:
    """跑子进程并把输出同时写入内存(页面实时显示)与磁盘日志(完整留档)。"""
    log_fh = None
    try:
        ADMIN_TASK_LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        log_path = ADMIN_TASK_LOG_DIR / f"{stamp}_{task['id']}.log"
        task["log_file"] = str(log_path)
        log_fh = log_path.open("w", encoding="utf-8")
        log_fh.write(f"# {task.get('label', '')}\n# {' '.join(cmd)}\n"
                     f"# started {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        log_fh.flush()
    except OSError:
        log_fh = None

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
            stripped = line.rstrip("\n")
            task["log"].append(stripped)
            # 内存日志上限,避免无限增长;磁盘日志始终完整
            if len(task["log"]) > 2000:
                del task["log"][:500]
            if log_fh:
                try:
                    log_fh.write(stripped + "\n")
                    log_fh.flush()
                except OSError:
                    pass
        proc.wait()
        task["returncode"] = proc.returncode
        # 4 = step00 用户主动停止(非错误)
        task["status"] = ("done" if proc.returncode == 0
                          else "stopped" if proc.returncode == 4
                          else "error")
        if proc.returncode == 0:
            if _reload_store():
                task["log"].append("[admin] 数据集已热重载,前端刷新即可看到新数据")
                if log_fh:
                    log_fh.write("[admin] 数据集已热重载\n")
            else:
                task["log"].append("[admin] 热重载失败,请重启服务加载新数据")
    except Exception as e:  # noqa: BLE001
        task["log"].append(f"[admin] 任务异常: {e}")
        task["status"] = "error"
        task["returncode"] = -1
    finally:
        task["finished"] = time.time()
        if log_fh:
            try:
                log_fh.write(f"\n# finished {time.strftime('%Y-%m-%d %H:%M:%S')}"
                             f" exit={task['returncode']}\n")
                log_fh.close()
            except OSError:
                pass


def _run_dual_extract(task: dict, then_pipeline: bool) -> None:
    """双通道档案提取:step00 --channel a(SiliconFlow 正序)与
    --channel b(DeepSeek 官方倒序)两个子进程并行,日志按 [A]/[B] 前缀合并;
    两边都成功后可选继续跑剩余管线(--skip 00)。"""
    log_fh = None
    lock = threading.Lock()
    try:
        ADMIN_TASK_LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        log_path = ADMIN_TASK_LOG_DIR / f"{stamp}_{task['id']}.log"
        task["log_file"] = str(log_path)
        log_fh = log_path.open("w", encoding="utf-8")
        log_fh.write(f"# {task.get('label', '')}\n"
                     f"# started {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        log_fh.flush()
    except OSError:
        log_fh = None

    def emit(line: str) -> None:
        with lock:
            task["log"].append(line)
            if len(task["log"]) > 2000:
                del task["log"][:500]
            if log_fh:
                try:
                    log_fh.write(line + "\n")
                    log_fh.flush()
                except OSError:
                    pass

    def run_streamed(cmd: list[str], tag: str) -> int:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                emit(f"[{tag}] {line.rstrip()}" if tag else line.rstrip())
            proc.wait()
            return proc.returncode or 0
        except Exception as e:  # noqa: BLE001
            emit(f"[{tag}] 子进程异常: {e}")
            return -1

    try:
        step00 = str(SCRIPTS_DIR / "step00_convert_docs.py")
        results: dict[str, int] = {}

        def worker(channel: str, tag: str) -> None:
            results[tag] = run_streamed(
                [sys.executable, step00, "--channel", channel], tag)

        emit("[admin] 双通道提取启动: A=SiliconFlow(正序) B=DeepSeek官方(倒序)")
        ta = threading.Thread(target=worker, args=("a", "A"), daemon=True)
        tb = threading.Thread(target=worker, args=("b", "B"), daemon=True)
        ta.start(); tb.start()
        ta.join(); tb.join()

        rc_a, rc_b = results.get("A", -1), results.get("B", -1)
        emit(f"[admin] 通道结束: A exit={rc_a} / B exit={rc_b}")
        hard_fail = [rc for rc in (rc_a, rc_b) if rc not in (0, 4)]
        stopped = 4 in (rc_a, rc_b)

        if hard_fail and rc_a != 0 and rc_b != 0:
            # 两边都没正常完成且至少一边硬错误
            task["returncode"] = hard_fail[0]
            task["status"] = "error"
            return
        if stopped:
            task["returncode"] = 4
            task["status"] = "stopped"
            return
        if hard_fail:
            # 一边成功一边失败:提取未必完整,标记错误但提示可续传
            emit("[admin] 一个通道失败,已完成部分保留,重跑即续传")
            task["returncode"] = hard_fail[0]
            task["status"] = "error"
            return

        if then_pipeline:
            emit("[admin] 双通道提取完成,继续执行剩余管线(step01-03)...")
            rc = run_streamed(
                [sys.executable, str(SCRIPTS_DIR / "run_pipeline.py"), "--skip", "00"], "")
            task["returncode"] = rc
            task["status"] = "done" if rc == 0 else "error"
            if rc == 0 and _reload_store():
                emit("[admin] 数据集已热重载,前端刷新即可看到新数据")
        else:
            task["returncode"] = 0
            task["status"] = "done"
    except Exception as e:  # noqa: BLE001
        emit(f"[admin] 任务异常: {e}")
        task["status"] = "error"
        task["returncode"] = -1
    finally:
        task["finished"] = time.time()
        if log_fh:
            try:
                log_fh.write(f"\n# finished {time.strftime('%Y-%m-%d %H:%M:%S')}"
                             f" exit={task['returncode']}\n")
                log_fh.close()
            except OSError:
                pass


class RunBody(BaseModel):
    only: Optional[str] = None   # "01" / "02" / "03";None = 全部
    demo: bool = False           # True = 先生成演示数据
    dual: bool = False           # True = step00 双通道(SiliconFlow + DeepSeek 官方)


@router.post("/pipeline/run")
async def pipeline_run(body: RunBody):
    global _task
    with _task_lock:
        if _task and _task.get("status") == "running":
            raise HTTPException(409, "已有任务在运行,请等待完成")

        use_dual = bool(body.dual) and not body.demo and body.only in (None, "00")
        if use_dual:
            ds = ((load_config().get("api") or {}).get("deepseek") or {})
            ds_key = (ds.get("key") or "").strip()
            if not ds_key or (ds_key.startswith("${") and ds_key.endswith("}")):
                raise HTTPException(400, "未配置 DeepSeek API Key(api.deepseek.key),无法双通道提取")

        if body.demo:
            script = TOOLS_DIR / "generate_demo_data.py"
            if not script.exists():
                raise HTTPException(404, "演示数据生成器不存在")
            cmd = [sys.executable, str(script)]
            label = "生成演示数据"
        elif use_dual:
            cmd = None
            label = ("双通道档案提取" if body.only == "00"
                     else "双通道提取 + 剩余管线")
        else:
            cmd = [sys.executable, str(SCRIPTS_DIR / "run_pipeline.py")]
            label = "运行数据管线"
            if body.only:
                if body.only not in {s["id"] for s in _pipeline.STEPS}:
                    raise HTTPException(400, f"未知步骤: {body.only}")
                cmd += ["--only", body.only]
                label = f"运行 step{body.only}"

        # 启动即清掉遗留停止哨兵,并快照本次运行的模型与渠道(运行中换模型不影响本次)
        _STOP_FLAG.unlink(missing_ok=True)
        try:
            sf = ((load_config().get("api") or {}).get("siliconflow") or {})
        except Exception:  # noqa: BLE001
            sf = {}
        _task = {
            "id": int(time.time() * 1000),
            "label": label,
            "status": "running",
            "started": time.time(),
            "finished": None,
            "returncode": None,
            "model": sf.get("default_model", ""),
            "base_url": sf.get("base_url", "") or "https://api.siliconflow.cn/v1",
            "log": ([f"$ {' '.join(Path(c).name if '/' in c else c for c in cmd)}"]
                    if cmd else ["$ step00 --channel a & step00 --channel b"]),
        }
        if use_dual:
            threading.Thread(target=_run_dual_extract,
                             args=(_task, body.only is None), daemon=True).start()
        else:
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
        "model": _task.get("model", ""),
        "base_url": _task.get("base_url", ""),
        "log": _task["log"][-tail:],
        "log_file": _task.get("log_file", ""),
    }


# ── 清除全部数据 ─────────────────────────────────────────────
CLEAR_CONFIRM_PHRASE = "清除全部数据"


class ClearDataBody(BaseModel):
    confirm: str
    # 是否连同 data/input 原始资料(登记表 docx、Markdown 档案、台账、媒体、边界)一并清除
    include_input: bool = False


def _rmtree_contents(d: Path) -> tuple[bool, str]:
    """删除目录本身(含内容)并原样重建空目录。返回 (是否成功, 错误信息)。"""
    if not d.exists():
        d.mkdir(parents=True, exist_ok=True)
        return True, ""
    try:
        shutil.rmtree(d)
    except OSError as e:
        return False, str(e)
    d.mkdir(parents=True, exist_ok=True)
    return True, ""


@router.post("/data/clear")
async def clear_all_data(body: ClearDataBody):
    """清除全部已生成数据:数据集库(relics.db)、照片/图纸、边界、巡查库
    (patrol.db + 打卡照片)、管线日志与进度账本。离线地图瓦片缓存不在此列
    (在「离线地图下载」页单独管理)。

    必须提交 confirm=清除全部数据 才会执行;有任务运行时拒绝。
    """
    global _task
    if (body.confirm or "").strip() != CLEAR_CONFIRM_PHRASE:
        raise HTTPException(400, f"确认口令不正确,请输入「{CLEAR_CONFIRM_PHRASE}」")
    with _task_lock:
        if _task and _task.get("status") == "running":
            raise HTTPException(409, "有任务正在运行,请先等待完成或停止后再清除")

    from data_loader import store
    from services.patrol_service import patrol_db

    paths = get_paths()

    # 先关掉两个库的所有 SQLite 连接,否则 Windows 上文件被占用无法删除
    store.close_db()
    patrol_db.close()

    targets: list[tuple[str, Path]] = [
        ("数据集(relics.db / JSON / GeoJSON / 索引)", paths.output_dataset),
        ("照片", paths.output_photos),
        ("图纸", paths.output_drawings),
        ("行政边界产物", paths.output_boundaries),
        ("巡查库与打卡照片(patrol.db)", paths.output_patrol),
        ("管线日志与进度账本", paths.output_logs),
    ]
    if body.include_input:
        targets += [
            ("原始登记表 docx", paths.input_docs),
            ("台账 / Markdown 档案", paths.input_relics),
            ("原始照片图纸", paths.input_media),
            ("原始行政边界", paths.input_boundaries),
            ("普查档案 PDF", paths.input_archive_docs),
        ]

    removed: list[str] = []
    failed: list[dict] = []
    for label, d in targets:
        ok, err = _rmtree_contents(d)
        if ok:
            removed.append(label)
        else:
            failed.append({"label": label, "path": str(d), "error": err})

    # 重建目录骨架 + 热重载(store 变为空数据、AI 上下文重建、巡查库重建空表)
    from _common import ensure_data_dirs
    ensure_data_dirs()
    _reload_store()
    try:
        cfg = load_config()
        patrol_db.init(paths.output_patrol, (cfg.get("patrol") or {}).get("frequency_days"))
    except Exception:  # noqa: BLE001
        pass

    # 市界/县界是地图底子(市界发光 + 域外遮罩),不属于业务数据,
    # 从仓库 boundary/ 种子自动恢复,避免清除后地图一片黑。
    seeded: list[str] = []
    try:
        from services.boundary_seed import restore_seed_boundaries
        seeded = restore_seed_boundaries()
    except Exception:  # noqa: BLE001
        pass

    # 清除后上一次任务记录已无意义,重置为空闲
    with _task_lock:
        _task = {}

    return {
        "ok": not failed,
        "removed": removed,
        "failed": failed,
        "include_input": body.include_input,
        "seeded_boundaries": seeded,
        "message": ("已清除全部数据,可重新放入数据运行管线"
                    + ("(市界/县界底图已自动恢复)" if seeded else "")
                    if not failed else "部分目录清除失败,请查看 failed 明细"),
    }


# ── 档案提取的停止/进度 ─────────────────────────────────────
_STOP_FLAG = PROJECT_ROOT / "data" / "output" / "logs" / "step00.stop"

# docx 总数扫描较慢,缓存 30 秒
_docx_count_cache: dict = {"n": 0, "ts": 0.0}


def _count_docx() -> int:
    now = time.time()
    if now - _docx_count_cache["ts"] < 30:
        return _docx_count_cache["n"]
    paths = get_paths()
    n = 0
    if paths.input_docs.exists():
        n = sum(1 for p in paths.input_docs.rglob("*.docx") if not p.name.startswith("~$"))
    _docx_count_cache.update(n=n, ts=now)
    return n


@router.post("/pipeline/stop")
async def pipeline_stop():
    """停止档案提取:完成当前在途请求(至多并发数条)后优雅退出。
    进度已实时落盘,重跑即从断点续传;停止后可换模型,新运行采用新模型。"""
    _STOP_FLAG.parent.mkdir(parents=True, exist_ok=True)
    _STOP_FLAG.touch()
    cfg = load_config()
    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    return {"stopping": True, "inflight_max": _safe_concurrency(sf.get("extract_concurrency"))}


@router.get("/pipeline/extract-progress")
async def extract_progress():
    """档案提取总体进度:总数/已完成/失败/剩余(跨运行累计,按文件系统实况)。"""
    paths = get_paths()
    total = _count_docx()
    done = 0
    if paths.input_markdown.exists():
        done = sum(1 for _ in paths.input_markdown.rglob("*.md"))
    # 失败数合并两个通道的账本(双通道时 b 通道账本独立)
    failed_names: set[str] = set()
    for ledger_name in ("step00_progress.json", "step00_progress_b.json"):
        ledger = paths.output_logs / ledger_name
        if ledger.exists():
            try:
                data = json.loads(ledger.read_text(encoding="utf-8")) or {}
                failed_names.update((data.get("failed") or {}).keys())
                # 一个通道失败、另一个通道后来成功的,不算失败
                failed_names.difference_update(data.get("completed") or [])
            except Exception:  # noqa: BLE001
                pass
    failed = len(failed_names)
    cfg = load_config()
    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    return {
        "total": total,
        "done": min(done, total) if total else done,
        "failed": failed,
        "remaining": max(0, total - done),
        "stopping": _STOP_FLAG.exists(),
        "concurrency": _safe_concurrency(sf.get("extract_concurrency")),
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


def _safe_concurrency(value, default: int = 2) -> int:
    """档案提取并发数,钳制到 1-8。"""
    try:
        return max(1, min(int(value), 8))
    except (TypeError, ValueError):
        return default


@router.get("/config")
async def get_api_config():
    cfg = load_config()
    api = cfg.get("api") or {}
    sf = api.get("siliconflow") or {}
    ds = api.get("deepseek") or {}
    amap = api.get("amap") or {}
    ion = api.get("cesium_ion") or {}
    tdt = api.get("tianditu") or {}
    return {
        "siliconflow": {
            "configured": _configured(sf.get("key", "")),
            "masked": _mask(sf.get("key", "")),
            "base_url": sf.get("base_url", ""),
            "default_model": sf.get("default_model", ""),
            "extract_concurrency": _safe_concurrency(sf.get("extract_concurrency")),
        },
        "deepseek": {
            "configured": _configured(ds.get("key", "")),
            "masked": _mask(ds.get("key", "")),
            "base_url": ds.get("base_url", "") or "https://api.deepseek.com/v1",
            "default_model": ds.get("default_model", "") or "deepseek-chat",
            "extract_concurrency": _safe_concurrency(ds.get("extract_concurrency")),
        },
        "amap": {
            "configured": _configured(amap.get("web_key", "")),
            "masked": _mask(amap.get("web_key", "")),
        },
        "cesium_ion": {
            "configured": _configured(ion.get("token", "")),
            "masked": _mask(ion.get("token", "")),
        },
        "tianditu": {
            "configured": _configured(tdt.get("key", "")),
            "masked": _mask(tdt.get("key", "")),
        },
        "config_path": str(CONFIG_PATH),
        "runtime": {
            "ai_ready": ai_service.ready(),
            "amap_ready": amap_service.has_key(),
        },
    }


# 模型列表里排除非对话类模型(嵌入/重排/语音/图像/视频)
_NON_CHAT_KEYWORDS = (
    "embedding", "bge-", "rerank", "whisper", "sensevoice", "cosyvoice",
    "stable-diffusion", "flux", "kolors", "wan-ai", "tts", "voice", "video",
)


@router.get("/models")
async def list_ai_models(provider: str = "siliconflow"):
    """拉取账号可用的对话模型列表。

    provider=siliconflow(默认): 复用 AI 服务客户端,回退 config available_models
    provider=deepseek:          用 api.deepseek 配置临时建连,回退内置列表
    未配置 Key 或请求失败时均回退,保证管理页始终有可选项。
    """
    cfg = load_config()

    if provider == "deepseek":
        ds = (cfg.get("api") or {}).get("deepseek") or {}
        current = ds.get("default_model", "") or "deepseek-chat"
        fallback = [{"id": "deepseek-chat", "name": "deepseek-chat"},
                    {"id": "deepseek-reasoner", "name": "deepseek-reasoner"}]
        key = (ds.get("key") or "").strip()
        if not key or (key.startswith("${") and key.endswith("}")):
            return {"models": fallback, "current": current, "source": "config",
                    "error": "未配置 DeepSeek API Key"}
        try:
            import httpx
            from openai import OpenAI
            client = OpenAI(
                api_key=key,
                base_url=ds.get("base_url") or "https://api.deepseek.com/v1",
                http_client=httpx.Client(trust_env=False, timeout=30),
            )
            resp = await run_in_threadpool(client.models.list)
            ids = sorted({m.id for m in (resp.data or [])})
            models = [{"id": i, "name": i} for i in ids]
            if not models:
                return {"models": fallback, "current": current, "source": "config",
                        "error": "API 未返回可用模型"}
            return {"models": models, "current": current, "source": "api"}
        except Exception as e:  # noqa: BLE001
            return {"models": fallback, "current": current, "source": "config", "error": str(e)}

    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    current = sf.get("default_model", "")
    fallback = sf.get("available_models", []) or []

    client = ai_service.get_client()
    if client is None:
        return {"models": fallback, "current": current, "source": "config",
                "error": "未配置 SiliconFlow API Key"}
    try:
        resp = await run_in_threadpool(client.models.list)
        ids = sorted({m.id for m in (resp.data or [])})
        chat_ids = [
            i for i in ids
            if not any(kw in i.lower() for kw in _NON_CHAT_KEYWORDS)
        ]
        models = [{"id": i, "name": i} for i in chat_ids]
        if not models:
            return {"models": fallback, "current": current, "source": "config",
                    "error": "API 未返回可用对话模型"}
        return {"models": models, "current": current, "source": "api"}
    except Exception as e:  # noqa: BLE001
        return {"models": fallback, "current": current, "source": "config", "error": str(e)}


class ConfigBody(BaseModel):
    siliconflow_key: Optional[str] = None
    siliconflow_base_url: Optional[str] = None  # OpenAI 兼容 API 地址
    deepseek_key: Optional[str] = None          # DeepSeek 官方 API(提取第二通道)
    deepseek_base_url: Optional[str] = None
    deepseek_model: Optional[str] = None
    amap_web_key: Optional[str] = None
    cesium_ion_token: Optional[str] = None
    tianditu_key: Optional[str] = None
    default_model: Optional[str] = None
    extract_concurrency: Optional[int] = None  # step00 档案提取并发数 1-8


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


def _append_api_subsection(text: str, section: str, key: str, value: str) -> str:
    """旧版 config.yaml 缺少某 api 子段时,在 `api:` 块开头插入该子段。"""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if re.match(r"^api:\s*(#.*)?$", line):
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines[i + 1:i + 1] = [f"  {section}:", f'    {key}: "{escaped}"']
            return "\n".join(lines)
    raise ValueError("config.yaml 中找不到 api: 段")


def _insert_key_into_section(text: str, section: str, key: str, value: str) -> str:
    """section 存在但缺少 key 时,在 section 行下一行插入该 key。"""
    lines = text.split("\n")
    sec_re = re.compile(rf"^(\s*){re.escape(section)}:\s*(#.*)?$")
    for i, line in enumerate(lines):
        m = sec_re.match(line)
        if m:
            indent = " " * (len(m.group(1)) + 2)
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines[i + 1:i + 1] = [f'{indent}{key}: "{escaped}"']
            return "\n".join(lines)
    raise ValueError(f"config.yaml 中找不到 {section}: 段")


@router.put("/config")
async def save_api_config(body: ConfigBody):
    if not CONFIG_PATH.exists():
        raise HTTPException(404, f"未找到 {CONFIG_PATH},请先复制 config.example.yaml")

    text = CONFIG_PATH.read_text(encoding="utf-8")
    updates = [
        ("siliconflow", "key", body.siliconflow_key),
        ("siliconflow", "base_url", body.siliconflow_base_url),
        ("siliconflow", "default_model", body.default_model),
        ("siliconflow", "extract_concurrency",
         str(_safe_concurrency(body.extract_concurrency)) if body.extract_concurrency is not None else None),
        ("deepseek", "key", body.deepseek_key),
        ("deepseek", "base_url", body.deepseek_base_url),
        ("deepseek", "default_model", body.deepseek_model),
        ("amap", "web_key", body.amap_web_key),
        ("cesium_ion", "token", body.cesium_ion_token),
        ("tianditu", "key", body.tianditu_key),
    ]
    changed = False
    for section, key, value in updates:
        if value is None or not value.strip():
            continue  # 留空表示不修改
        try:
            text = _replace_yaml_scalar(text, section, key, value.strip())
            changed = True
        except ValueError as e:
            err = str(e)
            try:
                if f"中找不到 {section}:" in err:
                    text = _append_api_subsection(text, section, key, value.strip())
                elif f"段内找不到 {key}:" in err:
                    text = _insert_key_into_section(text, section, key, value.strip())
                else:
                    raise HTTPException(400, err) from e
                changed = True
            except ValueError as e2:
                raise HTTPException(400, str(e2)) from e2

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
