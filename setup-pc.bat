@echo off
REM One-time setup for a Packing Station PC. Run it ONCE per PC (double-click,
REM accept the UAC prompt). Safe to run again. It does not touch the launchers.
REM
REM   1. Windows Update fully OFF:
REM      - Windows Update policies: no automatic updates, no Windows Update
REM        servers, no driver updates, no restart while someone is signed in.
REM      - Updates paused until 2045 (works on Windows Home too, where some
REM        policies are ignored).
REM      - The update services (wuauserv, UsoSvc, WaaSMedicSvc, uhssvc) and the
REM        update scheduled tasks are disabled.
REM      - Windows' own "Medic" service normally switches updates back on, so a
REM        scheduled task "KELPER\Block Windows Update" re-applies the block at
REM        every start (it runs as SYSTEM, the only account that may disable
REM        WaaSMedicSvc). It runs a copy of this file kept in
REM        C:\ProgramData\KELPER (only administrators can change it).
REM   2. The screen never turns off and the PC never sleeps:
REM      - Screen saver off.
REM      - "Turn off display" and "Sleep" set to Never, hibernate off.
REM
REM Note: with Windows Update off, Windows Defender may also stop getting new
REM virus definitions. Turn updates back on now and then if the PC should get
REM security updates.
REM
REM To undo the Windows Update part (updates back on):
REM   setup-pc.bat undo      (from a Command Prompt in this folder)
REM The screen settings are not undone: change them in Settings > Power.

setlocal
set "KDIR=%ProgramData%\KELPER"
set "KBAT=%ProgramData%\KELPER\setup-pc.bat"
set "TASK=KELPER\Block Windows Update"

REM "block" / "unblock" are only used by the SYSTEM scheduled task.
if /i "%~1"=="block" goto :block
if /i "%~1"=="unblock" goto :unblock

REM Re-run elevated (UAC prompt) when not started as administrator. The
REM "elevated" word keeps the argument list non-empty for Start-Process.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'elevated %*' -Verb RunAs"
  exit /b
)
set "MODE=%~1"
if /i "%MODE%"=="elevated" set "MODE=%~2"
if /i "%MODE%"=="undo" goto :undo

echo ============================================================
echo  KELPER - Packing Station PC setup
echo ============================================================
echo.

echo [1/2] Turning Windows Update off ...
call :policies_on
if not exist "%KDIR%" mkdir "%KDIR%"
copy /y "%~f0" "%KBAT%" >nul
icacls "%KDIR%" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" >nul
schtasks /create /tn "%TASK%" /tr "\"%KBAT%\" block" /sc onstart /ru SYSTEM /rl highest /f >nul
if errorlevel 1 (
  echo     ERROR: could not create the scheduled task.
) else (
  schtasks /run /tn "%TASK%" >nul
  call :wait_wu DISABLED
)
echo.

echo [2/2] Screen: no screen saver, display and sleep never turn off ...
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f >nul
reg add "HKCU\Control Panel\Desktop" /v ScreenSaverIsSecure /t REG_SZ /d 0 /f >nul
reg add "HKCU\Control Panel\Desktop" /v SCRNSAVE.EXE /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Policies\Microsoft\Windows\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f >nul
REM Also for new user accounts and the sign-in screen.
reg add "HKU\.DEFAULT\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f >nul
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /hibernate off >nul 2>&1
echo     Done.
echo.
echo ============================================================
echo  Finished. Restart the PC once.
echo ============================================================
pause
exit /b 0

:undo
echo Turning Windows Update back on ...
schtasks /delete /tn "%TASK%" /f >nul 2>&1
call :policies_off
if not exist "%KBAT%" (
  if not exist "%KDIR%" mkdir "%KDIR%"
  copy /y "%~f0" "%KBAT%" >nul
)
schtasks /create /tn "KELPER\Unblock Windows Update" /tr "\"%KBAT%\" unblock" /sc once /st 00:00 /ru SYSTEM /rl highest /f >nul 2>&1
schtasks /run /tn "KELPER\Unblock Windows Update" >nul
call :wait_wu ENABLED
schtasks /delete /tn "KELPER\Unblock Windows Update" /f >nul 2>&1
echo Done. Windows Update is on again (Settings ^> Windows Update).
pause
exit /b 0

REM ---- Runs as SYSTEM (scheduled task) -------------------------------------
:block
for %%S in (wuauserv UsoSvc WaaSMedicSvc uhssvc) do (
  sc stop %%S >nul 2>&1
  reg add "HKLM\SYSTEM\CurrentControlSet\Services\%%S" /v Start /t REG_DWORD /d 4 /f >nul 2>&1
)
REM WaaSMedicSvc can switch wuauserv back on through its recovery actions.
sc failure wuauserv reset= 0 actions= "" >nul 2>&1
powershell -NoProfile -Command "Get-ScheduledTask -TaskPath '\Microsoft\Windows\WindowsUpdate\','\Microsoft\Windows\UpdateOrchestrator\','\Microsoft\Windows\WaaSMedic\' -ErrorAction SilentlyContinue | Disable-ScheduledTask -ErrorAction SilentlyContinue | Out-Null"
exit /b 0

:unblock
reg add "HKLM\SYSTEM\CurrentControlSet\Services\wuauserv" /v Start /t REG_DWORD /d 3 /f >nul 2>&1
reg add "HKLM\SYSTEM\CurrentControlSet\Services\UsoSvc" /v Start /t REG_DWORD /d 2 /f >nul 2>&1
reg add "HKLM\SYSTEM\CurrentControlSet\Services\WaaSMedicSvc" /v Start /t REG_DWORD /d 3 /f >nul 2>&1
reg add "HKLM\SYSTEM\CurrentControlSet\Services\uhssvc" /v Start /t REG_DWORD /d 3 /f >nul 2>&1
powershell -NoProfile -Command "Get-ScheduledTask -TaskPath '\Microsoft\Windows\WindowsUpdate\','\Microsoft\Windows\UpdateOrchestrator\','\Microsoft\Windows\WaaSMedic\' -ErrorAction SilentlyContinue | Enable-ScheduledTask -ErrorAction SilentlyContinue | Out-Null"
exit /b 0

REM ---- Helpers ---------------------------------------------------------------
:policies_on
set "WU=HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"
reg add "%WU%\AU" /v NoAutoUpdate /t REG_DWORD /d 1 /f >nul
reg add "%WU%\AU" /v AUOptions /t REG_DWORD /d 1 /f >nul
reg add "%WU%\AU" /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f >nul
reg add "%WU%" /v DoNotConnectToWindowsUpdateInternetLocations /t REG_DWORD /d 1 /f >nul
reg add "%WU%" /v ExcludeWUDriversInQualityUpdate /t REG_DWORD /d 1 /f >nul
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\DriverSearching" /v DontSearchWindowsUpdate /t REG_DWORD /d 1 /f >nul
set "UX=HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings"
reg add "%UX%" /v FlightSettingsMaxPauseDays /t REG_DWORD /d 7300 /f >nul
for %%V in (PauseFeatureUpdatesStartTime PauseQualityUpdatesStartTime PauseUpdatesStartTime) do reg add "%UX%" /v %%V /t REG_SZ /d "2026-01-01T00:00:00Z" /f >nul
for %%V in (PauseFeatureUpdatesEndTime PauseQualityUpdatesEndTime PauseUpdatesExpiryTime) do reg add "%UX%" /v %%V /t REG_SZ /d "2045-12-31T00:00:00Z" /f >nul
exit /b 0

:policies_off
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\DriverSearching" /v DontSearchWindowsUpdate /f >nul 2>&1
set "UX=HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings"
for %%V in (FlightSettingsMaxPauseDays PauseFeatureUpdatesStartTime PauseQualityUpdatesStartTime PauseUpdatesStartTime PauseFeatureUpdatesEndTime PauseQualityUpdatesEndTime PauseUpdatesExpiryTime) do reg delete "%UX%" /v %%V /f >nul 2>&1
exit /b 0

REM Waits up to 30 s for the SYSTEM task to switch wuauserv, then reports.
:wait_wu
for /l %%i in (1,1,30) do (
  call :wu_is %1 && goto :wait_done
  timeout /t 1 /nobreak >nul
)
echo     WARNING: Windows Update service did not change yet. Restart the PC and run this again.
exit /b 1
:wait_done
if /i "%1"=="DISABLED" (echo     Windows Update is OFF.) else (echo     Windows Update service is back on.)
exit /b 0

:wu_is
sc qc wuauserv | find /i "DISABLED" >nul
if /i "%1"=="DISABLED" exit /b %errorlevel%
if errorlevel 1 exit /b 0
exit /b 1
