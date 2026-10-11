# Packing Station PC — setup and launchers

How to set up one station PC, and how to start it every day. Commands here run
in **Windows PowerShell on the station PC** (not on the VM).

## How a station is identified

**By the operator who logs in, not by the PC.** There is no station name or
station ID to type, and the PC's name does not matter (so Windows cutting a PC
name at 15 characters can no longer merge two PCs). When an operator scans
their login barcode the server gives that operator their own station identity,
so two operators can never be handed the same order.

One rule follows: **an operator can be logged in on only one computer at a
time.** Scanning the same badge on a second computer is refused with
"... sudah masuk di komputer lain" until they log out on the first one, or about
3 minutes after that first computer went off or lost its connection.

## The files

Keep these three together in **one folder** (for example `C:\KelperStation`):

| File | What it is |
|---|---|
| `start-packing-station.bat` | **Normal launcher** — opens the station setup screen. Use it for the initial setup and after changing hardware. |
| `start-packing-station-quick.bat` | **Quick launcher** — skips setup, goes straight to the packing screen. Daily use. |
| `setup-video-download-dir.ps1` | Run by both launchers (video save folder). Must sit beside them. |

The quick launcher runs the normal one from its own folder, so **never copy the
quick `.bat` on its own** (to the Desktop, to the Startup folder, ...). It then
cannot find the normal launcher and Chrome never opens. Use a shortcut instead
(see below). Both launchers also create these next to the files — don't delete
or move them:

- `.kiosk-chrome-profile` — Chrome's profile for the station. Holds the camera
  permission, the printer default and the label paper size.
- `.packing-videos` — packing videos (older than 7 days are removed at launch).

## 1. Initial setup (once per PC)

Run `start-packing-station.bat` (the normal one), then on the setup screen:

1. **Setup Kamera** — press Allow.
2. **Uji Cetak** — test print.
3. **Cek Hardware** (optional) — prints a code, scan it back to prove the
   printer and the scanner both work. Nothing forces this; **Lanjutkan** works
   without it.
4. If your labels are not 100 x 120 mm, enter the paper size **before**
   pressing Lanjutkan. It is remembered for the quick launcher.

Then press **Lanjutkan** and scan an operator badge to log in.

## 2. Daily use

Run `start-packing-station-quick.bat`, then scan your badge.

## Turning the PC off with a barcode (optional, once per PC)

Scan the **`SHUTDOWN_PC`** command barcode (print it from **Packing Station
Dashboard, Daftar Staff** like the others) **twice within 10 seconds** and the PC
shuts down. It is **never refused**, even while an order is in progress (orders keep
arriving in the evening, so the station always has one). It logs the operator out
first, which hands an order that is still being scanned back to the queue for another
station. A package whose label is already printed stays with that operator and is
there again at their next login. It also works at the badge screen.

A web page cannot power a PC off by itself, so this needs one setting on each PC,
done once:

1. Copy `enable-shutdown-barcode.reg` (repo root, next to
   `enable-silent-printing.reg`) to the PC.
2. Open it in Notepad and check the address inside
   (`https://packing.kelper.co.id`) is the one in `start-packing-station.bat`
   (`SERVER_URL`). Change it if not.
3. Double-click it and accept the UAC prompt.
4. Close the station window and restart the PC once.

It registers a `kelper-shutdown://` handler that runs `shutdown /s /t 20`, lets
Chrome open it without asking (a Chrome policy for this machine, like the silent
printing one), and turns Fast Startup off so the shutdown is a full one. No change
to the launchers. On a PC without it, scanning the barcode does nothing and the
station says so after about 25 seconds.

## Modes

Switch a station's mode by scanning its command barcode (print them from the
Dashboard: **Packing Station Dashboard, Daftar Staff**). `PACKING_MODE` returns
to normal packing from either of the other two.

- **Packing** (default): scan items; the order's label prints when it is done.
- **`SHIPPING_MODE`**: lists every package waiting for the courier. Scan a
  package's resi when the courier takes it.
- **`PRINT_RESI_MODE`** (new): for orders packed the evening before with only a
  temp barcode (`BESOK-...`, "Pack Besok"). The screen lists them with their
  state: *SIAP CETAK* (resi booked), *MENUNGGU LABEL* (resi not booked yet) or
  *SUDAH DICETAK* (printed, waiting for the resi to be scanned back). Scan the
  temp barcode on a box and its real resi prints; stick it on and scan the
  printed resi to confirm. Scanning the temp barcode again reprints. Anything
  not in the list, or an order whose resi is not booked yet, shows a warning.
  Operators no longer go looking for these boxes through `NEXT_ORDER`.

The `PRINT_RESI_MODE` barcode must be printed once from the Dashboard before
stations can use it.

## 3. Start it automatically when Windows starts

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

- **"... sudah masuk di komputer lain"** — that operator is already logged in on
  another computer. Log out there (Keluar) and scan again. If that computer was
  switched off, wait about 3 minutes.
- **Quick launcher: window flashes and Chrome never opens** — the quick `.bat`
  is on its own, without `start-packing-station.bat` beside it. It now prints
  "start-packing-station.bat was not found in this folder"; put both files
  (and the `.ps1`) in the same folder and start it from a shortcut.
- **Does not open right after Windows starts** — the network may not be ready
  yet at login. Start it again, or ask for the launcher to wait for the server.
- **Setup screen: can't reach Lanjutkan on a short screen** — fixed in the
  current version; reopen the Packing Station after the server was updated.
