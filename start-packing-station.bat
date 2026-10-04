@echo off
REM Launches the Packing Station as a kiosk-mode Chrome window with no print
REM dialog — required for silent label printing on the thermal printer.
REM
REM Uses a dedicated Chrome profile (separate folder next to this script)
REM instead of your normal Chrome profile. This matters: Chrome remembers
REM the last-used print destination per profile ("sticky" setting), and if
REM your regular profile ever printed to "Save as PDF", --kiosk-printing can
REM keep reusing that instead of the real Windows default printer. A fresh,
REM dedicated profile has no such history to override the default with.
REM
REM This is a Packing Station — a lightweight kiosk machine, not a copy of
REM the KELPER project. ONE separate machine (the Dashboard Station, or a
REM cloud VM) runs the actual server; every Packing Station is just this one
REM file plus Chrome, nothing else. Set SERVER_URL below to wherever that
REM server actually is — the real production URL for daily use, e.g.:
REM   https://packing.kelper.co.id
REM (a dedicated "packing." hostname jumps straight into station setup, no
REM landing-page click needed — see App.jsx's initialView). For local LAN
REM testing instead of the real server, use that machine's IP and Vite's dev
REM port instead, e.g.: http://192.168.1.50:5173
set SERVER_URL=https://packing.kelper.co.id

REM --start-fullscreen: launches straight into fullscreen (no title bar, no
REM taskbar) instead of a normal-sized app window. Kept as --app mode rather
REM than switching to Chrome's stricter --kiosk flag, so Esc still exits
REM fullscreen and the window can still be closed normally if needed at the
REM physical machine — ask if the harder-to-exit --kiosk lockdown is wanted
REM instead.
REM
REM Camera permission is granted once, for real, by clicking "Allow" during
REM the one-time "Setup Kamera" step in Station Setup — NOT via a
REM --use-fake-ui-for-media-stream flag. That flag was tried first but
REM triggers Chrome's "unsupported command-line flag: stability and security
REM will suffer" warning banner permanently on screen, which is a real
REM problem for a kiosk display. Since this profile is dedicated and
REM persistent (see above), a permission granted once sticks for every
REM future launch without asking again — same trick as the printer default.
REM Packing videos save via a plain browser download (see PackingStation.jsx)
REM rather than the File System Access API's folder-picker — that API's
REM permission grant turned out to only last the current Chrome process, so
REM it silently reset (asking the operator to pick the folder again) on
REM every single relaunch of this .bat. Chrome's own download location is a
REM real persistent profile setting instead, so this runs BEFORE Chrome
REM starts (not backgrounded — the file must be written before Chrome reads
REM it) to silently point downloads at .packing-videos with no Save As
REM dialog, ever, on every launch. Safe to re-run — it's idempotent and
REM preserves every other setting already in this profile (including the
REM printer-default one above).
REM -ExecutionPolicy Bypass: a plain dedicated station PC (not a dev machine)
REM typically has PowerShell's default "Restricted" policy, which silently
REM refuses to run ANY .ps1 file at all — this was missing and is the likely
REM reason this step failed the first time it was deployed. Only affects
REM this one invocation, not the machine's policy as a whole.
REM
REM If this step fails for any other reason, the window is kept open with
REM the actual error message instead of flashing closed before it can be
REM read (which is what made the first failure impossible to diagnose).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-video-download-dir.ps1" -VideoDir "%~dp0.packing-videos" -ProfileDir "%~dp0.kiosk-chrome-profile"
if errorlevel 1 (
  echo.
  echo [start-packing-station] setup-video-download-dir.ps1 failed - see the error above.
  echo Packing will continue without automatic video saving until this is fixed.
  pause
)

REM LAUNCH_QUERY is empty for this normal launcher (the page opens on the
REM station setup screen). start-packing-station-quick.bat sets it to a
REM station name for the page and then runs THIS file, so both launchers
REM always use the same SERVER_URL, profile and video setup from one place.
start chrome --app=%SERVER_URL%%LAUNCH_QUERY% --start-fullscreen --kiosk-printing --user-data-dir="%~dp0.kiosk-chrome-profile"

REM Old recordings older than 7 days are deleted here, once per launch,
REM rather than via a separate Windows Scheduled Task — the station already
REM gets relaunched routinely, so a dedicated always-on background task isn't
REM needed just for this. Runs in the background (start /b) so it doesn't
REM delay Chrome opening.
start /b "" powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%~dp0.packing-videos') { Get-ChildItem -Path '%~dp0.packing-videos' -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force }"
