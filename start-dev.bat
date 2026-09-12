@echo off
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
echo Backend running at http://localhost:3001
echo Frontend running at http://localhost:5173
echo (Two windows just opened — closing them stops the servers.)
