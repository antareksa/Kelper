const db = require('./db');

// Client-requested (2026-10-16): every change to a SKU's dashboard stock
// (products.stock) is recorded in stock_log, so the Stock Opname page can show
// per item how much came in and went out over any period. Reasons:
//   sale     picked up in Shipping Mode (packing.js's confirmOrderPickedUp)
//   scan     taken per item scan (old-rule sessions only)
//   unscan   an old-rule per-scan take undone
//   release  an old-rule session handed back (sessionRelease.js)
//   upload   Item Stok upload (products.js /import-stock)
//   manual   edited by hand in List Barang (products.js PUT /:sku/stock)
// `apply` runs the actual UPDATE; the logged delta is the real change it made
// (after - before), so the "never below zero" clamp is reflected. A change
// that did nothing (same value, or a SKU whose stock is unknown/NULL both
// before and after) is not logged.
const getStock = db.prepare('SELECT stock FROM products WHERE sku = ?');
const insertLog = db.prepare(`
  INSERT INTO stock_log (sku, delta, stock_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)
`);

function withStockLog(sku, reason, ref, at, apply) {
  const before = getStock.get(sku)?.stock ?? null;
  apply();
  const after = getStock.get(sku)?.stock ?? null;
  if (before == null && after == null) return;
  const delta = (after ?? 0) - (before ?? 0);
  if (delta === 0) return;
  insertLog.run(sku, delta, after, reason, ref ?? null, at);
}

module.exports = { withStockLog };
