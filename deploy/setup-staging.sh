#!/usr/bin/env bash
# Sets up the STAGING instance of KELPER — a second, fully separate copy of
# the app for testing new marketplace integrations (TikTok) against their
# sandbox APIs without touching the real, client-facing deployment at all.
#
# This is a SEPARATE checkout in a SEPARATE directory, NOT a mode switch on
# the existing /opt/kelper checkout. It gets its own .env.production (own
# credentials), its own config.production.json (shared via git, holds no
# secrets), and its own kelper.production.db (its own SQLite file) purely
# because it lives in its own directory — db.js/config.js/server.js all
# resolve those paths relative to the checkout they're running from. It
# runs with NODE_ENV=production (not "development") because this project's
# env.js only recognizes those two values and we want staging to behave
# exactly like production code-wise — the isolation comes from being a
# different directory on disk, not from a different NODE_ENV string.
#
# Run this ON the VM, from inside a SEPARATE clone, e.g.:
#   sudo mkdir -p /opt/kelper-staging && sudo chown "$USER":"$USER" /opt/kelper-staging
#   git clone <repo-url> /opt/kelper-staging
#   cd /opt/kelper-staging && bash deploy/setup-staging.sh
#
# Never run this from /opt/kelper (the real production checkout) — it
# installs a SECOND systemd service (kelper-staging) alongside the existing
# one, but if APP_DIR resolves to /opt/kelper this would point that second
# service at the SAME database as the real one, defeating the entire point.
#
# Safe to re-run: every step below checks before it acts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="$(whoami)"
SERVICE_GROUP="$(id -gn)"

echo "==> KELPER staging VM setup"
echo "    App directory: $APP_DIR"
echo "    Service user:  $SERVICE_USER:$SERVICE_GROUP"

if [ "$APP_DIR" = "/opt/kelper" ]; then
  echo ""
  echo "!! Refusing to continue: this is running from /opt/kelper, the real"
  echo "   production checkout. Staging must be a SEPARATE clone in its own"
  echo "   directory (e.g. /opt/kelper-staging) — see the comment at the top"
  echo "   of this script."
  exit 1
fi

# Same Node.js 22.x requirement as production (deploy/setup-vm.sh) — shared
# machine-level install, harmless and idempotent to run again here.
NODE_MAJOR_REQUIRED=22
current_node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
if ! command -v node >/dev/null 2>&1 || [ "$(current_node_major)" -lt "$NODE_MAJOR_REQUIRED" ]; then
  echo "==> Installing Node.js ${NODE_MAJOR_REQUIRED}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node: $(node -v)"

if ! command -v make >/dev/null 2>&1; then
  echo "==> Installing build-essential (fallback for native module compilation)"
  sudo apt-get install -y build-essential
fi

NPM_CACHE_DIR="$APP_DIR/.npm-cache"
echo "==> Installing backend dependencies"
(cd "$APP_DIR/kelper-backend" && npm ci --omit=dev --cache "$NPM_CACHE_DIR")

echo "==> Building frontend"
(cd "$APP_DIR/kelper-frontend" && npm ci --cache "$NPM_CACHE_DIR" && npm run build)

if [ ! -f "$APP_DIR/kelper-backend/.env.production" ]; then
  echo ""
  echo "!! kelper-backend/.env.production is missing in THIS staging checkout."
  echo "   The server will start, but nothing marketplace-related will work"
  echo "   until it's filled in with SANDBOX credentials — TikTok's sandbox"
  echo "   App Key/Secret at minimum. Do not put real/live Shopee or TikTok"
  echo "   credentials in this file; this instance is for sandbox testing."
  echo ""
fi

echo "==> Installing systemd service (kelper-staging, port 3002)"
sudo cp "$APP_DIR/deploy/kelper-staging.service" /etc/systemd/system/kelper-staging.service
sudo sed -i "s#{{APP_DIR}}#$APP_DIR#g" /etc/systemd/system/kelper-staging.service
sudo sed -i "s#{{SERVICE_USER}}#$SERVICE_USER#g" /etc/systemd/system/kelper-staging.service
sudo sed -i "s#{{SERVICE_GROUP}}#$SERVICE_GROUP#g" /etc/systemd/system/kelper-staging.service
sudo systemctl daemon-reload
sudo systemctl enable kelper-staging
sudo systemctl restart kelper-staging

echo ""
echo "==> Done."
echo "    Status: sudo systemctl status kelper-staging"
echo "    Logs:   sudo journalctl -u kelper-staging -f"
echo "    The real production service (kelper) was not touched by this script."
echo ""
echo "    Next: run deploy/add-staging-https.sh ON THE SAME VM from the"
echo "    /opt/kelper checkout (not this one) to expose this on"
echo "    staging.kelper.co.id without disturbing the existing HTTPS config."
