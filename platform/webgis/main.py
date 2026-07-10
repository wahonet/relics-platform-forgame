"""FastAPI application entrypoint for the Relics Data-Element Platform.

组合根:
- lifespan 中加载 config 与数据集、初始化 AI / 高德 / 巡查业务库
- 注册 API 路由(文物、统计、AI 问答、巡查、数据目录、边界、坐标系)
- 注册地形 / 瓦片路由,挂载静态资源与前端构建产物
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, unquote

PLATFORM_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLATFORM_ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402

from _common import PROJECT_ROOT, detect_features, get_paths, load_config  # noqa: E402
import crs as _crs_lib  # noqa: E402
from data_loader import store  # noqa: E402
from routers import admin as _admin, boundaries as _boundaries, chat, crs as _crs, parcels as _parcels, patrol, relics, stats, weather  # noqa: E402
from services import ai_service  # noqa: E402
from tile_routes import TILE_CACHE_DIR, register_tile_routes  # noqa: E402

_CONFIG: dict = {}
_FEATURES: dict = {}
_PATHS = get_paths()

WEBGIS_DIR = Path(__file__).resolve().parent
STATIC_DIR = WEBGIS_DIR / "static"

_WEBGIS_REACT_DIST = PROJECT_ROOT / "platform" / "webgis-react" / "dist"


def _feature_enabled(cfg_key: str, auto_value: bool) -> bool:
    value = (_CONFIG.get("features") or {}).get(cfg_key, "auto")
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ("true", "yes", "on"):
        return True
    if isinstance(value, str) and value.lower() in ("false", "no", "off"):
        return False
    return bool(auto_value)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _CONFIG, _FEATURES
    _CONFIG = load_config()
    _FEATURES = detect_features().as_dict

    try:
        hp = ((_CONFIG.get("geo") or {}).get("cgcs2000") or {}).get("helmert_params")
        if hp:
            _crs_lib.set_helmert_params(hp)
            print(f"[startup] CGCS2000 Helmert params enabled: {hp}")
        else:
            print("[startup] CGCS2000 -> WGS84 uses identity approximation")
    except Exception as e:
        print(f"[startup] Helmert param setup failed, fallback to identity: {e}")

    geo = _CONFIG.get("geo") or {}
    bounds = geo.get("bounds") or {}
    bbox = (
        bounds.get("west", -180.0),
        bounds.get("south", -90.0),
        bounds.get("east", 180.0),
        bounds.get("north", 90.0),
    )

    store.load(
        str(_PATHS.output_dataset),
        archive_docs_dir=str(_PATHS.input_archive_docs) if _PATHS.input_archive_docs.exists() else "",
        bounds=bbox,
    )

    print(f"[startup] relic records: {len(store.relics)}")
    print(f"[startup] photo index: {len(store.photo_index)}")
    print(f"[startup] drawing index: {len(store.drawing_index)}")
    print(f"[startup] archive docs: {len(store.archive_map)}")

    cached = sum(1 for _ in TILE_CACHE_DIR.rglob("*.tile"))
    print(f"[startup] tile cache: {cached} -> {TILE_CACHE_DIR}")

    # 市界/县界底图缺失时(如数据被清除后),从仓库 boundary/ 种子自动恢复
    try:
        if not (_PATHS.output_boundaries / "city.geojson").exists():
            from services.boundary_seed import restore_seed_boundaries
            seeded = restore_seed_boundaries()
            if seeded:
                print(f"[startup] 边界底图已从种子恢复: {', '.join(seeded)}")
    except Exception as e:  # noqa: BLE001
        print(f"[startup] 边界种子恢复失败: {e}")

    ai_service.init(_CONFIG)
    patrol.init_patrol(_CONFIG, _PATHS)

    def _on_config_saved(new_cfg: dict) -> None:
        """管理页保存 API key 后刷新全局配置(AI/高德已由 admin 路由热更新)。"""
        global _CONFIG
        _CONFIG = new_cfg

    _admin.init_admin(on_config_saved=_on_config_saved)

    try:
        chat.init_chat()
    except Exception as e:
        print(f"[AI] init failed: {e}")

    yield


app = FastAPI(title="Relics Data-Element Platform", version="2.0.0", lifespan=lifespan)

# 免鉴权路径。以 "/" 结尾的按前缀匹配,否则要求整段相等
# (避免 startswith 把 /loginxxx 这类同前缀路径误放行)。
_PUBLIC_PATHS = (
    "/login",
    "/api/login",
    "/static/",
    "/tiles/",
    "/api/platform/config",
    "/app/",
    "/m/",          # 移动端巡查 H5(凭路线 token 访问)
    "/api/m/",
    "/patrol-photos/",
    "/photos/",
)


def _is_public_path(path: str) -> bool:
    for p in _PUBLIC_PATHS:
        if p.endswith("/"):
            if path == p or path == p.rstrip("/") or path.startswith(p):
                return True
        elif path == p:
            return True
    return False


# ── 会话 cookie:HMAC 签名 + 过期时间,不可伪造 ─────────────────
_SESSION_TTL_SECONDS = 7 * 24 * 3600
_SESSION_SECRET: str = ""


def _session_secret() -> str:
    """签名密钥。优先 config server.session_secret;否则生成并持久化,
    避免重启后所有会话失效。"""
    global _SESSION_SECRET
    if _SESSION_SECRET:
        return _SESSION_SECRET
    cfg_secret = str((_CONFIG.get("server") or {}).get("session_secret") or "").strip()
    if cfg_secret:
        _SESSION_SECRET = cfg_secret
        return _SESSION_SECRET
    secret_file = _PATHS.output_dataset.parent / ".session_secret"
    try:
        if secret_file.exists():
            saved = secret_file.read_text(encoding="utf-8").strip()
            if saved:
                _SESSION_SECRET = saved
                return _SESSION_SECRET
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        _SESSION_SECRET = secrets.token_hex(32)
        secret_file.write_text(_SESSION_SECRET, encoding="utf-8")
    except OSError:
        # 文件不可写时退回进程内随机密钥(重启后会话失效,但仍然安全)。
        _SESSION_SECRET = secrets.token_hex(32)
    return _SESSION_SECRET


def _sign_session(username: str, expires_at: int) -> str:
    payload = f"{quote(username, safe='')}.{expires_at}"
    sig = hmac.new(
        _session_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{payload}.{sig}"


def _verify_session(cookie: str | None) -> str | None:
    """校验签名与过期时间,合法返回用户名,否则 None。"""
    if not cookie:
        return None
    parts = cookie.rsplit(".", 2)
    if len(parts) != 3:
        return None
    username_q, expires_s, sig = parts
    payload = f"{username_q}.{expires_s}"
    expect = hmac.new(
        _session_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        if int(expires_s) < time.time():
            return None
    except ValueError:
        return None
    return unquote(username_q)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not (_CONFIG.get("server") or {}).get("enable_auth", False):
            return await call_next(request)
        path = request.url.path
        if _is_public_path(path):
            return await call_next(request)
        if _verify_session(request.cookies.get("session")) is None:
            target = path
            if request.url.query:
                target = f"{path}?{request.url.query}"
            login_url = f"/login?next={quote(target, safe='/?&=#')}"
            return RedirectResponse(url=login_url, status_code=302)
        return await call_next(request)


app.add_middleware(AuthMiddleware)
# 生产环境前端由本服务同源托管(/app/),CORS 只需放行本地开发端口。
# 注意: allow_origins=["*"] 与 allow_credentials=True 组合违反 CORS 规范。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(relics.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(weather.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(patrol.router, prefix="/api")
app.include_router(patrol.mobile_router)          # /m/r/{token} 与 /api/m/*
app.include_router(_boundaries.router, prefix="/api")
app.include_router(_crs.router, prefix="/api")
app.include_router(_admin.router, prefix="/api")
app.include_router(_parcels.router, prefix="/api")

register_tile_routes(app, get_config=lambda: _CONFIG)


@app.get("/api/platform/config")
async def platform_config() -> JSONResponse:
    cfg = _CONFIG or {}
    proj = cfg.get("project", {}) or {}
    geo = cfg.get("geo", {}) or {}
    admin_cfg = cfg.get("administrative", {}) or {}
    api_cfg = cfg.get("api", {}) or {}

    def _resolved(val: str) -> str:
        if not val or (isinstance(val, str) and val.startswith("${") and val.endswith("}")):
            return ""
        return val

    cesium_token = _resolved((api_cfg.get("cesium_ion") or {}).get("token", ""))
    sf = api_cfg.get("siliconflow") or {}
    amap = api_cfg.get("amap") or {}
    tianditu = api_cfg.get("tianditu") or {}

    features_resolved = {
        "ai_chat": _feature_enabled("enable_ai_chat", bool(_resolved(sf.get("key", "")))),
        "models_3d": _feature_enabled("enable_3d_model", _FEATURES.get("models_3d", False)),
        "patrol": True,
        "amap_route": bool(_resolved(amap.get("web_key", ""))),
        "tianditu": bool(_resolved(tianditu.get("key", ""))),
    }

    n_full = sum(1 for r in store.relics if (r.get("tier") or "city") == "full")

    return JSONResponse({
        "project": {
            "name": proj.get("name", ""),
            "full_name": proj.get("full_name", ""),
            "data_cutoff": proj.get("data_cutoff", ""),
            "data_source": proj.get("data_source", ""),
        },
        "geo": geo,
        "administrative": {
            "county_name": admin_cfg.get("county_name", ""),
            "counties": admin_cfg.get("counties", []),
            "townships": admin_cfg.get("townships", []),
            "full_tier_county": admin_cfg.get("full_tier_county", ""),
        },
        "features": features_resolved,
        "cesium_ion_token": cesium_token,
        "ai_chat": {
            "enabled": features_resolved["ai_chat"],
            "default_model": sf.get("default_model", ""),
            "available_models": sf.get("available_models", []),
        },
        "stats": {
            "relics_total": len(store.relics),
            "full_tier_total": n_full,
            "has_3d_count": sum(1 for r in store.relics if r.get("has_3d")),
        },
        "auth": {
            "enabled": bool((cfg.get("server") or {}).get("enable_auth", False)),
        },
    })


@app.get("/api/config")
async def legacy_config() -> JSONResponse:
    return await platform_config()


def _mount_if_exists(path_prefix: str, directory: Path, name: str, *, create: bool = False) -> None:
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    if directory.exists():
        app.mount(path_prefix, StaticFiles(directory=str(directory)), name=name)
    else:
        print(f"[warning] skip mount {path_prefix}: {directory} does not exist")


_mount_if_exists("/photos", _PATHS.output_photos, "photos", create=True)
_mount_if_exists("/drawings", _PATHS.output_drawings, "drawings", create=True)
_mount_if_exists("/boundaries", _PATHS.output_boundaries, "boundaries", create=True)
_mount_if_exists("/3d", _PATHS.input_models_3d, "3d_models", create=True)
_mount_if_exists("/archive-docs", _PATHS.input_archive_docs, "archive_docs", create=True)
_mount_if_exists("/patrol-photos", _PATHS.output_patrol / "photos", "patrol_photos", create=True)
_mount_if_exists("/static", STATIC_DIR, "static")

class _FrontendStatic(StaticFiles):
    """index.html 不缓存(每次协商),带哈希的静态资源长缓存。
    否则重新构建后浏览器仍用旧 index.html,表现为"改了没生效"。"""

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        if path in (".", "index.html") or path.endswith(".html"):
            resp.headers["Cache-Control"] = "no-cache"
        elif "/assets/" in path or path.startswith("assets/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if _WEBGIS_REACT_DIST.exists():
    app.mount("/app", _FrontendStatic(directory=str(_WEBGIS_REACT_DIST), html=True), name="webgis_react")
    print(f"[startup] React WebGIS mounted: /app/ -> {_WEBGIS_REACT_DIST}")
else:
    print("[startup] React WebGIS dist not found; skip /app/ mount")


def _react_build_exists() -> bool:
    return _WEBGIS_REACT_DIST.exists() and (_WEBGIS_REACT_DIST / "index.html").exists()


_NO_BUILD_HTML = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>前端未构建</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:80px auto;line-height:1.8">
<h2>前端尚未构建</h2>
<p>请先构建 React 前端(或使用 Vite 开发服务器):</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:8px">cd platform/webgis-react
npm install
npm run build</pre>
<p>开发模式: <code>npm run dev</code> 后访问 <a href="http://localhost:5174">http://localhost:5174</a></p>
<p>API 文档: <a href="/docs">/docs</a></p>
</body></html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    if _react_build_exists():
        return RedirectResponse(url="/app/", status_code=302)
    return HTMLResponse(_NO_BUILD_HTML)


@app.get("/model-viewer", response_class=HTMLResponse)
async def model_viewer(request: Request):
    qs = request.url.query
    target = "/app/#/model-viewer" + (("?" + qs) if qs else "")
    return RedirectResponse(url=target, status_code=302)


@app.get("/pdf-viewer", response_class=HTMLResponse)
async def pdf_viewer(request: Request):
    qs = request.url.query
    target = "/app/#/pdf-viewer" + (("?" + qs) if qs else "")
    return RedirectResponse(url=target, status_code=302)


class _LoginBody(BaseModel):
    username: str
    password: str


def _auth_enabled() -> bool:
    return bool((_CONFIG.get("server") or {}).get("enable_auth", False))


def _login_response(username: str = "admin") -> JSONResponse:
    user = username or "admin"
    expires_at = int(time.time()) + _SESSION_TTL_SECONDS
    resp = JSONResponse({"ok": True, "username": user})
    resp.set_cookie(
        key="session",
        value=_sign_session(user, expires_at),
        max_age=_SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return resp


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    nxt = request.query_params.get("next") or ""
    if nxt:
        target = f"/app/#/login?next={quote(nxt, safe='/?&=#')}"
    else:
        target = "/app/#/login"
    return RedirectResponse(url=target, status_code=302)


@app.post("/api/login")
async def api_login(body: _LoginBody):
    if not _auth_enabled():
        return _login_response(body.username or "admin")

    users = (_CONFIG.get("server") or {}).get("users") or []
    for user in users:
        if user.get("username") == body.username and user.get("password") == body.password:
            return _login_response(body.username)
    return JSONResponse({"detail": "用户名或密码错误"}, status_code=401)
