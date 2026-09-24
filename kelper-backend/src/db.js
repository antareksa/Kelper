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

module.exports = db;
