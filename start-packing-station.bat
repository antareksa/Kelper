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
REM the KELPER project. ONE separate machine (the Dashboard Station, started
REM via start-dashboard-station.bat) runs the actual server; every Packing
REM Station is just this one file plus Chrome, nothing else. Set
REM SERVER_ADDRESS below to that one machine's LAN IP (find it by running
REM "ipconfig" on the server machine and reading its IPv4 Address — usually
REM 192.168.x.x). Leave it as localhost only if THIS station is that same
REM machine.
set SERVER_ADDRESS=localhost

start chrome --app=http://%SERVER_ADDRESS%:5173 --kiosk-printing --user-data-dir="%~dp0.kiosk-chrome-profile"
