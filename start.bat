@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Relics Platform

REM ============================================================
REM  统一启动入口
REM    start.bat        正常启动:自动装依赖/构建前端,后端托管全部页面
REM    start.bat build  强制重新构建前端后启动
REM    start.bat dev    额外再开一个 Vite 热更新窗口(前端开发用)
REM ============================================================

cd /d "%~dp0"

set "MODE=%~1"

REM ── 1) Python 环境 ──────────────────────────────────────────
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
    set "PATH=%~dp0.venv\Scripts;%PATH%"
    echo [OK] Using project virtual environment
) else if exist "%~dp0python\python.exe" (
    set "PYTHON=%~dp0python\python.exe"
    set "PATH=%~dp0python;%~dp0python\Scripts;%PATH%"
    echo [OK] Using embedded Python
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Python not found. Install Python 3.10+ or provide .venv\Scripts\python.exe.
        pause
        exit /b 1
    )
    set "PYTHON=python"
    echo [OK] Using system Python
)

REM ── 2) 配置文件 ─────────────────────────────────────────────
if not exist "config.yaml" (
    if exist "config.example.yaml" (
        copy /Y "config.example.yaml" "config.yaml" >nul
        echo [SETUP] config.yaml was missing, copied from config.example.yaml.
        echo [NOTE]  Please edit config.yaml for your county name, map center, bounds and secrets.
    ) else (
        echo [ERROR] config.yaml missing and config.example.yaml was not found.
        pause
        exit /b 1
    )
)

REM ── 3) Python 依赖 ──────────────────────────────────────────
%PYTHON% -c "import yaml, fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
    echo [SETUP] Installing Python dependencies...
    %PYTHON% -m pip install -r platform\webgis\requirements.txt
    if errorlevel 1 (
        echo [ERROR] pip install failed. Check network or install dependencies manually.
        pause
        exit /b 1
    )
)

%PYTHON% -c "import sys; sys.path.insert(0, r'platform\scripts'); from _common import ensure_data_dirs; ensure_data_dirs()" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Could not ensure data directory skeleton. Backend will still try to start.
)

REM ── 4) 前端构建(缺 dist 或 build 参数时执行)─────────────────
set "NEED_BUILD=0"
if /i "%MODE%"=="build" set "NEED_BUILD=1"
if not exist "platform\webgis-react\dist\index.html" set "NEED_BUILD=1"

if "%NEED_BUILD%"=="1" (
    where npm.cmd >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Frontend is not built and npm was not found.
        echo         Install Node.js LTS v18+ or copy a prebuilt platform\webgis-react\dist.
        pause
        exit /b 1
    )
    if not exist "platform\webgis-react\node_modules\vite" (
        echo [SETUP] Installing frontend dependencies...
        pushd "platform\webgis-react" >nul
        call npm.cmd install
        set "NPM_RC=!ERRORLEVEL!"
        popd >nul
        if not "!NPM_RC!"=="0" (
            echo [ERROR] npm install failed in platform\webgis-react.
            pause
            exit /b !NPM_RC!
        )
    )
    echo [SETUP] Building frontend...
    pushd "platform\webgis-react" >nul
    call npm.cmd run build
    set "BUILD_RC=!ERRORLEVEL!"
    popd >nul
    if not "!BUILD_RC!"=="0" (
        echo [ERROR] Frontend build failed.
        pause
        exit /b !BUILD_RC!
    )
    echo [OK] Frontend built.
) else (
    echo [OK] Frontend build found. Run "start.bat build" to rebuild after code changes.
)

REM ── 5) 可选:Vite 热更新开发窗口 ─────────────────────────────
if /i "%MODE%"=="dev" (
    where npm.cmd >nul 2>&1
    if errorlevel 1 (
        echo [WARN] npm not found, skip Vite dev server.
    ) else (
        echo [DEV] Opening Vite dev server window: http://127.0.0.1:5174/
        start "Relics React WebGIS (dev)" cmd /k "cd /d %~dp0platform\webgis-react && npm.cmd run dev"
    )
)

REM ── 6) 环境变量与启动 ───────────────────────────────────────
set "NO_PROXY=geo.datav.aliyun.com,overpass-api.de,overpass.kumi.systems,overpass.openstreetmap.fr,overpass.osm.ch,tile.openstreetmap.org,server.arcgisonline.com,wprd01.is.autonavi.com,wprd02.is.autonavi.com,wprd03.is.autonavi.com,wprd04.is.autonavi.com,webst01.is.autonavi.com,webst02.is.autonavi.com,webst03.is.autonavi.com,webst04.is.autonavi.com,127.0.0.1,localhost"
set "no_proxy=%NO_PROXY%"
set "PYTHONIOENCODING=utf-8"

if "%RELICS_CHECK_ONLY%"=="1" (
    echo [OK] Startup preflight passed.
    endlocal
    exit /b 0
)

echo.
echo [START] Relics Platform (backend serves the built frontend at /app/)
echo.

%PYTHON% platform\webgis\serve.py

echo.
echo [STOPPED] Server exited.
pause
endlocal
