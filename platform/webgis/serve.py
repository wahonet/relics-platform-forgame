"""WebGIS 启动入口。

由 `start-backend.bat` 调用:读取 config.yaml 拿 host/port,然后起 uvicorn,
避免在 .bat 脚本里解析 YAML。
"""
from __future__ import annotations

import sys
import threading
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from _common import load_config  # noqa: E402


def _open_browser_delayed(url: str, delay: float = 2.0) -> None:
    """延迟打开浏览器,等 uvicorn 绑定端口成功后再访问。"""
    def _worker() -> None:
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass
    t = threading.Thread(target=_worker, daemon=True)
    t.start()


def main() -> int:
    try:
        cfg = load_config()
    except FileNotFoundError as e:
        print(f"[错误] {e}", file=sys.stderr)
        return 2

    srv = cfg.get("server", {}) or {}
    host = str(srv.get("host", "127.0.0.1"))
    port = int(srv.get("port", 8000))

    proj = cfg.get("project", {}) or {}
    name = proj.get("full_name") or proj.get("name") or "Relics Platform"

    print("=" * 52)
    print(f"  {name}")
    print("=" * 52)
    browser_url = f"http://127.0.0.1:{port}" if host == "0.0.0.0" \
        else f"http://{host}:{port}"
    print(f"  平台地址: {browser_url}")
    print("  关闭本窗口即可停止服务")
    print("=" * 52)
    print()

    _open_browser_delayed(browser_url, delay=2.0)

    import uvicorn
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        app_dir=str(HERE),
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
