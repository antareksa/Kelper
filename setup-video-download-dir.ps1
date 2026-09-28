# Silently points this Chrome profile's downloads at $VideoDir with no
# "Save As" dialog, by patching the profile's own Preferences file --
# Chrome's download.default_directory/prompt_for_download are genuinely
# persistent across restarts (unlike the File System Access API's
# per-process permission grant, which was the original approach here and
# turned out to reset on every .bat relaunch -- see start-packing-station.bat
# for the full story). Run BEFORE launching Chrome; safe to re-run every
# launch (idempotent), and preserves every other existing key untouched
# (confirmed against a profile with real printer-default settings already
# in it) so it can't interfere with the printer-default trick that same
# profile is also relied on for.
param(
  [Parameter(Mandatory = $true)][string]$VideoDir,
  [Parameter(Mandatory = $true)][string]$ProfileDir
)

if (-not (Test-Path $VideoDir)) {
  New-Item -ItemType Directory -Path $VideoDir -Force | Out-Null
}

$prefsPath = Join-Path $ProfileDir "Default\Preferences"
$prefsDir = Split-Path $prefsPath
if (-not (Test-Path $prefsDir)) {
  New-Item -ItemType Directory -Path $prefsDir -Force | Out-Null
}

if (Test-Path $prefsPath) {
  try {
    $prefs = Get-Content $prefsPath -Raw | ConvertFrom-Json
  } catch {
    # Refuse to touch a Preferences file we can't safely parse -- Chrome
    # already owns this file (printer defaults live in it too), so
    # overwriting a malformed-but-real file blind is worse than just
    # skipping the video-folder setup for this one launch.
    Write-Error "Existing Preferences file is not valid JSON -- refusing to touch it: $_"
    exit 1
  }
} else {
  $prefs = [PSCustomObject]@{}
}

if (-not $prefs.PSObject.Properties['download']) {
  $prefs | Add-Member -NotePropertyName 'download' -NotePropertyValue ([PSCustomObject]@{})
}
$prefs.download | Add-Member -NotePropertyName 'default_directory' -NotePropertyValue $VideoDir -Force
$prefs.download | Add-Member -NotePropertyName 'prompt_for_download' -NotePropertyValue $false -Force
$prefs.download | Add-Member -NotePropertyName 'directory_upgrade' -NotePropertyValue $true -Force

$json = $prefs | ConvertTo-Json -Depth 20 -Compress
Set-Content -Path $prefsPath -Value $json -Encoding UTF8 -NoNewline
