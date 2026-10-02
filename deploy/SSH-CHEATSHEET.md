# SSH Command Cheatsheet

Quick reference for every command you run on the production VM. Copy-paste
these directly — don't type the `#` comments, those are just notes.

## Connect to the VM

```bash
ssh -i "$env:USERPROFILE\.ssh\kelper_vm" dihyanfr32@34.101.187.99
```

Run this once per terminal session. Everything below assumes you're already
connected.

## Deploy the latest code

```bash
cd /opt/kelper
git pull
bash deploy/setup-vm.sh
```

Run this any time Claude says "pushed to main" and gives you this command —
pulls the latest code and restarts the service.

## Pause / resume order fetching

Useful right after connecting a new/different shop, so real orders don't
immediately start flowing into Packing Station before you're ready.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/fetch-lock.js lock
```
Pauses fetching — no new orders pulled from Shopee.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/fetch-lock.js unlock
```
Resumes fetching.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/fetch-lock.js status
```
Just checks current state, changes nothing. Same toggle as the "Mulai
Fetching" / "Jeda Fetching" button in the Dashboard — this just does it from
the terminal instead.

## Manage admin logins

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js add <username> <password>
```
Creates a new admin login — e.g. a separate one to give a Shopee reviewer
during Go Live, without sharing your own real password.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js remove <username>
```
Deletes that login — instantly revokes access.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js list
```
Shows every admin account that currently exists.

## Reset test/sandbox order data

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/reset-shop-data.js <shop_id>
```
Clears all orders, packing sessions, and attendance history for that
specific shop_id — for wiping sandbox test clutter before testing fresh.
Keeps staff (operators), the product/HPP catalog, and packing settings
untouched. You must type the actual shop_id (e.g. `227886187`) — it refuses
to run without one, on purpose, so it can never accidentally wipe a real
shop by mistake.

## Check service status / logs

```bash
sudo systemctl status kelper --no-pager
```
Shows whether the backend is running, and the last few log lines.

```bash
sudo journalctl -u kelper -f --no-pager
```
Live-tails the logs (Ctrl+C to stop watching). Useful for watching what the
server is doing in real time.

```bash
sudo systemctl restart kelper
```
Restarts the backend — needed after editing `.env.production` by hand (the
scripts above don't need this, only direct `.env` edits do).

## Edit production environment variables

```bash
nano /opt/kelper/kelper-backend/.env.production
```
Opens the real production secrets/config file for editing (Partner IDs,
keys, admin credentials, etc.). Save with `Ctrl+O`, Enter, then exit with
`Ctrl+X`. **Restart the service afterward** (see above) for changes to take
effect.

## Switch both Shopee apps from sandbox to LIVE

Do these in order. Both apps (main + Brand Portal) share one `AUTH_BASE` and
one `API_BASE`, so the host change hits both at once — swap all four
credentials in the same sitting, or the app left on test credentials will
fail against the live host.

**1. Lock fetching first**, so nothing starts pulling real orders the moment
the real shop connects:
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/fetch-lock.js lock
```

**2. Edit `.env.production`** (`nano /opt/kelper/kelper-backend/.env.production`)
and change these six lines (get the Live Partner ID/Key from Partner Console
-> App List -> your app -> App Key, one app at a time):
```
SHOPEE_PARTNER_ID=<main app LIVE Partner ID>
SHOPEE_PARTNER_KEY=<main app LIVE Key>
SHOPEE_BRAND_PARTNER_ID=<Brand Portal LIVE Partner ID>
SHOPEE_BRAND_PARTNER_KEY=<Brand Portal LIVE Key>
SHOPEE_AUTH_BASE=https://partner.shopeemobile.com/api/v2/shop/auth_partner
SHOPEE_API_BASE=https://partner.shopeemobile.com
```
Leave `SHOPEE_REDIRECT_URI`, `SHOPEE_BRAND_REDIRECT_URI` and
`SHOPEE_PUSH_CALLBACK_URL` alone (they're `dashboard.kelper.co.id` URLs and
don't change between sandbox and live).

**3. Restart**, then reconnect both apps from Dashboard -> Pengaturan:
```bash
sudo systemctl restart kelper
```
Old sandbox tokens stop working against the live host, so you will see
`Invalid access_token` lines in the logs until you reconnect — expected.

**4. Reconnect** the main app and Brand Portal (Hubungkan) in Pengaturan.
The newest connection becomes the active shop automatically.

**5. Only when packing stations are ready**, unlock fetching:
```bash
NODE_ENV=production node scripts/fetch-lock.js unlock
```
