# Packing Station PC — setup and launchers

How to set up one station PC, and how to start it every day. Commands here run
in **Windows PowerShell on the station PC** (not on the VM).

## The files

Keep these three together in **one folder** (for example `C:\KelperStation`):

| File | What it is |
|---|---|
| `start-packing-station.bat` | **Normal launcher** — opens the station setup screen. Use it for the initial setup and after changing hardware. |
| `start-packing-station-quick.bat` | **Quick launcher** — skips setup, goes straight to the packing screen, uses the PC name as the station name. Daily use. |
| `setup-video-download-dir.ps1` | Run by both launchers (video save folder). Must sit beside them. |

The quick launcher runs the normal one from its own folder, so **never copy the
quick `.bat` on its own** (to the Desktop, to the Startup folder, ...). It then
cannot find the normal launcher and Chrome never opens. Use a shortcut instead
(see below). Both launchers also create these next to the files — don't delete
or move them:

- `.kiosk-chrome-profile` — Chrome's profile for the station. Holds the camera
  permission, the printer default and the label paper size.
- `.packing-videos` — packing videos (older than 7 days are removed at launch).

## 1. Name the PC

Windows: Settings, System, About, **Rename this PC**, then restart.

The PC name becomes the station name (shown capitalised, e.g. `PACK-01`) in
Active Station, the attendance and the reports. Give every station PC its own
short name; two PCs with the same name count as one station.

**Every PC needs its own station ID.** The server treats a station ID as ONE
machine. Two machines on the same ID are merged into one station, and both
operators are handed the *same order*. The login now refuses a second machine
on an ID that is in use ("ID station ... sedang dipakai ... di komputer lain"):
on the normal launcher the screen returns to setup so you can type another ID;
with the quick launcher the ID is the PC name, so rename the PC. An ID frees
up at once on logout, or about 3 minutes after a machine goes silent.

## 2. Initial setup (once per PC)

Run `start-packing-station.bat`, then on the setup screen:

1. **Setup Kamera** — press Allow.
2. **Uji Cetak** — test print.
3. **Cek Hardware** (optional) — prints a code, scan it back to prove the
   printer and the scanner both work. Nothing forces this; **Lanjutkan** works
   without it.
4. If your labels are not 100 x 120 mm, enter the paper size **before**
   pressing Lanjutkan. It is remembered for the quick launcher.

## 3. Daily use

Run `start-packing-station-quick.bat`.

## 4. Start it automatically when Windows starts

Put a **shortcut** to the quick launcher in the Startup folder (a shortcut runs
the file from its real folder, where the other files are).

**One command** — change `C:\KelperStation` to your real folder, in both places:

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\KELPER Packing Station.lnk"); $s.TargetPath = "C:\KelperStation\start-packing-station-quick.bat"; $s.WorkingDirectory = "C:\KelperStation"; $s.WindowStyle = 7; $s.Save()
```

(`WindowStyle = 7` starts the black command window minimized.)

**By hand:**

1. Right-click `start-packing-station-quick.bat`, **Create shortcut**.
2. Press Win + R, type `shell:startup`, press Enter.
3. Move the shortcut into that folder (move the shortcut, not the `.bat`).
4. Optional: shortcut Properties, **Run: Minimized**.

Delete any copy of the quick `.bat` itself that is already in the Startup
folder. Restart the PC to test it.

## Changing the camera or the printer

No full setup again — but run the **normal** launcher once to check:

- **Camera:** Chrome's Allow is remembered per site, not per camera. A new
  camera on the same PC works. If two cameras are plugged in Chrome may pick
  the old one — unplug it or choose in Chrome's site settings.
- **Printer:** make the new printer the Windows default, run the normal
  launcher and press **Uji Cetak**. If it prints to the wrong printer, delete
  the `.kiosk-chrome-profile` folder (this also clears the camera permission,
  so do **Setup Kamera** again). If the label size differs, enter the new size
  at the setup screen.

## Troubleshooting

- **Quick launcher: window flashes and Chrome never opens** — the quick `.bat`
  is on its own, without `start-packing-station.bat` beside it. It now prints
  "start-packing-station.bat was not found in this folder"; put both files
  (and the `.ps1`) in the same folder and start it from a shortcut.
- **Does not open right after Windows starts** — the network may not be ready
  yet at login. Start it again, or ask for the launcher to wait for the server.
- **Two operators got the same order** — two machines were using the same
  station ID. Give each PC its own ID (normal launcher: type it at setup;
  quick launcher: rename the PC).
- **Setup screen: can't reach Lanjutkan on a short screen** — fixed in the
  current version; reopen the Packing Station after the server was updated.
