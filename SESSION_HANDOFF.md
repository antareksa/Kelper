# KELPER — Session Handoff (2026-09-27)

Context for a new Claude Code session picking up where this one left off. This project is a Shopee marketplace ops tool: a Dashboard (admin web app) + Packing Station (physical scan-only stations). All commits below are pushed to both `dev` and `main` on GitHub, up to `3ec185d`.

## What this session built/fixed

1. **New "Order" menu** (Dashboard) — a plain search-by-order_sn lookup, DB-only (no live Shopee calls). Commit `1f23050`.
   - Backend: `kelper-backend/src/routes/orders.js` — `GET /orders/search?order_sn=...`
   - Frontend: `kelper-frontend/src/OrderSearch.jsx`, wired into `Dashboard.jsx`

2. **Fixed inconsistent shipping label layouts across couriers** — real root cause found and fixed (see "Key Shopee API findings" below). Went through several iterations:
   - `2c3263c` — first attempt: force `THERMAL_AIR_WAYBILL` via `get_shipping_document_parameter`. This broke booking for some couriers (see next fixes).
   - `d0836da` — reverted the forcing to unblock booking while investigating.
   - `9ebb37e` — **final fix**: always create `NORMAL_AIR_WAYBILL` first (bootstrap), then `THERMAL_AIR_WAYBILL` on top of that. Confirmed working live on real orders.

3. **Orders no longer get stuck retrying booking forever** — `879c276`, `e8fa591`.
   - `orders.booking_fail_count` / `booking_last_error` track consecutive failures.
   - After `config.shipping.maxBookingFailures` (default 5) failures, the order is auto-flagged to **Masalah** (Problem Order) with the real error recorded in a new `packing_sessions.exception_reason` column — visible in the Cancel & Masalah list and the Order Detail popup — instead of retrying silently forever.
   - `documentPoll` widened from 5×1s to 15×2s in all three `config*.json` files (the actual bug was elsewhere, but this was a genuine improvement too).

4. **Recovery for couriers that auto-arrange their own package** — `48f819b`. Some couriers (SPX Instant) get Shopee to auto-create the logistics request before `ship_order` is ever called, which then rejects with "Package is not ready to ship" (a message not covered by the two already-known "already booked" patterns). Now recovers via `get_order_detail`'s `package_list` instead of retrying forever.

5. Small polish: `OrderSearch.jsx` now translates the `DONE` status and doesn't show it twice (`3ec185d`).

## Key Shopee API findings (worth knowing before touching shipping/booking code again)

- **`create_shipping_document` sequencing rule**: for at least `SPX Instant` / `SPX Instant Prioritas` (logistics_channel_id `80054`), requesting `THERMAL_AIR_WAYBILL` as the *first* document for a tracking number silently never completes (`get_shipping_document_result` returns no `result_list` entry at all, for the full poll window). The real error only shows up if you read the raw response: `logistics.shipping_document_should_print_first` — "please create shipping document first". Fix: always create `NORMAL_AIR_WAYBILL` first (succeeds in ~2s), *then* `THERMAL_AIR_WAYBILL` works immediately after. This is implemented in `kelper-backend/src/shopee/shipping.js`'s `pollTrackingAndDocument`/`createAndAwaitDocument`.
- **`get_shipping_document_parameter`'s `selectable_shipping_document_type` list cannot be trusted** — it claimed `THERMAL_AIR_WAYBILL` was selectable for channel `80054` and was wrong (see above). Don't gate logic on it.
- **`download_shipping_document` needs an explicit `shipping_document_type`** param (top-level, not per order_list entry) to unambiguously fetch the document you actually want, once more than one type may have been generated for the same tracking number.
- All of this was diagnosed with real production API calls via one-off `node -e` scripts on the VM — remember `NODE_ENV=production` and `require('dotenv').config({ path: '.env.production' })` are both required for such scripts to pick up real credentials (the DB filename and env vars are both `NODE_ENV`-dependent — see `kelper-backend/src/db.js` and `server.js`).

## Outstanding / pending

- **3 test orders stuck in Masalah** from before the fix landed (won't self-heal — they now have a session, so auto-retry skips them by design): `2609276C1HEXEC`, `2609276E4SW3U8`, `2609276EPYMW0W`. Need manual resolution from the Cancel & Masalah screen, or ask for a one-off script to re-run booking on just these three.
- Confirm a handful of **real** (non-test) orders continue booking cleanly post-deploy, across different couriers.
- **Webcam/video evidence feature** (client-requested, for packing dispute evidence) — still purely in the cost/design discussion phase, nothing built. Confirmed: hybrid local (7-day) + GCS Nearline cloud (30-day) retention plan, real per-GB cost tables computed, JETE W9 webcam picked as candidate hardware (~Rp 200k/unit). Unresolved: how a browser silently writes video to a local folder without a repeated Save-As dialog.
- **Database off-VM backup** — costed (GCS, negligible — cents/month) but never actually decided or built.

## Deploy command (always ask the user to run this themselves — never attempt directly)

```powershell
ssh -i "$env:USERPROFILE\.ssh\kelper_vm" dihyanfr32@34.101.58.69 "cd /opt/kelper && git pull && bash deploy/setup-vm.sh"
```

Deploys are manual (no auto-deploy timer). The script does NOT `git pull` itself — that must precede it, as shown above.

## Conventions this session learned/confirmed

- **Never say "kiosk"** in conversation — say "Packing Station" (code comments/flags like `--kiosk-printing` are fine).
- **Never SSH into the VM to run destructive/production actions directly** — give the user the exact command to run themselves. Read-only diagnostic one-off scripts have been acceptable when the user asks for them explicitly.
- Git workflow: commit+push to `dev`, then fast-forward-merge and push `main` too — the VM deploys from `main`, so skipping this means the deploy pulls nothing new.
- User likes live log watching via the Monitor tool (`journalctl -u kelper -f` over SSH, filtered with grep) rather than polling after the fact.
- The Partner app is still in Shopee's "Developing"/sandbox review status — push notifications don't reliably fire for real orders yet; the 30s poll loop is the real sync mechanism.

## Useful reference: systemd service / paths on the VM

- Service: `kelper` (`sudo systemctl status/restart kelper`, `sudo systemctl cat kelper` for the unit file)
- App directory: `/opt/kelper/kelper-backend`
- DB file: `kelper.production.db` (NOT `kelper.db` — filename is `kelper.${NODE_ENV}.db`)
- Config: `config.production.json` (explicit values here override `config.js`'s `DEFAULTS` entirely per key — a past bug in this session was editing `DEFAULTS` and assuming it took effect, when `config.production.json` already had its own explicit override)
