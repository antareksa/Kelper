#!/usr/bin/env bash
# Run this ON the VM (Ubuntu 22.04+), from inside a full copy of this
# project — e.g. after `git clone` or `scp`-ing the whole repo there.
# Safe to re-run: every step below checks before it acts.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="kelper"

echo "==> KELPER production VM setup"
echo "    App directory: $APP_DIR"

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

# 2. Dedicated system user — the service never runs as root.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Creating system user: $SERVICE_USER"
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 3. Backend dependencies (production only, no devDependencies).
echo "==> Installing backend dependencies"
(cd "$APP_DIR/kelper-backend" && npm ci --omit=dev)

# 4. Build the frontend into kelper-frontend/dist — this is what server.js
#    serves in production; there is no `vite dev` running here.
echo "==> Building frontend"
(cd "$APP_DIR/kelper-frontend" && npm ci && npm run build)

# 5. Sanity-check the one thing this script can't do for you.
if [ ! -f "$APP_DIR/kelper-backend/.env.production" ]; then
  echo ""
  echo "!! kelper-backend/.env.production is missing."
  echo "   The server will start, but Shopee/admin-login won't work until"
  echo "   you fill in real values there (see the template's comments)."
  echo ""
fi

# 6. Ownership — the service user needs to read the app and write the
#    SQLite database file inside kelper-backend/.
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# 7. Install and (re)start the systemd service.
echo "==> Installing systemd service"
sudo cp "$APP_DIR/deploy/kelper.service" /etc/systemd/system/kelper.service
sudo sed -i "s#{{APP_DIR}}#$APP_DIR#g" /etc/systemd/system/kelper.service
sudo sed -i "s#{{SERVICE_USER}}#$SERVICE_USER#g" /etc/systemd/system/kelper.service
sudo systemctl daemon-reload
sudo systemctl enable kelper
sudo systemctl restart kelper

# 8. Auto-deploy timer — checks the "main" branch every 2 minutes and
#    redeploys automatically on a new commit (see auto-deploy.sh). Runs as
#    root (no User= in the unit) since it needs to re-run this same script,
#    which itself needs sudo for the steps above — avoids fighting with
#    passwordless-sudo setup for a restricted user. Skipped entirely if this
#    directory isn't a git repo (e.g. it was scp'd over instead of cloned).
if [ -d "$APP_DIR/.git" ]; then
  echo "==> Installing auto-deploy timer"
  sudo cp "$APP_DIR/deploy/kelper-autodeploy.service" /etc/systemd/system/kelper-autodeploy.service
  sudo cp "$APP_DIR/deploy/kelper-autodeploy.timer" /etc/systemd/system/kelper-autodeploy.timer
  sudo sed -i "s#{{APP_DIR}}#$APP_DIR#g" /etc/systemd/system/kelper-autodeploy.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now kelper-autodeploy.timer
else
  echo "==> Skipping auto-deploy timer — $APP_DIR isn't a git repo (was it scp'd instead of cloned?)"
fi

echo ""
echo "==> Done."
echo "    Status:       sudo systemctl status kelper"
echo "    Logs:         sudo journalctl -u kelper -f"
echo "    Auto-deploy:  sudo systemctl status kelper-autodeploy.timer"
echo "    Deploy check log: sudo journalctl -u kelper-autodeploy -f"
echo "    Manual redeploy:  cd $APP_DIR && ./deploy/auto-deploy.sh"
