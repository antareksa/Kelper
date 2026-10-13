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
NODE_ENV=production node scripts/fetch-lock.js unlock 5
```
Unlocks for **5 new orders only** (change the number), then locks itself again.
Orders already fetched are still booked and labelled after the lock; only new
orders stop coming in. `status` shows how many are left. Running `lock` or
`unlock` again ends it.

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
during Go Live, without sharing your own real password. Full access to the
whole Dashboard.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js add <username> <password> packing
```
Creates a **Packing Station admin**: after login they see the Packing Station
Dashboard, Order, and List Barang with **stock only** (they can edit stock
numbers and upload the stock sheet, but never see HPP, Harga, barcode, profit
or sales). No Dashboard or Pengaturan, and no fetching on/off
switch. Enforced on the server, not just hidden in the menu.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js set-role <username> <admin|packing>
```
Changes an existing login's role. That login is signed out of its open
sessions, so the new role applies from its next login.

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js remove <username>
```
Deletes that login — instantly revokes access (its open sessions end too).

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/manage-admin.js list
```
Shows every account that currently exists, with its role.

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

## Reset EVERYTHING (start from a clean slate)

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/reset-all.js
```
Shows what will be deleted, then asks you to type `RESET`. Before deleting
anything it saves a full backup copy to `kelper-backend/backups/`, and the
delete is all-or-nothing.

Deletes: orders and packing history, attendance, ads/shop statistics, the
Shopee connection (tokens + cached items), the product/HPP/barcode/stock
catalog and bundles, staff (operators), and packing settings. Fetching ends
up **locked**. **Admin accounts are always kept**, otherwise nobody could log
in to the Dashboard again.

Keep parts by adding options:
```bash
NODE_ENV=production node scripts/reset-all.js --keep-staff --keep-products
```
Options: `--keep-staff`, `--keep-products`, `--keep-settings`,
`--keep-shopee` (keeps the Shopee connection), `--keep-items` (keeps the item
list shown in List Barang; without it the list is cleared and comes back when
you press the sync button). `--yes` skips the question.

Afterwards reload the Dashboard and Packing Station pages. This does not
revoke the app at Shopee itself (remove it under Seller Centre if you want
that too) and does not delete packing-video files. To undo, stop the server
(`sudo systemctl stop kelper`), copy the backup over
`kelper.production.db`, then start it again (`sudo systemctl start kelper`).

## Backups in Google Cloud Storage

Save a backup (safe while the server is running):
```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/backup.js save
```
Add a label if you like: `... backup.js save before-go-live`. The backup is
compressed and uploaded to the bucket under `backups/production/`.

List the backups (the last one is the newest):
```bash
NODE_ENV=production node scripts/backup.js list
```

Restore a backup — **replaces the current database**:
```bash
NODE_ENV=production node scripts/backup.js load latest
```
or `load <name>` with a name from `list`. It checks the backup is healthy,
shows what is inside it versus what is there now, saves a safety copy of the
current database to `kelper-backend/backups/`, asks you to type `RESTORE`,
then stops the server, swaps the database and starts the server again.
Everything saved after that backup was taken is lost. Reload the Dashboard
and Packing Station pages afterwards, then check `fetch-lock.js status`.

`load` also accepts a local file, e.g. the copy `reset-all.js` saved:
`NODE_ENV=production node scripts/backup.js load backups/<file>.db`.

If Google says "no permission": in Google Cloud Console open the bucket >
Permissions and give the VM's service account the role **Storage Object
User** (it must be able to write, list and read). Backups contain the Shopee
tokens, so keep that bucket folder private.

## Release an order stuck in Masalah because booking failed

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/release-exception.js <order_sn> [<order_sn> ...]
```
For an order that landed in Orderan Bermasalah only because booking with
Shopee kept failing (the reason on the card reads like a Shopee error, and
the station shows "SYSTEM / Auto (Booking Gagal)"). Run it **after** the cause
is fixed; the order goes back to the queue and booking is retried on the next
tick. It refuses on purpose if an operator already worked on the order
(releasing could lose scan records), if it has scan records, or if the order
is cancelled, and tells you why.

## Check Biaya Iklan (ad spend)

```bash
cd /opt/kelper/kelper-backend
NODE_ENV=production node scripts/check-ads.js
```
Prints what the Dashboard has stored for the last 7 days (and the tax % it
adds), then pulls today's spend live from Shopee, hour by hour, so you can
compare the two. Read-only.

```bash
NODE_ENV=production node scripts/check-ads.js 02-10-2026   # another date (DD-MM-YYYY)
NODE_ENV=production node scripts/check-ads.js --stored     # stored values only, no Shopee call
```
If it says the access token has expired, wait a minute (the server renews it)
and run it again.

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
sudo journalctl -u kelper --since "10 min ago" --no-pager | grep -E "callback landed|auth exchange"
```
Shows every Shopee connection attempt: what the redirect brought back
(parameter names only), and whether the token exchange was refused,
failed, or connected. Never prints the code or any token. Use this right
after someone authorizes a shop and it doesn't seem to connect.

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

Do these in order. Both apps (main + the Affiliate / AMS app) share one `AUTH_BASE` and
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
SHOPEE_BRAND_PARTNER_ID=<AMS app LIVE Partner ID>
SHOPEE_BRAND_PARTNER_KEY=<AMS app LIVE Key>
SHOPEE_AUTH_BASE=https://partner.shopeemobile.com/api/v2/shop/auth_partner
SHOPEE_API_BASE=https://partner.shopeemobile.com
```
Leave `SHOPEE_REDIRECT_URI`, `SHOPEE_BRAND_REDIRECT_URI` and
`SHOPEE_PUSH_CALLBACK_URL` alone (they're `dashboard.kelper.co.id` URLs and
don't change between sandbox and live).

**The Affiliasi numbers come from Shopee's AMS API** (Affiliate Marketing Solution
Management), not the Brand Portal (changed 2026-10-12). The `SHOPEE_BRAND_*` lines
above are now the credentials of that app: create an app of type **Affiliate
Marketing Solution Management** in the Shopee Open Platform Console and put its
Live Partner ID and Key there. It is authorized like any shop (seller login), so
**remove** these two lines from `.env.production` if they are still there, they
were only for the Brand Portal login:
```
SHOPEE_BRAND_AUTH_BASE=...
SHOPEE_BRAND_AUTH_TYPE=principal
```
Then restart (step 3) and press **Hubungkan** next to "Affiliate (AMS)" in
Pengaturan. The Affiliasi card then fills in by itself: within a few minutes the
server fetches yesterday and every missing day back 30 days (one day at a time,
newest first; a day Shopee refuses is not asked again for 30 minutes). Later it
fetches each new day once.

**Page View** (the old Pengunjung card) does not use the AMS app at all: it reads each
item's view counter from Shopee's get_item_extra_info with the MAIN shop connection,
about every 30 minutes, and shows the difference per day (today = since 00:00). It
counts page views, not unique visitors. It starts from zero when first deployed, so
the first figures appear straight away for today and days before the deploy stay empty.

**3. Restart**, then reconnect both apps from Dashboard -> Pengaturan:
```bash
sudo systemctl restart kelper
```
Old sandbox tokens stop working against the live host, so you will see
`Invalid access_token` lines in the logs until you reconnect — expected.

**4. Reconnect** the main app and Affiliate / AMS (Hubungkan) in Pengaturan.
The newest connection becomes the active shop automatically.

If the Shopee page that opens shows an error instead of a login:
- `Wrong sign` -> the Partner Key doesn't match that Partner ID. Usual causes:
  the *Test* Key was pasted instead of the *Live* Key, the main/Brand keys got
  swapped, or a stray space/newline got copied into `.env.production`.
- `no timestamp` -> the code on the VM is older than the signed-link fix;
  run the deploy command first.

**5. Only when packing stations are ready**, unlock fetching:
```bash
NODE_ENV=production node scripts/fetch-lock.js unlock
```
