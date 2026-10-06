const Database = require('better-sqlite3');
const path = require('path');
const { NODE_ENV } = require('./env');

// Separate database file per environment — development's mock orders and
// experimental schema changes must never land in the same file production
// actually depends on.
const dbFilename = `kelper.${NODE_ENV}.db`;
const db = new Database(path.join(__dirname, '..', dbFilename));

db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_tokens (
    shop_id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Separate from shopee_tokens on purpose: the Brand Portal app is a
  -- distinct Shopee app (its own Partner ID/Key), so its OAuth token must
  -- never share a table keyed only by shop_id with the main app's token —
  -- connecting one would silently clobber the other and break whichever
  -- feature depends on it (order sync for the main app; Affiliasi/
  -- Pengunjung for this one).
  CREATE TABLE IF NOT EXISTS shopee_brand_tokens (
    shop_id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_sn TEXT PRIMARY KEY,
    shop_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'READY_TO_PACK',
    buyer_name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL REFERENCES orders(order_sn),
    sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packing_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL REFERENCES orders(order_sn),
    station_id TEXT NOT NULL,
    operator_name TEXT,
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    shipping_choice TEXT,
    internal_barcode TEXT,
    tracking_no TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    last_activity_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS scan_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES packing_sessions(id),
    sku TEXT NOT NULL,
    scanned_qty INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, sku)
  );

  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    login_barcode TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS station_sessions (
    station_id TEXT PRIMARY KEY,
    operator_name TEXT NOT NULL,
    checked_in_at INTEGER NOT NULL
  );

  -- Client-requested (2026-09-30): persistent attendance history -- unlike
  -- station_sessions above (one live row per station, deleted on checkout,
  -- so it has no memory of past shifts), this is append-only: one row per
  -- check-in, updated with checked_out_at when that shift ends. Powers the
  -- Kinerja Operator report's absensi columns.
  CREATE TABLE IF NOT EXISTS attendance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    operator_name TEXT NOT NULL,
    checked_in_at INTEGER NOT NULL,
    checked_out_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    name TEXT,
    hpp INTEGER,
    barcode TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Local cache of Shopee's live product catalog (synced on demand, not
  -- fetched fresh on every page load). Kept separate from "products" above,
  -- which is the client's manually-imported HPP master list — the two are
  -- joined by SKU at read time, never merged into one table, since one is
  -- "what Shopee says is listed" and the other is "what the client says it
  -- costs", and either can exist without the other.
  CREATE TABLE IF NOT EXISTS shopee_items (
    item_id INTEGER PRIMARY KEY,
    shop_id INTEGER NOT NULL,
    item_sku TEXT,
    name TEXT NOT NULL,
    item_status TEXT,
    min_purchase_limit INTEGER,
    has_model INTEGER NOT NULL DEFAULT 0,
    image_url TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shopee_item_models (
    item_id INTEGER NOT NULL REFERENCES shopee_items(item_id),
    model_id INTEGER NOT NULL,
    model_sku TEXT,
    model_name TEXT,
    price INTEGER,
    stock INTEGER,
    model_status TEXT,
    image_url TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, model_id)
  );

  -- Real per-order financials from Shopee's escrow API (get_escrow_detail),
  -- fetched once an order has shipped (see shopeeSync.js's
  -- fillMissingIncomeData) — replaces the Dashboard's catalog-price x qty
  -- guess with what Shopee actually paid out, for orders old enough to have
  -- this data. escrow_amount can still change until the order is fully
  -- completed (Shopee's buyer-confirmation window), so this is a snapshot,
  -- not a permanently final number — fetched once per order rather than
  -- kept in sync with later revisions, since re-fetching indefinitely would
  -- mean calling this API for every historical order forever.
  CREATE TABLE IF NOT EXISTS order_income (
    order_sn TEXT PRIMARY KEY REFERENCES orders(order_sn),
    order_selling_price REAL,
    escrow_amount REAL,
    service_fee REAL,
    commission_fee REAL,
    seller_transaction_fee REAL,
    fetched_at INTEGER NOT NULL
  );

  -- Daily Affiliasi snapshot from Shopee's Brand Portal API
  -- (get_shop_affiliate_performance) — fetched once per calendar day, for
  -- the previous day only, since Shopee's own data has a 1-day reporting
  -- lag (today's figures aren't available yet). See shopeeSync.js's
  -- fetchAffiliatePerformance.
  CREATE TABLE IF NOT EXISTS affiliate_performance_daily (
    shop_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    sales_confirmed REAL,
    orders_confirmed INTEGER,
    buyers_confirmed INTEGER,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (shop_id, date)
  );

  -- Pengunjung (unique_visitors) from Shopee's Brand Portal API
  -- (get_shop_sales_performance_detail) — same once-daily, yesterday-only
  -- pattern as affiliate_performance_daily above, and the same reason
  -- (Shopee's data has a 1-day reporting lag).
  CREATE TABLE IF NOT EXISTS shop_performance_daily (
    shop_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    unique_visitors INTEGER,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (shop_id, date)
  );

  -- Iklan (Ads Expenditure) from Shopee's Ads API
  -- (get_all_cpc_ads_hourly_performance) — this one covers TODAY (unlike
  -- the two Brand Portal tables above), refetched periodically through the
  -- day rather than once, since "today" changes as more ad spend happens.
  -- See shopeeSync.js's fetchAdsPerformance.
  CREATE TABLE IF NOT EXISTS ads_performance_daily (
    shop_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    expense REAL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (shop_id, date)
  );

  -- Small runtime-mutable key/value store for toggles an admin flips from
  -- the UI (e.g. pausing order sync) — deliberately NOT config.json, which
  -- is git-tracked deployment config and would get silently reverted by the
  -- next git pull/auto-deploy if the UI wrote to it instead.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Brute-force guard for /admin/login (see loginGuard.js), keyed by client
  -- IP. A dedicated table rather than the generic settings key/value store
  -- above since this needs one row per IP, not one row per config key — and
  -- persisted rather than in-memory so a lockout survives a server restart
  -- (deploys restart the process).
  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );

  -- Real admin sessions (client-requested 2026-09-26, security fix) — until
  -- now, /admin/login only gated the frontend's own React state, with every
  -- other route (dashboard data, HPP/cost, packing actions including the
  -- real Shopee cancel-order and bulk force actions) reachable by anyone who
  -- found the URL, logged in or not. Persisted (not just an in-memory Map)
  -- so admins aren't logged out by every deploy restart.
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Client-requested (2026-10-01): more than one admin login (e.g. a
  -- separate, revocable credential for a Shopee reviewer during the Go Live
  -- process, without sharing the real admin's own password) -- replaces the
  -- old single ADMIN_USERNAME/ADMIN_PASSWORD env-var pair. password_hash is
  -- salt:scrypt-hash (see adminUsers.js), never plaintext.
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Non-destructive migration for existing local databases created before
// last_activity_at existed.
const packingSessionCols = db.prepare("PRAGMA table_info(packing_sessions)").all().map((c) => c.name);
if (!packingSessionCols.includes('last_activity_at')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN last_activity_at INTEGER');
}
// Client-requested (2026-09-25): set only by the Order Detail popup's "Move
// to Ready to Pickup" admin override (routes/packing.js's
// /force-ready-for-pickup) — marks a session that skipped the normal
// scan/label flow, so it stays visibly distinguishable from a genuinely
// completed one instead of looking identical in Ready to Pickup.
if (!packingSessionCols.includes('forced')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN forced INTEGER NOT NULL DEFAULT 0');
}
// Client-requested (2026-09-27): a Problem Order (EXCEPTION) previously had
// no way to say WHY it was flagged — an operator's manual "Masalah" tap still
// doesn't record one, but the automatic flagging in shopeeSync.js's
// bookOneOrder (after repeated real booking failures) writes the actual
// Shopee error here so it shows up in the Cancel & Masalah list instead of
// requiring someone to go dig through server logs.
if (!packingSessionCols.includes('exception_reason')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN exception_reason TEXT');
}
// Client-requested (2026-09-29): flags an EXCEPTION session as still needing
// admin attention on the Batal & Masalah screen -- set whenever a session
// becomes EXCEPTION (cancellation detected, manual Masalah scan, or repeated
// booking failure), cleared only by that screen's own "Selesaikan" button so
// the notification survives page reloads until someone actually acts on it.
if (!packingSessionCols.includes('needs_resolve')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN needs_resolve INTEGER NOT NULL DEFAULT 0');
}
// Client-requested (2026-09-30): when the operator's confirm-print scan
// succeeded (see routes/packing.js's /confirm-print) -- the real end of
// "handling" this order (scanning items through the label-scan confirm),
// as opposed to completed_at (set much later, at courier pickup). Powers
// the Kinerja Operator report's per-order/average duration figures.
if (!packingSessionCols.includes('label_confirmed_at')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN label_confirmed_at INTEGER');
}

// Non-destructive migration for the server's background sync flow: orders
// now carry their own pre-fetched shipment/label data instead of that being
// fetched live at pack-time.
const orderCols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
const newOrderCols = {
  is_instant: 'INTEGER NOT NULL DEFAULT 0',
  logistics_channel_id: 'INTEGER',
  shipping_carrier: 'TEXT',
  tracking_no: 'TEXT',
  label_pdf: 'BLOB',
  label_ready: 'INTEGER NOT NULL DEFAULT 0',
  // Learned as a side effect of booking (see shipping.js) — used to fetch
  // item details via get_package_detail when order/get_order_detail fails.
  package_number: 'TEXT',
  // Client-requested (2026-09-23): distinct from label_ready (Shopee has
  // given us a tracking number + PDF — booking succeeded) — label_printed
  // means the operator has actually scanned the physical printed label back
  // to confirm it came out correctly (see routes/packing.js's
  // /confirm-print, the only place this is ever set to 1). A durable
  // per-order record of "this order's real label has been confirmed
  // printed", queryable without reconstructing it from session status.
  label_printed: 'INTEGER NOT NULL DEFAULT 0',
  // Client-requested (2026-09-25): when label_ready last flipped to 1 (see
  // shopeeSync.js's bookOneOrder/bookDebugOrder) — the moment an order
  // actually entered the Ready to Check pool. Used to flag one that's sat
  // there unclaimed too long (the "stuck" order tag), separate from
  // created_at, since an order can wait a long time for its label before
  // ever reaching Ready to Check at all.
  label_ready_at: 'INTEGER',
  // Client-requested (2026-09-27): Shopee moves an order to RETRY_SHIP when
  // the courier's pickup attempt failed and needs a re-arrange — previously
  // invisible to us entirely (only CANCELLED was ever checked for). Synced
  // both ways (set to 1 when Shopee reports RETRY_SHIP, back to 0 once it
  // isn't) by shopeeSync.js's detectRetryShipOrders, run alongside the
  // existing cancellation recheck.
  needs_retry_ship: 'INTEGER NOT NULL DEFAULT 0',
  // Client-requested (2026-09-27): counts consecutive bookOneOrder failures
  // (shopeeSync.js) so a booking that keeps failing (e.g. an unrecognized
  // Shopee rejection) gets flagged to Masalah after a few tries instead of
  // retrying — and hammering Shopee's API — forever with the order silently
  // stuck in the Processing bucket. Reset to 0 on the next successful booking.
  booking_fail_count: 'INTEGER NOT NULL DEFAULT 0',
  booking_last_error: 'TEXT',
  // Client-requested (2026-09-30): when the CURRENT unbroken booking-failure
  // streak started -- lets bookOneOrder require real elapsed time (not just
  // a handful of retries a few seconds apart) before giving up and flagging
  // Masalah. Reset to NULL on the next successful booking.
  booking_first_failed_at: 'INTEGER',
  // Client-requested (2026-09-29): show when the courier is scheduled to
  // pick up the package, on the Ready to Pickup panel. Deliberately a TEXT
  // label ("Now", "16:00 - 17:00"), not a timestamp -- an earlier version of
  // this stored get_shipping_parameter time_slot_list's `date` field as a
  // unix timestamp, but confirmed empirically that EVERY slot in a day
  // (regardless of actual hour) shares the same `date` value; it's a
  // per-day anchor, not the slot's real time, and produced a wrong pickup
  // time on the dashboard. `time_text` is the only field that's actually
  // accurate. NULL for orders booked before this existed, or where the
  // package already existed and no fresh slot was selected this time.
  pickup_time_label: 'TEXT',
  // Client-requested (2026-09-29): set only when a cancellation is detected
  // on an order that already had an active packing session -- i.e. it
  // dropped out of a bucket other than Daftar Tunggu, so it needs a
  // notification on the Batal & Masalah screen. An order cancelled before
  // anyone claimed it needs no follow-up and stays 0. Cleared by that
  // screen's own "Selesaikan" button.
  cancel_needs_resolve: 'INTEGER NOT NULL DEFAULT 0',
  // Client-requested (2026-10-03): 1 when the courier offered no pickup for
  // this order (confirmed for SiCepat REG on the live shop) and it was booked
  // for drop-off instead -- a staff member has to take the parcel to the
  // courier's counter, nobody comes to collect it. Set at booking
  // (shopeeSync.js's bookOneOrder); left alone when the package already
  // existed and this booking didn't choose. Drives the "Antar ke gerai" tag.
  is_dropoff: 'INTEGER NOT NULL DEFAULT 0',
};
for (const [col, def] of Object.entries(newOrderCols)) {
  if (!orderCols.includes(col)) {
    db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
  }
}

// Non-destructive migration for existing local databases created before the
// product image thumbnail/preview feature existed.
const shopeeItemCols = db.prepare("PRAGMA table_info(shopee_items)").all().map((c) => c.name);
if (!shopeeItemCols.includes('image_url')) {
  db.exec('ALTER TABLE shopee_items ADD COLUMN image_url TEXT');
}

const shopeeModelCols = db.prepare("PRAGMA table_info(shopee_item_models)").all().map((c) => c.name);
if (!shopeeModelCols.includes('image_url')) {
  db.exec('ALTER TABLE shopee_item_models ADD COLUMN image_url TEXT');
}

// Client-requested (2026-09-25): a manually-entered stock count per SKU,
// deliberately separate from shopee_item_models.stock (Shopee's own live
// stock, pulled by sync-shopee) — the two are allowed to disagree, same
// "two sources of truth joined by SKU, never merged" rule as hpp/barcode
// above. NULL (not 0) until the client actually enters a value.
const productCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
if (!productCols.includes('stock')) {
  db.exec('ALTER TABLE products ADD COLUMN stock INTEGER');
}

// Client-requested (2026-09-28): a manually-entered selling price per SKU —
// same "two sources of truth, allowed to disagree" pattern as hpp/stock
// above, except this one now fully REPLACES shopee_item_models.price as the
// number the Dashboard's Omzet/Laba (routes/dashboard.js's
// buildSkuPriceMap) and List Barang's profit columns (routes/products.js's
// /catalog) are computed from — a Shopee catalog re-sync can update
// shopee_item_models.price all it wants, it will never again change what
// the app's financial numbers are based on.
if (!productCols.includes('price')) {
  db.exec('ALTER TABLE products ADD COLUMN price INTEGER');
  // One-time seed so existing Omzet/Laba don't drop to zero the instant
  // this deploys — copies each SKU's currently-synced Shopee price in as a
  // starting point to edit from. This UPDATE only ever runs once (the
  // whole block is gated on the column not existing yet); every price from
  // here on is either this one historical snapshot or a deliberate manual
  // edit, never re-synced.
  db.exec(`
    UPDATE products
    SET price = (
      SELECT m.price
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      WHERE COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) = products.sku
      LIMIT 1
    )
    WHERE price IS NULL
  `);
}

// Client-requested (2026-09-28): price/hpp SNAPSHOTTED per order item at
// the moment an order is scanned DONE in Shipping Mode (see packing.js's
// confirmOrderPickedUp) — without this, editing a SKU's current price/hpp
// in List Barang would retroactively rewrite every past day's Omzet/Laba
// for that SKU the next time it's viewed, since buildSkuPriceMap
// (routes/dashboard.js) always read whatever products.price/hpp is set
// RIGHT NOW. dashboard.js falls back to that live lookup only when a
// row's snapshot is still NULL (never backfilled here on purpose — there's
// no way to know what price was actually in effect for an order that was
// already scanned DONE before this column existed, so pretending today's
// current price applied to it back then would be no more accurate than
// the live-lookup fallback it already gets).
const orderItemCols = db.prepare("PRAGMA table_info(order_items)").all().map((c) => c.name);
if (!orderItemCols.includes('price_snapshot')) {
  db.exec('ALTER TABLE order_items ADD COLUMN price_snapshot INTEGER');
}
if (!orderItemCols.includes('hpp_snapshot')) {
  db.exec('ALTER TABLE order_items ADD COLUMN hpp_snapshot INTEGER');
}

// Client-requested (2026-10-03): when a station last proved it is alive (a
// heartbeat from the page, or any request it makes while working — see
// stationPresence.js). station_sessions only knew WHEN an operator checked in,
// so a PC switched off or an app closed without logging out left the station
// "logged in" forever with its shift open in the absensi. NULL on rows created
// before this column existed; the sweep falls back to checked_in_at for those.
const stationSessionCols = db.prepare("PRAGMA table_info(station_sessions)").all().map((c) => c.name);
if (!stationSessionCols.includes('last_seen_at')) {
  db.exec('ALTER TABLE station_sessions ADD COLUMN last_seen_at INTEGER');
}
// Which physical machine (browser profile) holds this station ID right now. A
// station is identified only by the ID typed at setup, so two machines left on
// the same ID were treated as ONE station: each new login overwrote the last
// and /next-order handed every one of them the order that "station" already
// held -- different operators ended up on the same order (seen in production
// 2026-10-04, three operators on one ID). The login now refuses a second
// machine on an ID that is in use; see routes/operators.js's /lookup.
if (!stationSessionCols.includes('device_id')) {
  db.exec('ALTER TABLE station_sessions ADD COLUMN device_id TEXT');
}

// Client-requested (2026-10-04): roles for dashboard logins. 'admin' is the
// full dashboard (everything, as before); 'packing' is a Packing Station admin
// who only gets the Packing Station Dashboard and Order menus. Every existing
// account and live session defaults to 'admin', so nothing changes for anyone
// until a packing account is created (scripts/manage-admin.js). The role is
// stored on the SESSION too, so a request is judged by the role the person
// logged in with -- see adminSession.js's requireAdminAuth.
const adminUserCols = db.prepare("PRAGMA table_info(admin_users)").all().map((c) => c.name);
if (!adminUserCols.includes('role')) {
  db.exec("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
}
const adminSessionCols = db.prepare("PRAGMA table_info(admin_sessions)").all().map((c) => c.name);
if (!adminSessionCols.includes('role')) {
  db.exec("ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
}
// Whose session it is (NULL for sessions issued before this existed). Lets a
// role change or a removed account end that person's open sessions at once.
if (!adminSessionCols.includes('username')) {
  db.exec('ALTER TABLE admin_sessions ADD COLUMN username TEXT');
}

// Client-requested (2026-10-07): a "ship tomorrow" (Pack Besok) order now waits
// for the operator to pack the box and scan the temp barcode back, like a real
// label does, instead of the station moving on by itself. This records when
// that scan happened (NULL = still waiting, or a session from before this).
const packingSessionColsForBesok = db.prepare("PRAGMA table_info(packing_sessions)").all().map((c) => c.name);
if (!packingSessionColsForBesok.includes('besok_confirmed_at')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN besok_confirmed_at INTEGER');
}

// Client-requested (2026-10-07): dashboard stock (products.stock) now goes down
// when an order is confirmed PICKED UP in Shipping Mode, not as each item is
// scanned while packing. 1 = a session that began under the old rule (stock
// already taken per scan, so it must keep being taken/restored per scan and
// must NOT be taken again at pickup); 0 = new sessions (stock taken at
// pickup). Every session that exists when this column is added is marked 1, so
// an order half-packed at deploy time is neither lost nor counted twice.
const packingSessionColsForStock = db.prepare("PRAGMA table_info(packing_sessions)").all().map((c) => c.name);
if (!packingSessionColsForStock.includes('stock_consumed_at_scan')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN stock_consumed_at_scan INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE packing_sessions SET stock_consumed_at_scan = 1');
}

// Client-requested (2026-10-03): which single products make up each bundle
// listing (e.g. KELPER-12 = 1 x KEL-01 + 1 x KEL-07). Both sides are SKUs --
// bundle_sku is a Shopee listing, component_sku a single product -- so the
// Bundle menu can show a bundle's items and a later packing change can expand
// a bundle order into the parts to scan. qty is how many of the component one
// bundle contains. Filled from the barcode sheet (/products/import-barcode)
// or edited by hand in the Bundle menu.
db.exec(`
  CREATE TABLE IF NOT EXISTS bundle_items (
    bundle_sku TEXT NOT NULL,
    component_sku TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (bundle_sku, component_sku)
  );
`);

module.exports = db;
