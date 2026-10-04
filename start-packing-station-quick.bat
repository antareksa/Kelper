@echo off
REM Quick launcher: opens the Packing Station and goes straight to the main
REM packing screen, with NO station setup step.
REM
REM There is no station name to set. A station is identified by the operator
REM who logs in (scanning their own barcode), so two PCs can never be mixed up
REM and every PC can use the same files unchanged. One operator can only be
REM logged in on one computer at a time.
REM
REM Use start-packing-station.bat once on each PC for the initial setup
REM (test print, hardware check, camera permission, paper size). That uses the
REM same dedicated Chrome profile as this launcher, so the printer default, the
REM camera permission and the label paper size chosen during setup all carry
REM over to this one. After that, daily use is just this file.
REM
REM Everything else (SERVER_URL, the Chrome profile, the video folder) is
REM shared: this simply runs start-packing-station.bat with a flag added to the
REM address that makes the page skip setup, so change those settings there.
set "LAUNCH_QUERY=/?quick=1"

REM This file runs the normal launcher that must sit in the SAME folder. If it
REM is missing (for example only this file was copied to another place), say
REM so and wait, instead of the window flashing closed with Chrome never opening.
if not exist "%~dp0start-packing-station.bat" (
  echo.
  echo [quick launcher] start-packing-station.bat was not found in this folder:
  echo   %~dp0
  echo Keep both .bat files together in the same folder.
  pause
  exit /b 1
)

echo [quick launcher] starting the Packing Station...
call "%~dp0start-packing-station.bat"
if errorlevel 1 (
  echo.
  echo [quick launcher] start-packing-station.bat reported an error - see above.
  pause
)
