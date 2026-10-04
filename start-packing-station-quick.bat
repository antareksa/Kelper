@echo off
REM Quick launcher: opens the Packing Station and goes straight to the main
REM packing screen, with NO station setup step. The PC's own name is used as
REM the station ID (it shows that way in Active Station and the reports).
REM
REM Use start-packing-station.bat once on each PC for the initial setup
REM (station check, test print, hardware check, camera permission). That uses
REM the same dedicated Chrome profile as this launcher, so the printer
REM default, the camera permission and the label paper size chosen during
REM setup all carry over to this one. After that, daily use is just this file.
REM
REM Everything else (SERVER_URL, the Chrome profile, the video folder) is
REM shared: this simply runs start-packing-station.bat with the PC name added
REM to the address, so change those settings there, not here.
REM
REM The PC name comes from Windows (Settings, System, About, Device name).
REM Give each station PC a distinct name; two PCs with the same name would
REM count as the same station.
set "LAUNCH_QUERY=/?station=%COMPUTERNAME%"
call "%~dp0start-packing-station.bat"
