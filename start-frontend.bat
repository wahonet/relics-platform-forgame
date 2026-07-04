@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Relics Platform - Frontends

cd /d "%~dp0"

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js LTS v18 or newer.
    pause
    exit /b 1
)

if not exist "platform\admin-vue\package.json" (
    echo [ERROR] Vue admin package.json not found: platform\admin-vue
    pause
    exit /b 1
)

if exist "platform\admin-vue\node_modules\vite" (
    echo [OK] Vue admin dependencies found.
) else (
    echo [SETUP] Installing Vue admin dependencies...
    pushd "platform\admin-vue" >nul
    call npm.cmd install
    set "NPM_RC=!ERRORLEVEL!"
    popd >nul
    if not "!NPM_RC!"=="0" (
        echo [ERROR] npm install failed in platform\admin-vue.
        pause
        exit /b !NPM_RC!
    )
    echo [OK] Vue admin dependencies installed.
)

if not exist "platform\webgis-react\package.json" (
    echo [ERROR] React WebGIS package.json not found: platform\webgis-react
    pause
    exit /b 1
)

if exist "platform\webgis-react\node_modules\vite" (
    echo [OK] React WebGIS dependencies found.
) else (
    echo [SETUP] Installing React WebGIS dependencies...
    pushd "platform\webgis-react" >nul
    call npm.cmd install
    set "NPM_RC=!ERRORLEVEL!"
    popd >nul
    if not "!NPM_RC!"=="0" (
        echo [ERROR] npm install failed in platform\webgis-react.
        pause
        exit /b !NPM_RC!
    )
    echo [OK] React WebGIS dependencies installed.
)

if "%RELICS_CHECK_ONLY%"=="1" (
    echo [OK] Frontend startup preflight passed.
    endlocal
    exit /b 0
)

echo.
echo [START] Vue admin dev server:    http://127.0.0.1:5173/
echo [START] React WebGIS dev server: http://127.0.0.1:5174/
echo [NOTE]  Start the backend separately with start-backend.bat.
echo.

start "Relics Vue Admin" cmd /k "cd /d %~dp0platform\admin-vue && npm.cmd run dev"
start "Relics React WebGIS" cmd /k "cd /d %~dp0platform\webgis-react && npm.cmd run dev"

echo Two frontend terminals were opened. Close those terminals to stop the dev servers.
pause
endlocal
