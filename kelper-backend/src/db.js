const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'kelper.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_tokens (
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
`);

// Non-destructive migration for existing local databases created before
// last_activity_at existed.
const packingSessionCols = db.prepare("PRAGMA table_info(packing_sessions)").all().map((c) => c.name);
if (!packingSessionCols.includes('last_activity_at')) {
  db.exec('ALTER TABLE packing_sessions ADD COLUMN last_activity_at INTEGER');
}

module.exports = db;
