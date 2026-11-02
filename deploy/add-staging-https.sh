#!/usr/bin/env bash
# Adds ONE extra site block to the existing Caddy config: the staging
# hostnames, proxied to the staging service on localhost:3002. Same split as
# production: the frontend opens the Dashboard on a "dashboard..." hostname
# and the Packing Station on a "packing..." one (App.jsx's initialView).
# Caddy gets the Let's Encrypt certificates for them automatically.
#
# Unlike deploy/setup-https.sh (which REWRITES the whole Caddyfile and would
# drop the live dashboard/packing sites), this script only APPENDS a block,
# and only if none of the hostnames is in the file yet. It keeps a backup of
# the Caddyfile, validates the new one, and puts the backup back if
# validation fails, so the live sites keep running either way.
#
# Before running: a DNS A record for EACH hostname must point at this VM's
# external IP (check: dig +short dashboard.staging.kelper.co.id).
#
# Usage (on the VM):  bash deploy/add-staging-https.sh [hostname ...]
#   defaults to dashboard.staging.kelper.co.id packing.staging.kelper.co.id
set -euo pipefail

if [ "$#" -eq 0 ]; then
  set -- dashboard.staging.kelper.co.id packing.staging.kelper.co.id
fi
HOSTS="$(printf '%s, ' "$@" | sed 's/, $//')"
PORT=3002
CADDYFILE=/etc/caddy/Caddyfile

if ! command -v caddy >/dev/null 2>&1 || [ ! -f "$CADDYFILE" ]; then
  echo "!! Caddy or $CADDYFILE not found. This script only adds to an existing"
  echo "   Caddy setup; it does not install Caddy. Nothing was changed."
  exit 1
fi

FOUND=""
for h in "$@"; do
  if sudo grep -qF "$h" "$CADDYFILE"; then FOUND="$FOUND $h"; fi
done
if [ -n "$FOUND" ]; then
  echo "==> Already in $CADDYFILE:$FOUND"
  echo "    Nothing was changed. Edit the file by hand if the staging block"
  echo "    needs different hostnames."
  exit 0
fi

BACKUP="$CADDYFILE.bak.$(date +%Y%m%d-%H%M%S)"
echo "==> Backing up $CADDYFILE to $BACKUP"
sudo cp "$CADDYFILE" "$BACKUP"

echo "==> Adding $HOSTS -> localhost:$PORT"
sudo tee -a "$CADDYFILE" > /dev/null << EOF

# KELPER staging (added by deploy/add-staging-https.sh)
$HOSTS {
    reverse_proxy localhost:$PORT
}
EOF

if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
  echo "!! The new Caddyfile did not validate. Restoring the backup; the live"
  echo "   sites are unchanged."
  sudo cp "$BACKUP" "$CADDYFILE"
  sudo caddy validate --config "$CADDYFILE" --adapter caddyfile || true
  exit 1
fi

# reload (not restart): the live sites keep serving during the switch.
sudo systemctl reload caddy

echo ""
echo "==> Done. Current $CADDYFILE:"
sudo cat "$CADDYFILE"
echo ""
for h in "$@"; do
  echo "    https://$h should work within ~30s once DNS resolves to this VM"
done
echo "    (Caddy fetches the certificates on the first request)."
echo "    If anything looks wrong:  sudo cp $BACKUP $CADDYFILE && sudo systemctl reload caddy"
