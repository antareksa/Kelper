@echo off
REM A "local" Packing Station: unlike start-packing-station.bat (which just
REM opens the public production URL — nothing but Chrome needed), THIS one
REM builds and serves the frontend from this machine itself, for a location
REM that can't reliably reach the public URL. It still uses the real
REM production backend/data, not a separate local database — see
REM kelper-frontend/src/apiBase.js, which detects "a production build
REM running on localhost" and points its API calls at the real server
REM instead of assuming a local backend. CORS on that server is already
REM wide open, so no server-side change was needed for this to work.
REM
REM Unlike start-packing-station.bat, this machine DOES need this repo
REM checked out plus Node.js installed — it's building the frontend here,
REM not just pointing Chrome at an already-built one. Run `git pull` before
REM this script if you want the latest version deployed to the production
REM server also reflected here.

set PREVIEW_PORT=4173

cd /d "%~dp0kelper-frontend"
if not exist node_modules (
  call npm install
)
call npm run build

start "kelper-local-preview" /min cmd /c "npm run preview -- --port %PREVIEW_PORT% --strictPort"

REM Wait for the local preview server to actually be up before Chrome tries
REM to load it, rather than guessing a fixed delay.
:waitloop
curl -s -o nul http://localhost:%PREVIEW_PORT% 2>nul
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)

start chrome --app=http://localhost:%PREVIEW_PORT% --kiosk-printing --user-data-dir="%~dp0.kiosk-chrome-profile-local"
