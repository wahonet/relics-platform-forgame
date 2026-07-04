@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Relics Platform - Frontend

cd /d "%~dp0"

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js LTS v18 or newer.
    pause
    exit /b 1
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
echo [START] React WebGIS dev server: http://127.0.0.1:5174/
echo [NOTE]  Start the backend separately with start-backend.bat.
echo [NOTE]  For production, run "npm run build" in platform\webgis-react
echo         and the backend will serve it at /app/.
echo.

start "Relics React WebGIS" cmd /k "cd /d %~dp0platform\webgis-react && npm.cmd run dev"

echo A frontend terminal was opened. Close that terminal to stop the dev server.
pause
endlocal
