#!/usr/bin/env bash
# Sets up Caddy as an HTTPS reverse proxy in front of the KELPER backend.
# Caddy fetches and renews its own Let's Encrypt certificate automatically —
# no certbot, no manual renewal.
#
# Accepts one or more hostnames, e.g. separate ones for the Dashboard and
# Packing Station (see App.jsx's initialView — a "dashboard." or "packing."
# hostname jumps straight to that view). They all proxy to the exact same
# backend on localhost:3001; only the frontend JS decides what to show based
# on which hostname was used. Caddy gets one certificate covering all of
# them (multiple SANs on one cert), not a separate cert each.
#
# Prerequisites (do these first, for EACH hostname):
#   1. A hostname pointing at this VM's external IP (a free DuckDNS
#      subdomain works fine: duckdns.org -> add domain -> point it at this
#      VM's External IP from the Cloud Console; or an A record in your own
#      DNS/cPanel if you have a real domain).
#   2. Firewall rules allowing inbound tcp:80 and tcp:443 (80 is needed for
#      Let's Encrypt's validation, not just redirects).
#
# Usage: ./deploy/setup-https.sh dashboard.kelper.co.id packing.kelper.co.id
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <hostname> [hostname2 ...]  (e.g. dashboard.kelper.co.id packing.kelper.co.id)"
  exit 1
fi
DOMAINS="$(printf '%s, ' "$@" | sed 's/, $//')"

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
fi

echo "==> Writing Caddyfile for: $DOMAINS"
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
$DOMAINS {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl enable caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

echo ""
echo "==> Done."
for d in "$@"; do
  echo "    Once DNS for $d actually resolves to this VM (check with: dig +short $d),"
  echo "    https://$d should work within ~30s — Caddy fetches the certificate on first request."
done
echo ""
echo "    Two things still needed manually:"
echo "    1. Whichever hostname is the Dashboard one, set SHOPEE_REDIRECT_URI to"
echo "       https://<that-hostname>/ in kelper-backend/.env.production (Login Shopee"
echo "       only needs to exist on the Dashboard's URL, not the Packing Station's),"
echo "       then: sudo systemctl restart kelper"
echo "    2. Add that same URL as an allowed redirect URI in your Shopee Open"
echo "       Platform app settings (Shopee's own developer console) — Shopee will"
echo "       reject the OAuth request otherwise."
