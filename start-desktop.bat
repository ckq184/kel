@echo off
setlocal
cd /d "%~dp0"

set SERVICES_UP=1
curl -s -o nul -m 2 http://127.0.0.1:5173 >nul 2>&1 || set SERVICES_UP=0
curl -s -o nul -m 2 http://127.0.0.1:3000 >nul 2>&1 || set SERVICES_UP=0
if "%SERVICES_UP%"=="1" goto :desktop

echo [miniclaw] starting backend + Vite (minimized window)...
start "miniclaw-backend" /min cmd /k "npm run dev:all"

:wait
timeout /t 2 /nobreak >nul
curl -s -o nul -m 2 http://127.0.0.1:5173 >nul 2>&1 || goto :wait
curl -s -o nul -m 2 http://127.0.0.1:3000 >nul 2>&1 || goto :wait

:desktop
echo [miniclaw] services ready, launching desktop...
set MINICLAW_RENDERER_URL=http://127.0.0.1:5173
call npm run desktop:dev
endlocal
