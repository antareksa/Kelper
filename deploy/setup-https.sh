#!/usr/bin/env bash
# Sets up Caddy as an HTTPS reverse proxy in front of the KELPER backend.
# Caddy fetches and renews its own Let's Encrypt certificate automatically —
# no certbot, no manual renewal.
#
# Prerequisites (do these first):
#   1. A hostname pointing at this VM's external IP (a free DuckDNS
#      subdomain works fine: duckdns.org -> add domain -> point it at this
#      VM's External IP from the Cloud Console).
#   2. Firewall rules allowing inbound tcp:80 and tcp:443 (80 is needed for
#      Let's Encrypt's validation, not just redirects).
#
# Usage: ./deploy/setup-https.sh your-hostname.duckdns.org
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <your-hostname>  (e.g. kelpertoko.duckdns.org)"
  exit 1
fi
DOMAIN="$1"

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

echo "==> Writing Caddyfile for $DOMAIN"
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
$DOMAIN {
    reverse_proxy localhost:3001
}
EOF

sudo systemctl enable caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

echo ""
echo "==> Done."
echo "    Once DNS for $DOMAIN actually resolves to this VM (check with: dig +short $DOMAIN),"
echo "    https://$DOMAIN should work within ~30s — Caddy fetches the certificate on first request."
echo ""
echo "    Two things still needed manually:"
echo "    1. Set SHOPEE_REDIRECT_URI=https://$DOMAIN/ in kelper-backend/.env.production, then:"
echo "       sudo systemctl restart kelper"
echo "    2. Add https://$DOMAIN/ as an allowed redirect URI in your Shopee Open"
echo "       Platform app settings (Shopee's own developer console) — Shopee will"
echo "       reject the OAuth request otherwise."
