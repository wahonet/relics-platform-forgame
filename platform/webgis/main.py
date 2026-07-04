"""FastAPI application entrypoint for the Relics Platform.

This module now acts as a small composition root:
- load runtime config and datasets in lifespan
- register middleware and API routers
- register terrain/tile route modules
- mount static assets and frontend build outputs
"""
from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

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
from routers import admin, boundaries as _boundaries, chat, crs as _crs, relics, stats, survey_routes, worklog  # noqa: E402
from terrain_provider import load_dem  # noqa: E402
from terrain_routes import register_terrain_routes  # noqa: E402
from tile_routes import TILE_CACHE_DIR, register_tile_routes  # noqa: E402

_CONFIG: dict = {}
_FEATURES: dict = {}
_PATHS = get_paths()

WEBGIS_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = WEBGIS_DIR / "templates"
STATIC_DIR = WEBGIS_DIR / "static"

_ADMIN_VUE_DIST = PROJECT_ROOT / "platform" / "admin-vue" / "dist"
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

    village_gj = _PATHS.output_boundaries / "villages.geojson"
    village_arg = str(village_gj) if village_gj.exists() else ""
    pdf_dir = PROJECT_ROOT / "data" / "input" / "01_archives_pdf"
    survey_csv = _PATHS.input_worklogs / "survey_gps.csv"

    store.load(
        str(_PATHS.output_dataset),
        village_geojson=village_arg,
        pdf_dir=str(pdf_dir) if pdf_dir.exists() else "",
        survey_gps_csv=str(survey_csv) if survey_csv.exists() else "",
        bounds=bbox,
    )

    print(f"[startup] relic records: {len(store.relics)}")
    print(f"[startup] photo index: {len(store.photo_index)}")
    print(f"[startup] drawing index: {len(store.drawing_index)}")
    print(f"[startup] archive PDFs: {len(store.pdf_map)}")
    print(f"[startup] survey routes: {len(store.survey_routes)}")
    if store.village_coverage:
        vc = store.village_coverage
        print(f"[startup] village coverage: {vc['reached']}/{vc['total']}")

    cached = sum(1 for _ in TILE_CACHE_DIR.rglob("*.tile"))
    print(f"[startup] tile cache: {cached} -> {TILE_CACHE_DIR}")

    dem_dir = _PATHS.input_dem
    enable_dem = _feature_enabled("enable_dem", _FEATURES.get("dem", False))
    if enable_dem and dem_dir.exists():
        load_dem(str(dem_dir))
    else:
        print(f"[DEM] skipped (enable_dem={enable_dem}, exists={dem_dir.exists()})")

    try:
        chat.init_chat()
    except Exception as e:
        print(f"[AI] init failed: {e}")

    yield


app = FastAPI(title="Relics Platform", version="1.0.0", lifespan=lifespan)

_PUBLIC_PREFIXES = (
    "/login",
    "/api/login",
    "/static/",
    "/tiles/",
    "/api/terrain/",
    "/api/platform/config",
    "/app/",
    "/legacy",
)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not (_CONFIG.get("server") or {}).get("enable_auth", False):
            return await call_next(request)
        path = request.url.path
        if any(path == p or path.startswith(p) for p in _PUBLIC_PREFIXES):
            return await call_next(request)
        if request.cookies.get("session") != "authenticated":
            from urllib.parse import quote

            target = path
            if request.url.query:
                target = f"{path}?{request.url.query}"
            login_url = f"/login?next={quote(target, safe='/?&=#')}"
            return RedirectResponse(url=login_url, status_code=302)
        return await call_next(request)


app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(relics.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(survey_routes.router, prefix="/api")
app.include_router(worklog.router, prefix="/api")
app.include_router(_boundaries.router, prefix="/api")
app.include_router(_crs.router, prefix="/api")

register_terrain_routes(app)
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

    features_resolved = {
        "ai_chat": _feature_enabled("enable_ai_chat", bool(_resolved(sf.get("key", "")))),
        "worklog": _feature_enabled("enable_worklog", _FEATURES.get("worklogs", False)),
        "models_3d": _feature_enabled("enable_3d_model", _FEATURES.get("models_3d", False)),
        "dem": _feature_enabled("enable_dem", _FEATURES.get("dem", False)),
    }

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
            "townships": admin_cfg.get("townships", []),
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
            "has_3d_count": sum(1 for r in store.relics if r.get("has_3d")),
        },
        "admin_ui": {
            "available": _ADMIN_VUE_DIST.exists() and (_ADMIN_VUE_DIST / "index.html").exists(),
            "url": "/admin-ui/",
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
_mount_if_exists("/worklog-pdfs", _PATHS.output_worklogs, "worklog_pdfs", create=True)
_mount_if_exists("/3d", _PATHS.input_models_3d, "3d_models", create=True)
_mount_if_exists("/pdfs", PROJECT_ROOT / "data" / "input" / "01_archives_pdf", "pdfs")
_mount_if_exists("/survey-photos", _PATHS.input_worklogs / "survey_photos", "survey_photos")
_mount_if_exists("/static", STATIC_DIR, "static")

if _ADMIN_VUE_DIST.exists():
    app.mount("/admin-ui", StaticFiles(directory=str(_ADMIN_VUE_DIST), html=True), name="admin_ui")
    print(f"[startup] Vue admin mounted: /admin-ui/ -> {_ADMIN_VUE_DIST}")
else:
    print("[startup] Vue admin dist not found; skip /admin-ui/ mount")

if _WEBGIS_REACT_DIST.exists():
    app.mount("/app", StaticFiles(directory=str(_WEBGIS_REACT_DIST), html=True), name="webgis_react")
    print(f"[startup] React WebGIS mounted: /app/ -> {_WEBGIS_REACT_DIST}")
else:
    print("[startup] React WebGIS dist not found; skip /app/ mount")


def _bootstrap_script() -> str:
    proj = (_CONFIG.get("project") or {})
    geo = (_CONFIG.get("geo") or {})
    adm = (_CONFIG.get("administrative") or {})
    api = (_CONFIG.get("api") or {})
    sf = api.get("siliconflow") or {}
    cesium_token = (api.get("cesium_ion") or {}).get("token", "") or ""
    if cesium_token.startswith("${") and cesium_token.endswith("}"):
        cesium_token = ""

    payload = {
        "project": {
            "name": proj.get("name", ""),
            "full_name": proj.get("full_name", ""),
            "data_cutoff": proj.get("data_cutoff", ""),
            "data_source": proj.get("data_source", ""),
        },
        "geo": {
            "center": geo.get("center") or {"lng": 116.0, "lat": 35.0, "alt": 75000},
            "bounds": geo.get("bounds") or {},
        },
        "administrative": {
            "county_name": adm.get("county_name", ""),
            "townships": adm.get("townships", []),
        },
        "features": {
            "ai_chat": _feature_enabled("enable_ai_chat", bool(sf.get("key", "").strip() and not sf.get("key", "").startswith("${"))),
            "worklog": _feature_enabled("enable_worklog", _FEATURES.get("worklogs", False)),
            "models_3d": _feature_enabled("enable_3d_model", _FEATURES.get("models_3d", False)),
            "dem": _feature_enabled("enable_dem", _FEATURES.get("dem", False)),
        },
        "cesium_ion_token": cesium_token,
        "stats": {
            "relics_total": len(store.relics),
        },
        "admin_ui": {
            "available": _ADMIN_VUE_DIST.exists() and (_ADMIN_VUE_DIST / "index.html").exists(),
            "url": "/admin-ui/",
        },
        "auth": {
            "enabled": bool((_CONFIG.get("server") or {}).get("enable_auth", False)),
        },
    }
    js_payload = json.dumps(payload, ensure_ascii=False)
    return (
        "<script>\n"
        f"window.__PLATFORM_CONFIG = {js_payload};\n"
        "try { if (window.Cesium && window.__PLATFORM_CONFIG.cesium_ion_token) "
        "{ Cesium.Ion.defaultAccessToken = window.__PLATFORM_CONFIG.cesium_ion_token; } } catch(e) {}\n"
        "</script>\n"
    )


def _render_template(name: str) -> str:
    path = TEMPLATES_DIR / name
    if not path.exists():
        return f"<h1>Template missing: {name}</h1>"
    html = path.read_text(encoding="utf-8")

    proj = (_CONFIG.get("project") or {})
    adm = (_CONFIG.get("administrative") or {})
    full_name = proj.get("full_name") or ""
    county_name = adm.get("county_name") or proj.get("name") or ""
    data_source = proj.get("data_source") or ""

    for key, value in {
        "{{ full_name }}": full_name,
        "{{ county_name }}": county_name,
        "{{ data_source }}": data_source,
    }.items():
        html = html.replace(key, value)

    bootstrap = _bootstrap_script()
    if "</head>" in html:
        return html.replace("</head>", bootstrap + "</head>", 1)
    return bootstrap + html


def _react_build_exists() -> bool:
    return _WEBGIS_REACT_DIST.exists() and (_WEBGIS_REACT_DIST / "index.html").exists()


@app.get("/", response_class=HTMLResponse)
async def index():
    if _react_build_exists():
        return RedirectResponse(url="/app/", status_code=302)
    return HTMLResponse(_render_template("index.html"))


@app.get("/legacy", response_class=HTMLResponse)
async def legacy_index():
    return _render_template("index.html")


@app.get("/model-viewer", response_class=HTMLResponse)
async def model_viewer(request: Request):
    if _react_build_exists():
        qs = request.url.query
        target = "/app/#/model-viewer" + (("?" + qs) if qs else "")
        return RedirectResponse(url=target, status_code=302)
    return HTMLResponse(_render_template("model_viewer.html"))


@app.get("/pdf-viewer", response_class=HTMLResponse)
async def pdf_viewer(request: Request):
    if _react_build_exists():
        qs = request.url.query
        target = "/app/#/pdf-viewer" + (("?" + qs) if qs else "")
        return RedirectResponse(url=target, status_code=302)
    return HTMLResponse(_render_template("pdf_viewer.html"))


@app.get("/admin")
async def admin_page():
    return RedirectResponse(url="/admin-ui/", status_code=302)


class _LoginBody(BaseModel):
    username: str
    password: str


def _auth_enabled() -> bool:
    return bool((_CONFIG.get("server") or {}).get("enable_auth", False))


def _login_response(username: str = "admin") -> JSONResponse:
    resp = JSONResponse({"ok": True, "username": username or "admin"})
    resp.set_cookie(
        key="session",
        value="authenticated",
        httponly=True,
        samesite="lax",
        path="/",
    )
    return resp


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if _react_build_exists():
        nxt = request.query_params.get("next") or ""
        if nxt:
            from urllib.parse import quote

            target = f"/app/#/login?next={quote(nxt, safe='/?&=#')}"
        else:
            target = "/app/#/login"
        return RedirectResponse(url=target, status_code=302)
    return HTMLResponse(_render_template("login.html"))


@app.post("/api/login")
async def api_login(body: _LoginBody):
    if not _auth_enabled():
        return _login_response(body.username or "admin")

    users = (_CONFIG.get("server") or {}).get("users") or []
    for user in users:
        if user.get("username") == body.username and user.get("password") == body.password:
            return _login_response(body.username)
    return JSONResponse({"detail": "用户名或密码错误"}, status_code=401)
