# KELPER — Session Handoff (2026-10-16)

Context for a new Claude Code session picking up where the last one left off. KELPER is a Shopee marketplace ops tool: a Dashboard (admin web app) + Packing Station (physical scan-only stations). Backend `kelper-backend` (Node/Express/SQLite), frontend `kelper-frontend` (React/Vite). The user manages everything from Bandung; the Packing Station PCs are in Jakarta.

**Git state at the time of writing:** `dev` and `main` are at the same commit (`d80ea91`), everything below is pushed to both. **What is deployed on the VM is NOT known** — the user deploys by hand, so ask. Do not assume the VM runs this code.

## What's new since 2026-10-14 (not yet folded into the sections below)

- **GMS ROAS auto-adjust is now implemented** (`roasAuto.js`, `catalogSync.js`, `routes/ads.js`, `IklanRoas.jsx`), built by a different session than the one that wrote the rest of this doc — see `docs/FEATURE-gms-roas-auto-adjust.md` for the design background. **Not reviewed or tested by the session that wrote this update** — read the code fresh before relying on it or telling the client it works.
- **Packing Station**: instant orders now have their own delay setting, `instantOrderDelayMinutes` (`packingSettings.js`, "Delay Instant (menit)" in the settings panel), separate from the normal `orderDelayMinutes` (both default 60). Reason: some instant couriers (confirmed for SPX Instant Prioritas) auto-arrange the real pickup with Shopee the moment the order is placed — see `shopee/shipping.js`'s "already auto-arranged by courier" handling — so holding them to the normal 60-minute buyer-cancellation delay meant the courier could show up before KELPER had even booked/labeled the order. Every place that read `getOrderDelaySeconds()` (booking in `shopeeSync.js`, the bucket logic and `/order-lists` in `routes/packing.js`) now branches on `is_instant`.
- **Dashboard**: new **Laba Bersih** KPI = `Laba Kotor − Iklan − Layanan − Biaya Pesanan − Affiliasi`. The Affiliasi deduction needed a real cost figure that didn't exist: Shopee's `get_affiliate_performance` already returns `est_commission` per affiliate, but `fetchAffiliatePerformance` only summed `sales`/`orders`/`total_buyers` and discarded it. Added a `commission` column to `affiliate_performance_daily`, now summed and surfaced; the Affiliasi panel (Profit Funnel) and Cost Breakdown show that commission instead of `salesConfirmed` (which was attributed revenue, not a cost, and already counted inside Omzet/Laba Kotor — showing it there double-counted). Historical days fetched before this change have no commission figure (shows "Belum tersedia").
  - Missing Iklan or Affiliasi commission for a day is treated as 0 in the Laba Bersih math (not blocking), same tradeoff Cost Breakdown already made — so it can briefly understate costs right after a fetch hasn't run yet.
- **Bug fix, real one**: Layanan and Biaya Pesanan have been stuck at 0 on the Dashboard for every order, always — not a data-not-ready issue. `fillMissingIncomeData` (fetches Shopee's real escrow data into `order_income`, the only source for these two numbers) filtered on `orders.status = 'READY_FOR_PICKUP'`, a string that is **only ever a `packing_sessions.status` value** — `orders.status` itself goes straight from `READY_TO_PACK`/`DEFERRED`/`LOCKED` to `DONE` once Shipping Mode confirms pickup, never through `'READY_FOR_PICKUP'`. So the query never matched a single order, ever. Fixed to filter on `'DONE'`. **Caveat for whoever deploys this**: the very first sync tick afterward will find every historical `DONE` order with no `order_income` row as newly "pending" and fetch escrow for all of them, one at a time, no batching — expect a burst of `get_escrow_detail` calls right after redeploy, and some may fail for very old orders if Shopee no longer retains escrow data that far back (logged as a warning, retried forever on an in-memory basis — nothing marks a failure as permanent).
- **Open, not yet root-caused**: Affiliasi was reported missing for 15 Oct on the live Dashboard. Likely cause is an AMS connectivity/permission issue (check `GET /auth/brand/check?shop_id=` on the live server, or grep the server log for `Affiliasi fetch failed` / `get_affiliate_performance failed`) — not confirmed yet, no server/log access from the session that found this.

Also read the auto-memory notes for this project (`MEMORY.md` index): they hold the user's working preferences and a few pending items.

## What exists now (2026-10-02 to 2026-10-14), by area

**Packing Station**
- *Station identity = the operator who logs in* (not a station name): `routes/operators.js` `/lookup` gives `OPR-<id>`; the same operator on a second PC is refused (409 `operator_in_use`); heartbeat every 30 s, a dead station is checked out after 180 s and its order released (`stationPresence.js`, `sessionRelease.js`); 10 min idle logout in `PackingStation.jsx`. This fixed "different operators got the same order".
- *Work hour* (`packingSettings.js`, default 08–16 WIB): nothing is booked with Shopee outside it, **instant orders included**; instant orders are held in the Waiting List after hours; normal orders can still be packed after hours with a temp barcode ("Pack Besok").
- *Pack Besok + Print Resi Mode*: after hours a packed order gets a temp barcode, the station waits for it to be scanned back (`/confirm-besok`); next morning `bookDeferredOrders` books the real resi and **Print Resi Mode** (`/besok-list`, `/print-resi`) prints it when the temp barcode is scanned.
- *Temp label is 33 x 15 mm* (`besokLabel.js`, `Barcode.jsx` `code128Modules`, `newBesokCode` in `routes/packing.js`): Code 128, code = `B` + 8 digits, shown as "BESOK 12345678". Old `BESOK-XXXXXXXX` boxes still work (every lookup compares the stored value).
- *Order priority* (`priorityOrder.js`, used by `/next-order`, booking and the Siap Dicek list): instant → expedition on the **Prioritas Ekspedisi** setting (Dashboard → Packing Station; empty today, the client has not named them) → fewer pieces to scan (bundle = its parts) → oldest.
- *"Maks Siap Dicek" cap also holds after hours* (`afterHoursFreshAllowed`): overflow waits in the Waiting List.
- *Shipping Mode*: lists every package ready for the courier from any station; scanning an already picked-up resi answers "SUDAH DI-SCAN / SUDAH DIPICKUP …" (409, `pickupRefusal`); **stock goes down at the pickup scan** (`confirmOrderPickedUp`), not per item scan; a **bundle takes down its own stock only**, never its parts'.
- *Sounds* (`carrierSpeech.js`, files in `kelper-frontend/public/sounds/`, README there): Shipping Mode plays the expedition's file on a pickup, `start_packing` on the scan that completes an order, `wrong_item` on a wrong/over-scanned item. Files provided so far: `spx`, `jnt`, `jne`, `sicepat`, `instant`, `start_packing`, `wrong_item` (`.mp4` audio). A missing file falls back to the PC's own voice.
- *Bundles are packed by scanning their parts* (`packingItems.js` `expandPackingItems`); a bundle with no contents on file still scans by its own SKU.
- *`SHUTDOWN_PC` command barcode*: scan twice within 10 s, never refused for an order in progress (logout hands the order back). Needs `enable-shutdown-barcode.reg` applied ONCE per PC (registers `kelper-shutdown://`, a Chrome policy for the origin, Fast Startup off). Never tested on a real PC.
- Launchers: `start-packing-station.bat` and the quick one; **never ask the user to edit launchers or PCs** (see conventions); the `.reg` files are the opt-in exception.

**Dashboard / data**
- *Roles*: `admin` and `packing` (Packing Station admin: Order + Packing Station Dashboard + stock-only List Barang). `adminSession.js` holds the allow-list.
- *List Barang* (`ListBarang.jsx`, `routes/products.js`): one **Item Data** upload (`/products/import-item-data`: `SKU | Nama Item | GTIN | HPP | Harga | Item Bundle? | List Item (GTIN)`; GTIN = barcode; Harga is the dashboard's own price), one **Item Stok** upload (`/products/import-stock`: `SKU | Stok`, new format only), **Unduh Daftar Item** (Shopee item list with SKUs as Excel), a **Stock** column (our own stock), HABIS tag follows OUR stock. Bundle contents are edited in the bundle's expanded row (`BundleContents.jsx`, `PUT /bundles/:sku/items`); there is no List Bundle page any more.
- *Affiliasi* comes from Shopee's **AMS** `get_affiliate_performance` (`shopee/amsClient.js`, `fetchAffiliatePerformance`): sums all affiliates' pages for one day, fetches yesterday plus any missing day back 30 days, a refused day is not retried for 30 min. It runs on the "second Shopee app" (`SHOPEE_BRAND_*` env, `shopee_brand_tokens`, `/auth/brand/*`): the names are old, **it is now the AMS app, not the Brand Portal**. The Brand Portal code is gone.
- *Page View* card (replaced Pengunjung): `fetchPageViews` reads each cached item's running `views` from `get_item_extra_info` with the MAIN shop token about every 30 min into `item_views`; the day's figure is a difference of readings (`pageViewsFor` in `routes/dashboard.js`). It counts page views, not unique visitors.
- The Dashboard shows a day if it has completed orders OR an Affiliasi / Iklan / Page View figure; only a day with none says "Data tidak tersedia". Orders count on the day they are scanned picked up (`DASHBOARD_DATA_SOURCE` 'internal').
- Fetching lock (`syncEnabled`) stops order pulling, booking, cancel detection and income fill; it does NOT stop Affiliasi, Iklan or Page View.

**SSH scripts** (all documented in `deploy/SSH-CHEATSHEET.md`; the user runs them on the VM): `fetch-lock.js lock | unlock [n] | status` (`unlock 5` lets 5 new orders in, then locks again; already-fetched orders keep being booked), `reset-all.js` (asks for `RESET`, backs up first; `--keep-staff --keep-products --keep-settings --keep-shopee --keep-items --yes`; admin accounts always kept; ends with fetching locked), `backup.js save | list | load <name|latest>` (Google Cloud Storage, needs the VM service account to have *Storage Object User* on the bucket), `reset-shop-data.js <shop_id>`, `check-ads.js`, `manage-admin.js`, `release-exception.js`.

**Docs**: `deploy/SSH-CHEATSHEET.md` (VM commands, the sandbox→live switch, the AMS env steps), `deploy/PACKING-STATION-PC-SETUP.md` (PC setup, launchers, modes, sounds, the 33x15 label, the shutdown barcode).

## Open items (as of 2026-10-14)

1. **VM: deploy the latest and set up the AMS app.** Create a Shopee app of type *Affiliate Marketing Solution Management*, put its Live Partner ID/Key in `SHOPEE_BRAND_PARTNER_ID/KEY` in `.env.production`, **remove** `SHOPEE_BRAND_AUTH_BASE` and `SHOPEE_BRAND_AUTH_TYPE=principal`, restart, press **Hubungkan** next to "Affiliate (AMS)" in Pengaturan. Unconfirmed whether it has been done; the AMS permission and the Page View counter semantics (assumed a lifetime total) are unverified against real data. Brand Portal authorization never worked and is abandoned.
2. **33 x 15 mm temp label printing**: works. The app's label printed fine on the dev PC's 4BARCODE 4B-2054L (2026-10-14) once that driver had a 33 x 15 mm paper size ("Small Label", now its default). The first test had been cut off because that size did not exist yet. Print settings are only `@page { size: 33mm 15mm; margin: 0 }` (no X/Y offset, no scale), so it prints right only where the driver has a matching paper size. Still to do: try the **client's printer**. Still open: is it a different printer from the 100x120 shipping label? The station prints to the Windows **default printer** only. If a client printer shifts it, offer an X/Y offset setting in mm.
3. **Expedition priority**: the client has to name the expeditions (setting is empty).
4. **Sound files still missing**: `anteraja`, `ninja`, `idexpress`, `lion`, `pos`, `tiki`, `wahana`, `unknown` (voice fallback meanwhile).
5. **`SHUTDOWN_PC`** needs the `.reg` on each PC (a visit, or a remote tool; the user has not said if one exists). Same question for Windows auto sign-in after a power-button start. Neither answered.
6. **Reminders from memory** (raise at a natural pause, build nothing until answered): *order filter rules* (needs the user's rules) and *duplicate resi* (user forgot the issue; candidate: combined shipments sharing a resi → `ambiguous_label` in `/confirm-pickup`).
7. **Bundles with no contents on file (10)**: `KELPER-08, -09, -10, -11, -13, -14, -18, -19, -21, -25`. Contents can be edited in List Barang or sent in the Item Data file. Until then they scan as one line by their own SKU.
8. **Item Data / Item Stok files** were generated into `E:\Download` (`Item Data (with SKU + Harga).xlsx`, `Item Stok (from STOKAN 021026).xlsx`). Notes: Harga there is Shopee's listed price (looks high; `KEL-39` is 451,143 against HPP 15,305, worth a check); `KEL-47` (PVA Mop) is missing a GTIN (barcode row `8894450940301` was skipped, prefix looks like a typo) and its stock 118 was inferred; the Handle+Sponge bundle's SKU is `KELPER 22` with a space.
9. **OpenLabel+** (a label design app): the user was evaluating it; undecided whether the app should print through it. Nothing built.
10. **Webcam/video evidence feature**: design/cost phase only, nothing built (hybrid local 7-day + GCS Nearline 30-day, JETE W9 webcam candidate; unresolved how a browser silently writes video to a local folder).
11. **Off-VM database backup** is now built (`backup.js`) but nobody has run a first `save` yet; check the bucket permission.
12. From 2026-09-27: 3 test orders stuck in Masalah (`2609276C1HEXEC`, `2609276E4SW3U8`, `2609276EPYMW0W`); probably stale, check before acting.
13. **Review/test the GMS ROAS auto-adjust implementation** (`roasAuto.js`, `catalogSync.js`, `routes/ads.js`, `IklanRoas.jsx`) — built by a different session, never reviewed by the one that wrote this handoff entry. Confirm it matches `docs/FEATURE-gms-roas-auto-adjust.md`'s settled decisions (floor 1 / ceiling 10, edit-only, per-item) before telling the client it's live.
14. **Confirm Layanan/Biaya Pesanan actually populate after the `fillMissingIncomeData` fix + redeploy.** Watch the first sync tick for a burst of `get_escrow_detail` calls (the historical backlog, see above) and check the server log for repeated failures on very old orders.
15. **Root-cause the missing Affiliasi data for 15 Oct** (see above) — check `/auth/brand/check?shop_id=` and the server log; AMS token/permission is the likely suspect.

## Key Shopee API findings (worth knowing before touching shipping/booking code again)

- **`create_shipping_document` sequencing rule**: for at least `SPX Instant` / `SPX Instant Prioritas` (logistics_channel_id `80054`), requesting `THERMAL_AIR_WAYBILL` as the *first* document for a tracking number silently never completes (`get_shipping_document_result` returns no `result_list` entry at all, for the full poll window). The real error only shows up if you read the raw response: `logistics.shipping_document_should_print_first` — "please create shipping document first". Fix: always create `NORMAL_AIR_WAYBILL` first (succeeds in ~2s), *then* `THERMAL_AIR_WAYBILL` works immediately after. This is implemented in `kelper-backend/src/shopee/shipping.js`'s `pollTrackingAndDocument`/`createAndAwaitDocument`.
- **`get_shipping_document_parameter`'s `selectable_shipping_document_type` list cannot be trusted** — it claimed `THERMAL_AIR_WAYBILL` was selectable for channel `80054` and was wrong (see above). Don't gate logic on it.
- **`download_shipping_document` needs an explicit `shipping_document_type`** param (top-level, not per order_list entry) to unambiguously fetch the document you actually want, once more than one type may have been generated for the same tracking number.
- All of this was diagnosed with real production API calls via one-off `node -e` scripts on the VM — remember `NODE_ENV=production` and `require('dotenv').config({ path: '.env.production' })` are both required for such scripts to pick up real credentials (the DB filename and env vars are both `NODE_ENV`-dependent — see `kelper-backend/src/db.js` and `server.js`).
- Some couriers (SPX Instant) get Shopee to auto-create the logistics request before `ship_order` is ever called, which then rejects with "Package is not ready to ship"; recovered via `get_order_detail`'s `package_list`.
- After `config.shipping.maxBookingFailures` (5) consecutive booking failures lasting at least 10 minutes an order is flagged to **Masalah** with the real error in `packing_sessions.exception_reason`.
- The Partner app was in Shopee's "Developing"/sandbox review status at the time: push notifications did not reliably fire for real orders; the 5 s poll loop is the real sync mechanism.

## Deploy (the user runs this THEMSELVES, typed on the VM in their own SSH session)

```bash
cd /opt/kelper && git pull && bash deploy/setup-vm.sh
```

Give plain commands to type ON the VM. **Never** wrap them in an `ssh -i ...` line (the user has corrected this three times). Deploys are manual (no auto-deploy timer). The script does NOT `git pull` itself, so the `git pull` must come first. Station pages need a reload after a deploy; new sound files and `.reg` changes need their own steps.

## Conventions (what the user has asked for)

- **Never say "kiosk"** in conversation: say "Packing Station" (code comments and the `--kiosk-printing` flag are fine).
- **Never require changes on the station PCs or launcher `.bat` files** as part of a fix: the PCs are in Jakarta. Keep fixes server/web-side and backward compatible with the installed launchers. The only exceptions are the opt-in `.reg` files (`enable-silent-printing.reg`, `enable-shutdown-barcode.reg`) the user chose to apply.
- **The user runs VM deploys, edits and destructive commands themselves**; never ask them to paste secrets (keys, passwords) into the chat. Read-only diagnostic one-off scripts are fine when asked.
- **Git flow**: commit to `dev`, push, then `git checkout main && git merge --ff-only dev && git push origin main && git checkout dev` (the VM deploys from `main`). End commit messages with the attribution line the harness gives.
- "Monitor"/"watch" means live log tailing with the Monitor tool (`journalctl -u kelper -f`), not polling after the fact.
- "DONT CHANGE ANYTHING just answer first" means answer only.
- Answer questions before building; confirm the real, deployed state before claiming something is "fixed" (say it is fixed in the repo, and that the VM needs the deploy).

## Working on this repo (dev environment)

- Dev servers: `.claude/launch.json` (`kelper-backend` on 3001, `kelper-frontend` on 5173). The backend does NOT reload on edits: restart it after changing backend code. The dev database is `kelper.development.db` (a Shopee **sandbox** shop with a few test items).
- The tests used so far were throw-away scripts in the session scratchpad (outside the repo, not committed). Patterns that worked: HTTP tests against the dev server with synthetic orders (use `261012...`-style order numbers, not `MOCK-` which a purge deletes, and a separate shop id), in-process tests with a stubbed Shopee client / global `fetch` / token store, minting an admin token with `createSession(role, username)` from `src/adminSession.js`, and cleaning every row afterwards.
- In the browser pane: stub `speechSynthesis`/`Audio.play`/the print iframe's `print` instead of really playing or printing; the pane runs on UTC, so its "today" can be a day behind Jakarta's.
- Do not print real labels or change the Windows default printer without the user saying so.

## Useful reference: systemd service / paths on the VM

- Service: `kelper` (`sudo systemctl status/restart kelper`, `sudo systemctl cat kelper` for the unit file)
- App directory: `/opt/kelper/kelper-backend`
- DB file: `kelper.production.db` (NOT `kelper.db` — filename is `kelper.${NODE_ENV}.db`)
- Config: `config.production.json` (explicit values here override `config.js`'s `DEFAULTS` entirely per key — a past bug was editing `DEFAULTS` and assuming it took effect, when `config.production.json` already had its own explicit override)
- Backups folder: `kelper-backend/backups/` (safety copies written by `reset-all.js` and `backup.js load`)
