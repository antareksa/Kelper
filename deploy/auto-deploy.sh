#!/usr/bin/env bash
# Checks the git remote for new commits on the deployed branch (default:
# main) and, if there are any, pulls and re-runs setup-vm.sh to rebuild and
# restart the service. Meant to be run periodically by
# kelper-autodeploy.timer — safe to run manually too, it's a no-op when
# nothing changed.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"

cd "$APP_DIR"
git fetch origin "$BRANCH" --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "==> New commit(s) on $BRANCH — deploying $LOCAL -> $REMOTE"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH"

"$APP_DIR/deploy/setup-vm.sh"
