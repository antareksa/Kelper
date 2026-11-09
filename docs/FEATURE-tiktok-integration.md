# Feature: TikTok Shop Integration

**Status (2026-11-03):** Staging is **live** (Part 1, on the same VM, following the `dev-staging` branch). TikTok's API model has been read from the official spec (see "TikTok Shop API findings" below). **No TikTok application code yet**; that waits for the open questions and the Partner Center sandbox credentials.

## Client requirement (as given)

> Implement TikTok orders into the app, the same way Shopee orders are handled — one app, handling orders from both the Shopee shop and the TikTok shop together (confirmed: unified, not two separate systems).

## The constraint that shapes everything below

KELPER is **live in production right now**, actively used by the client to pack and ship real Shopee orders every day. Nothing about building TikTok support may touch that — not the real database, not the real Packing Station queue staff are working from, not the real Shopee credentials/tokens. This is the reason every piece of the plan below is additive/parallel rather than modifying existing code in place.

## Part 1 — A separate staging environment (build/test TikTok here, not on production)

TikTok's OAuth connect flow and (likely) webhooks need a real, publicly reachable HTTPS domain — a local dev machine or this cloud session can't receive those callbacks. So testing has to happen on a VM, the same way Shopee's own sandbox→live testing originally did (`deploy/SSH-CHEATSHEET.md`'s "Switch both Shopee apps from sandbox to LIVE" section). But testing on the **real** production VM/database risks TikTok sandbox test orders showing up in the real, staff-facing Packing Station queue — unacceptable given the app is actively in use.

**Decision: a second, fully separate deployment ("staging"), not a mode flag on the existing one.**

- Separate directory on the VM: `/opt/kelper-staging` (a second `git clone` of this same repo), not a switch inside `/opt/kelper`.
- Separate systemd service: `kelper-staging` (new, alongside the existing `kelper` service — doesn't touch it), listening on **port 3002** (the app already supports `PORT` as an env var; 3001 stays the real one).
- Separate database: happens automatically — `db.js` opens `kelper.${NODE_ENV}.db` relative to wherever the app is running from, so a second checkout directory gets its own separate SQLite file with zero code changes.
- Separate config/credentials: its own `.env.production` (written by `setup-staging.sh`: a staging admin login only, later TikTok **sandbox** credentials; never real Shopee or live TikTok keys). `config.production.json` is shared through git, so anything that must differ goes in a gitignored `kelper-backend/config.local.json` (also written by the setup script): `instanceName: "staging"` (backup.js then uses the `kelper-staging` service and `backups/staging/`, never production's backup folder) and `evidence.gcsEnabled: false` (no uploads into the real video bucket).
- Runs with `NODE_ENV=production` (not `development`) — this project's `env.js` only recognizes those two values, and staging should behave exactly like production code-wise. The isolation comes entirely from being a different directory/service/port, not from a different `NODE_ENV` string.
- Separate domains, same split as production: `dashboard.staging.kelper.co.id` and `packing.staging.kelper.co.id` (App.jsx picks the view from the `dashboard`/`packing` hostname prefix), proxied by the VM's existing Caddy to `localhost:3002`. Added with `deploy/add-staging-https.sh`, which only **appends** one block (backup first, validate, restore the backup on failure, `reload` not `restart`). Never use `deploy/setup-https.sh` for this: it overwrites the whole Caddyfile and would drop the live `dashboard.kelper.co.id`/`packing.kelper.co.id` sites.

**Files status (2026-11-02):** `deploy/kelper-staging.service`, `deploy/setup-staging.sh` (refuses to run from `/opt/kelper`, refuses if port 3002 is taken by something else) and `deploy/add-staging-https.sh` are all written; not yet run on the VM.

**Blocked on (only the user can provide):**
- DNS A records for `dashboard.staging.kelper.co.id` and `packing.staging.kelper.co.id` pointed at the VM.

## Part 2 — Application architecture for the TikTok integration itself

Not started. Planned shape, so Shopee code paths are never touched:

- **New `kelper-backend/src/tiktok/` folder**, mirroring `src/shopee/` (client, auth, shipping) — no shared code with Shopee's modules at first.
- **New `platform` column** on `orders` (and anywhere else it matters), `ALTER TABLE ... ADD COLUMN platform TEXT NOT NULL DEFAULT 'shopee'` — the same non-destructive migration pattern used everywhere else in `db.js`. Every existing row/query that doesn't know about `platform` keeps working unchanged.
- **Orders keyed by `(platform, shop_id)`**, not `shop_id` alone — Shopee and TikTok shop IDs are separate namespaces and could collide.
- **New, independent `tiktokSync.js`** sync loop, separate from `shopeeSync.js`'s `discoveryLoop`/`enrichmentLoop` — a TikTok-side bug or outage can't affect Shopee sync, and vice versa.
- **A `tiktokEnabled` setting, default OFF** (or simply: no TikTok app connected yet) — so this code can be merged to `main` and deployed to the real production VM at any point during development with zero behavior change, same principle as every other new setting this session (always defaults to "preserve current behavior").
- **Packing Station / Dashboard generalization — the genuinely open part.** `resolveOrderBucket`, priority ordering, and the Omzet/Laba math all currently assume Shopee-shaped data (logistics channels, escrow/income fields, Shopee's own order status values). Before touching any of that code, we need TikTok Shop's actual order/shipping/financial model — which requires TikTok Shop Partner Center access and their API docs. Unknown right now, not guessed at.

**Blocked on (only the user can provide):**
- TikTok Shop Partner Center account + app registration (sandbox App Key/Secret) — TikTok's equivalent of Shopee's Open Platform signup.
- ~~TikTok Shop API documentation~~ — done 2026-11-03, see the next section.

## TikTok Shop API findings (2026-11-03)

Source: the official TikTok Shop OpenAPI spec bundled with TikTok's `tts-open-toolkit` (snapshot, 405 endpoints). Versions below are the newest in that snapshot; **re-check each one on Partner Center docv2 before coding** (`https://partner.tiktokshop.com/docv2`), the snapshot may lag. Nothing here has been tried against a real shop yet.

### Login (OAuth) and request basics
- Seller authorizes the app in TikTok's page → our redirect URL gets an `auth_code` → exchange it for `access_token` + `refresh_token`. **The token exchange/refresh endpoints are NOT in the bundled spec** (they live on TikTok's separate auth host); take them from docv2's "Authorization" guide.
- After login: `GET /authorization/202309/shops` returns the authorized shops: `id`, `name`, `code`, `region`, and **`cipher`**. Every shop-level call needs `shop_cipher` (query) + header `x-tts-access-token`. Also common query params `app_key`, `timestamp`, `sign` (HMAC-SHA256 with the App Secret; exact recipe from docv2's "Sign your API request", not in the spec).
- Webhooks: `PUT /event/202309/webhooks` registers a URL per `event_type`; the one we need is **`ORDER_STATUS_CHANGE`** (fires on every status change, like Shopee push). Can start with polling only, same as Shopee's `discoveryLoop`.

### Orders
- List: `POST /order/202309/orders/search` — filter by `order_status`, `create_time_ge/lt`, `update_time_ge/lt`; `page_size` ≤ 100 with `page_token` paging. Detail: `GET /order/202507/orders?ids=` (≤ 50 per call).
- **Status values:** `UNPAID` → `ON_HOLD` → `AWAITING_SHIPMENT` → (`PARTIALLY_SHIPPING`) → `AWAITING_COLLECTION` → `IN_TRANSIT` → `DELIVERED` → `COMPLETED`; or `CANCELLED`. Plus `is_buyer_request_cancel` (buyer asked to cancel, pending).
  - `ON_HOLD` = "buyer may still cancel without the seller's approval". It's TikTok's own built-in cancellation window, i.e. the same idea as KELPER's order delay.
- Deadlines on the order: `rts_sla_time` (latest ship time), `shipping_due_time` (auto-cancel if not `AWAITING_COLLECTION` by then), `collection_due_time` (auto-cancel if not `IN_TRANSIT` by then), `pick_up_cut_off_time` (SEA).
- **Items: there is no `quantity` field on `line_items`.** TikTok returns one line item per unit, so 3 × the same SKU = 3 line items; KELPER must group by `sku_id` / `seller_sku` to get `qty`. `seller_sku` is the merchant's own SKU code (= what KELPER's catalog/barcodes use). Virtual bundles come with `combined_listing_skus`.
- Indonesia-only fields worth knowing: `commerce_platform` = `TIKTOK_SHOP` or **`TOKOPEDIA`** (Tokopedia orders come through the same API), `buyer_service_fee`, `shipping_insurance_fee`, Horizon+ `distance_fee`.
- `shipping_type`: `TIKTOK` (TikTok's logistics, label from TikTok — the normal case) or `SELLER` (own courier). `fulfillment_type` must be `FULFILLMENT_BY_SELLER` for us to ship it (FBT / Dilayani Tokopedia orders are shipped by them, KELPER should skip those).

### "Instant" orders
- **`fulfillment_priority_level`** on the order (SEA only): 100 Instant, 200 Sameday 8 Hours, 300 Sameday, 400 Next Day, 500 Express, 600 Standard, 700 Economy, 800 Cargo. KELPER treats only 100 as instant for now. Absent while `ON_HOLD`, so it must be re-read when the order moves on. Seen as 600 on a Standard sandbox order; **never yet seen on a real instant order**. (This section used to say there was no flag; that was wrong.)

### Shipping ("booking") and the label
Shopee's flow (KELPER books, then fetches the label) maps 1-to-1, but TikTok works **per package**, not per order:
1. Order detail → `packages[].id` (normally one package per order).
2. Optional: `GET /fulfillment/202309/packages/{package_id}/handover_time_slots` → `can_pickup`, `can_drop_off`, `pickup_slots[]`.
3. **Book:** `POST /fulfillment/202309/packages/{package_id}/ship` with `handover_method` = `PICKUP` (+ `pickup_slot`) or `DROP_OFF`. Order moves to `AWAITING_COLLECTION`, `tracking_number` appears. (= Shopee `ship_order`.)
4. **Label:** `GET /fulfillment/202309/packages/{package_id}/shipping_documents?document_type=SHIPPING_LABEL&document_size=A6` → `doc_url` (PDF, **valid 24 hours**, so download and keep it, don't store only the URL). A6 is the default; A5 also possible; `SHIPPING_LABEL_PICTURE` gives a PNG.
5. Package status: `PROCESSING` (arranged, waiting for courier) → `FULFILLING` (picked up) → `COMPLETED` / `CANCELLED`.
- Split/combined packages exist (`/packages/combine`, `/orders/{id}/split`); KELPER should start with one-package orders only and send anything else to Masalah.

### Money (for Omzet / Laba / Layanan / Biaya Pesanan)
- **At order time** (order detail `payment`): `sub_total` (= original price − seller − platform discounts), `shipping_fee`, `seller_discount`, `platform_discount`, `total_amount`. No fees here.
- **After settlement:** `GET /finance/202501/orders/{order_id}/statement_transactions` → `revenue_amount`, `shipping_cost_amount`, `fee_and_tax_amount`, **`settlement_amount` = revenue − shipping cost − fees/taxes** (= Shopee's `escrow_amount`). Per-SKU `fee_tax_breakdown`, the Indonesia-relevant ones:
  - `platform_commission_amount`, `dynamic_commission_amount` (ID only), `transaction_fee_amount` → **Biaya Pesanan**
  - `voucher_xtra_service_fee_amount` → **Layanan** (TikTok's own "Voucher Xtra", the Promo XTRA equivalent, given as its own number, so no percentage estimate needed as on Shopee)
  - `sfp_service_fee_amount` (Seller Free Shipping Programme ≈ Gratis Ongkir XTRA), `pit_amount` (tax) → **Biaya Pesanan**
  - `affiliate_commission_amount`, `affiliate_ads_commission_amount` → **Affiliasi**
- **Before settlement:** `GET /finance/202507/orders/unsettled` gives `est_revenue_amount`, `est_fee_tax_amount`, `est_settlement_amount` (estimates; shipping cost is incomplete until delivery).
- KELPER's Omzet currently uses **catalog price × qty** (`OMZET_PRICE_SOURCE = 'catalog'` in `routes/dashboard.js`), which is platform-neutral: TikTok orders only need `seller_sku` to match the catalog. Laba Kotor works the same way (catalog price − HPP).

### How TikTok orders would fit the Packing Station buckets
`resolveOrderBucket` (routes/packing.js) is driven almost entirely by KELPER's **own** state (delay, work hour, booking in flight, `label_ready`, packing session), not by Shopee status values. From the marketplace it only needs: cancelled or not, `is_instant`, `created_at`, and "booked + label downloaded". So TikTok can use the **same buckets** if `tiktokSync.js` fills the same `orders` columns:

| TikTok | KELPER |
|---|---|
| `UNPAID` | not imported (as Shopee `UNPAID`) |
| `ON_HOLD` | import, stays **Waiting List** (TikTok's own cancel window; can't be booked yet) |
| `AWAITING_SHIPMENT` | normal flow: delay/work hour → booking (`ship`) → label → Ready to Check … |
| `AWAITING_COLLECTION` | booked; once the label PDF is saved → `label_ready` |
| `IN_TRANSIT` / `DELIVERED` / `COMPLETED` | picked up / done |
| `CANCELLED` | **Cancelled** |
| `is_buyer_request_cancel = true` | flag like Shopee `IN_CANCEL` (Batal & Masalah) |

Still to decide with the client: whether the TikTok order delay should stack on top of `ON_HOLD` or start after it.

### Gaps (need sandbox access or docv2)
1. Token get/refresh endpoints and the signing recipe (docv2, not in the spec).
2. What an Indonesian instant/same-day order looks like (provider names/IDs).
3. Real `ON_HOLD` duration in Indonesia.
4. Whether sandbox orders can be booked and return a printable label.

## Open questions (must be settled before Part 2 can really start)

1. Does the client want a Shopee **sandbox** shop connected on staging too (to test the "two marketplaces unified" scenario end-to-end), or is TikTok-only testing sufficient for now?
2. ~~Does TikTok map onto the existing Packing Station buckets?~~ Yes, per the API findings above (same buckets, see the table). Remaining client choice: TikTok and Shopee orders in **one shared queue** (with a platform badge), or separate?
3. Dashboard numbers (Omzet, Laba, etc.) — combined total across both marketplaces, or kept separately filterable? Affects `routes/dashboard.js`'s queries, which currently assume one shop per calculation.
4. Timeline/priority — is this meant to go live this quarter, or is it fine to build incrementally alongside other work?

## Next step

Staging is done (2026-11-02). Next: the user registers on TikTok Shop Partner Center and creates the app (sandbox App Key/Secret, redirect URL `https://dashboard.staging.kelper.co.id/...`), and answers the open questions above. Then the first build step is login + order import only (no booking), tested on staging.

**Step 1 built (2026-11-03): TikTok login only.** `src/tiktok/client.js` (token get/refresh, signing, authorized shops), `src/tiktok/tokenStore.js` (own tables `tiktok_tokens`, `tiktok_shops`), `src/routes/tiktok.js` at `/auth/tiktok` (admin-only; `state` checked; does nothing unless `TIKTOK_APP_KEY`/`TIKTOK_APP_SECRET` are set, so live is unaffected). Frontend: "TikTok Shop (uji coba)" card in Pengaturan (`TikTokAuth.jsx`, hidden unless configured) and `/tiktok-callback` (`TikTokCallback.jsx`). Partner Center redirect URL: `https://dashboard.staging.kelper.co.id/tiktok-callback`. Staging env also needs `TIKTOK_AUTH_URL` (the app's authorization link) or `TIKTOK_SERVICE_ID`.

**Step 1 verified on staging (2026-11-04):** connected to sandbox seller SANDBOX7702543285210613556, shop SANDBOX_ID7702543285210646324 (ID), Cek koneksi OK. Lessons: (1) TikTok answered **105005 Access denied** on every API call while the app was in **Draft**, even with all scopes Active and on the token; it worked once the app showed **On**. (2) The app has an **IP allowlist** (Partner Center -> app -> IP allowlist) holding the VM IP 34.101.187.99; calls from any other IP get **36009033** (that includes Partner Center's own API Testing Tool). (3) Approve as the sandbox seller; the token is kept even if the shop list fails, and `scripts/tiktok-token.js` prints it on the VM for diagnosis.

**Sandbox test by hand (2026-11-07), from the VM, no app code:** order -> `AWAITING_SHIPMENT` -> `ship` -> resi + A6 PDF label about 10 s later -> `AWAITING_COLLECTION`. Lessons: `packages` is empty while `ON_HOLD`; `ship` returns `{}`, so the resi comes from `shipping_documents` or the order; `seller_sku` can be empty; `/packages/{id}/handover_time_slots` answers 105005 even with `seller.fulfillment.basic`, while `/orders/{id}/handover_time_slots?order_line_item_ids=` works; we asked for `DROP_OFF` but the package and label said PICKUP, so read the method back from the package; finance calls succeed with all zeros before settlement, which must count as "not settled", never as 0 fees. Not proven: printing, barcode scan, Tokopedia orders, real instant, real couriers, fee numbers.

**Decisions (2026-11-07):** include TikTok Shop and Tokopedia, one shared queue with a Shopee/TikTok/Tokopedia tag, skip Dilayani Tokopedia, no time limit on `ON_HOLD`, cancellations behave as on Shopee, pickup first and drop-off when pickup isn't offered.

**Step 2 built (2026-11-07): read-only order import, staging only.** `src/tiktok/orderSync.js` polls every 30 s (off without TikTok keys). Orders are stored with `shop_id = -1`, which no Shopee loop or `/next-order` selects, plus new `orders` columns `platform`, `marketplace_status`, `marketplace_flags`. They show only in the Waiting List and Order Detail, with a platform tag and TANPA SKU / BEBERAPA PAKET / MINTA BATAL tags. Can't be claimed or booked yet; the Orders page and Dashboard don't include them. Next: booking and labels, then fees.

**Step 3 built (2026-11-10): booking and labels, staging only.** TikTok/Tokopedia orders now go through the Packing Station like Shopee ones, in one shared queue.
- `ON_HOLD` at TikTok = local status `ON_HOLD`: Waiting List only, never booked or claimed. When TikTok releases it, it becomes `READY_TO_PACK` and follows Shopee's rules (delay, work hours, instant hours, "Maks Siap Dicek" counted across both platforms, Pack Besok outside work hours).
- `src/tiktok/booking.js` (own loop every 15 s): order-level `handover_time_slots` -> PICKUP with the first available slot, else DROP_OFF -> `ship` -> A6 label PDF downloaded and stored (`label_pdf`) -> handover method, resi and courier read back from the package. Same failure counting and Masalah fallback as Shopee; same `autoBookShipping` kill switch.
- Station-side queries in `routes/packing.js` use `IN_QUEUE` = `(shop_id = ? OR platform != 'shopee')`; Shopee-calling code is unchanged and never sees TikTok orders. Stations with no Shopee shop (staging) send `shop_id` null and get TikTok orders only.
- No SKU or more than one package -> Batal & Masalah ("Auto (TikTok)"). Cancelled at TikTok: unclaimed drops out; claimed -> Batal & Masalah. Admin "Batalkan" is refused for TikTok (cancel in Seller Center). The Pack Besok print re-checks the live TikTok status.
- Not yet: the fetch lock ("Kunci Fetching") doesn't stop TikTok import or booking; fees/income; Orders page and Dashboard; one TikTok shop only.

**Step 4 built (2026-11-10): money and reports, staging only.**
- `src/tiktok/income.js`: for DONE TikTok orders, `statement_transactions` -> `order_income` (Layanan = `voucher_xtra_service_fee_amount`; Biaya Pesanan = platform + dynamic commission, transaction fee, every other fee, taxes; new `order_income.affiliate_commission` = affiliate fees). All-zero answer = not settled, nothing stored, retried every 6 h. **Mapping follows the spec only; check it on the first real settled order.**
- `/dashboard/summary?platform=shopee|tiktok|all` (default shopee = unchanged, checked against the previous code). Staging's Main/Shopee/TikTok Dashboard now shows real data instead of TEMP. TikTok has no Iklan or Page View (not in the API / no analytics scope).
- Orders page lists TikTok/Tokopedia orders with their tag.
- Also: per-marketplace fetch switches in Order Lists (TikTok lock = no new orders, no booking), TikTok Late Pickup inferred from the pickup slot end, several TikTok shops (`orders.marketplace_shop_id`).
- The sandbox can't create Tokopedia orders ("we only support test order placement from TikTok right now", Tokopedia & Shop onboarding guide).

**Client answers (2026-11-10, via the user):** Seller SKUs match KELPER/Shopee: yes. Couriers: JNE, SiCepat, AnterAja, POS Indonesia, J&T (all already matched by `carrierSpeech.js`; TikTok's "TT Virtual# JNT express" plays J&T). Instant/Same Day: assume yes. Work hours and priority: same as Shopee. Buyer cancel request: same as Shopee. Label: A6 is fine if Shopee's is. Who connects the shop: the client. Open: Tokopedia in the new Seller Center / one shop or two; delay on top of ON_HOLD (q14); same price on all channels; split/combined packages; go-live date (the user decides).

### Before going live with TikTok (checklist)
1. Reset the TikTok **App Secret** in Partner Center (it was shown in chat) and use only the new one on live.
2. Merge `dev-staging` -> `main`, deploy live. Without TikTok keys live behaves as before (TikTok off, staging-only pages hidden). Tell the client: Shopee fetching can now be unlocked from the Dashboard.
3. Add `TIKTOK_APP_KEY` / `TIKTOK_APP_SECRET` (+ `TIKTOK_AUTH_URL` or `TIKTOK_SERVICE_ID`) to live's `.env.production`; add the live redirect URL (`https://dashboard.kelper.co.id/tiktok-callback`) in Partner Center; restart.
4. Client connects the real shop (Pengaturan -> TikTok Shop). TikTok fetching starts **locked**: unlock in Order Lists only when ready.
5. First real orders: check a Tokopedia order, an instant order, ON_HOLD length, courier names, label print + scan on the client's printer, and the first settled order's fees.
6. The Dashboard on live still shows Shopee only (MainDashboard.jsx); the Main/Shopee/TikTok views are staging-only until switched on for live.
