@echo off
REM This is the Dashboard Station — the ONE machine that runs KELPER's
REM actual server (backend, including its background Shopee sync/booking
REM loop) plus the Dashboard UI. Every Packing Station is a separate,
REM lighter machine that just points a browser at this one — see
REM start-packing-station.bat.
REM
REM Runs in DEVELOPMENT mode (NODE_ENV unset defaults to it) — Shopee
REM sandbox, kelper-backend\kelper.development.db, config.development.json.
REM A future cloud deployment sets NODE_ENV=production instead (its own
REM .env.production/config.production.json/kelper.production.db), and won't
REM use this .bat at all — see kelper-backend\src\env.js.
cd /d "%~dp0"

if not exist "kelper-backend\node_modules" (
    echo Installing backend dependencies...
    call npm install --prefix kelper-backend
)

if not exist "kelper-frontend\node_modules" (
    echo Installing frontend dependencies...
    call npm install --prefix kelper-frontend
)

start "KELPER Backend" cmd /k "cd /d "%~dp0kelper-backend" && node server.js"
start "KELPER Frontend" cmd /k "cd /d "%~dp0kelper-frontend" && npm run dev"

echo.
echo Starting KELPER... please wait.
timeout /t 6 /nobreak >nul
start http://localhost:5173

echo.
echo KELPER is running. Two black windows just opened (Backend and Frontend) —
echo leave both open while you use the app. To stop KELPER, close both windows.
