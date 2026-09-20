#!/usr/bin/env bash
# Run this ON the VM (Ubuntu/Debian), from inside a full copy of this
# project. Clone it to /opt/kelper (or another non-home-directory path),
# NOT into a user's home directory — a home directory is typically mode 750,
# which used to block a separate service account from even chdir-ing into
# it. E.g.:
#   sudo mkdir -p /opt/kelper && sudo chown "$USER":"$USER" /opt/kelper
#   git clone <repo-url> /opt/kelper
#   cd /opt/kelper && bash deploy/setup-vm.sh
#
# The systemd service runs as whoever runs THIS script — no separate
# dedicated service account. A dedicated unprivileged account is nicer in
# principle, but for a single-operator deployment like this it only ever
# produced cross-user permission conflicts (systemd unable to chdir into a
# chowned home directory; git refusing to touch a .git it doesn't own; the
# deploying user then locked out of writing to their own clone) — three
# separate bugs from the same root cause. Simpler and more reliable to just
# run as the deploying user.
#
# Safe to re-run: every step below checks before it acts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="$(whoami)"
SERVICE_GROUP="$(id -gn)"

echo "==> KELPER production VM setup"
echo "    App directory: $APP_DIR"
echo "    Service user:  $SERVICE_USER:$SERVICE_GROUP"

# 1. Node.js 22.x — better-sqlite3 declares it needs >=22 and only ships
#    prebuilt binaries for supported versions; anything older forces it to
#    compile from source instead of just downloading a matching binary.
# Checks the installed MAJOR version, not just "is node present at all" — a
# machine that already has an older Node (e.g. from a prior failed run) must
# still get upgraded, not skipped.
NODE_MAJOR_REQUIRED=22
current_node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
if ! command -v node >/dev/null 2>&1 || [ "$(current_node_major)" -lt "$NODE_MAJOR_REQUIRED" ]; then
  echo "==> Installing Node.js ${NODE_MAJOR_REQUIRED}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node: $(node -v)"

# build-essential (make/gcc/g++) — a fallback in case better-sqlite3 (or any
# other native dependency) still can't find a matching prebuilt binary for
# this exact OS/arch and needs to compile from source. python3 is already
# present on the base image.
if ! command -v make >/dev/null 2>&1; then
  echo "==> Installing build-essential (fallback for native module compilation)"
  sudo apt-get install -y build-essential
fi

# 2. Backend dependencies (production only, no devDependencies).
#
# --cache pins npm's cache to a directory inside the app itself instead of
# the default ~/.npm — this run consistently fails with EACCES on
# root-owned /root/.npm/_cacache files when triggered by the auto-deploy
# systemd timer specifically (never when run interactively as this same
# user), despite the timer's unit explicitly setting HOME=%h (the user's
# real home). Never got to the bottom of why systemd's non-interactive npm
# resolves its cache under /root anyway — this sidesteps the mystery
# entirely rather than depending on npm's home-dir resolution working
# correctly in every execution context.
NPM_CACHE_DIR="$APP_DIR/.npm-cache"
echo "==> Installing backend dependencies"
(cd "$APP_DIR/kelper-backend" && npm ci --omit=dev --cache "$NPM_CACHE_DIR")

# 3. Build the frontend into kelper-frontend/dist — this is what server.js
#    serves in production; there is no `vite dev` running here.
echo "==> Building frontend"
(cd "$APP_DIR/kelper-frontend" && npm ci --cache "$NPM_CACHE_DIR" && npm run build)

# 4. Sanity-check the one thing this script can't do for you.
if [ ! -f "$APP_DIR/kelper-backend/.env.production" ]; then
  echo ""
  echo "!! kelper-backend/.env.production is missing."
  echo "   The server will start, but Shopee/admin-login won't work until"
  echo "   you fill in real values there (see the template's comments)."
  echo ""
fi

# 5. Install and (re)start the systemd service.
echo "==> Installing systemd service"
sudo cp "$APP_DIR/deploy/kelper.service" /etc/systemd/system/kelper.service
sudo sed -i "s#{{APP_DIR}}#$APP_DIR#g" /etc/systemd/system/kelper.service
sudo sed -i "s#{{SERVICE_USER}}#$SERVICE_USER#g" /etc/systemd/system/kelper.service
sudo sed -i "s#{{SERVICE_GROUP}}#$SERVICE_GROUP#g" /etc/systemd/system/kelper.service
sudo systemctl daemon-reload
sudo systemctl enable kelper
sudo systemctl restart kelper

# Auto-deploy timer deliberately NOT installed here anymore — it was a
# recurring source of trouble (npm ci failing with EACCES on root-owned
# /root/.npm files specifically when triggered by the timer, never
# interactively; and its own success-gate meant a failed run wasn't retried
# on the next tick, since `git merge` already made LOCAL match REMOTE before
# the failing step even ran). Deploys are manual now: SSH in and run this
# script directly. If a kelper-autodeploy.timer is still enabled from an
# earlier setup, disable it with:
#   sudo systemctl disable --now kelper-autodeploy.timer

echo ""
echo "==> Done."
echo "    Status: sudo systemctl status kelper"
echo "    Logs:   sudo journalctl -u kelper -f"
