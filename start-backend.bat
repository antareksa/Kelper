@echo off
cd /d "%~dp0"

if not exist "kelper-backend\node_modules" (
    echo Installing backend dependencies...
    call npm install --prefix kelper-backend
)

cd kelper-backend
echo Starting KELPER backend on http://localhost:3001
echo (Close this window, or press Ctrl+C, to stop it.)
echo.
node server.js
