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
REM --use-fake-ui-for-media-stream: auto-grants the "Allow camera access?"
REM permission prompt instead of showing it — there's no one at the physical
REM station to click Allow every launch. This does NOT fake the video feed
REM itself (that would need --use-fake-device-for-media-stream too, which is
REM deliberately omitted) — it's still the real webcam, just no manual click
REM needed to grant access to it.
start chrome --app=%SERVER_URL% --start-fullscreen --kiosk-printing --use-fake-ui-for-media-stream --user-data-dir="%~dp0.kiosk-chrome-profile"

REM Old recordings older than 7 days are deleted here, once per launch,
REM rather than via a separate Windows Scheduled Task — the station already
REM gets relaunched routinely, so a dedicated always-on background task isn't
REM needed just for this. Runs in the background (start /b) so it doesn't
REM delay Chrome opening.
start /b "" powershell -NoProfile -Command "if (Test-Path '%~dp0.packing-videos') { Get-ChildItem -Path '%~dp0.packing-videos' -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force }"
