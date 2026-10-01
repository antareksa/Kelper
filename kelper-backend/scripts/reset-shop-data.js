// One-off reset of order/packing data for a given shop_id (client-requested
// 2026-10-02) -- for clearing out sandbox test clutter before going live,
// without touching staff (operators), the product/HPP catalog, packing
// settings, or admin accounts. Requires an explicit shop_id argument on
// purpose: there is no "clear everything" default, so this can never
// accidentally wipe a real shop's data from a bare invocation.
//
// Clears: orders, order_items, order_income, packing_sessions, scan_progress
// (all scoped to the given shop_id), and attendance_log (NOT shop-scoped --
// check-ins aren't tied to any shop at all, so this clears every operator's
// attendance history regardless of shop_id, every time this script runs).
//
// Usage (from kelper-backend/):
//   node scripts/reset-shop-data.js <shop_id>
const db = require('../src/db');

const shopId = Number(process.argv[2]);
if (!shopId) {
  console.error('Usage: node scripts/reset-shop-data.js <shop_id>');
  process.exit(1);
}

const orderSns = db.prepare('SELECT order_sn FROM orders WHERE shop_id = ?').all(shopId).map((r) => r.order_sn);

// attendance_log/orphan cleanup run unconditionally below -- they aren't
// shop-scoped at all, so "no orders for this shop" doesn't mean "nothing to
// clean up" the way it would for the order-specific deletes.
const run = db.transaction(() => {
  if (orderSns.length > 0) {
    const placeholders = orderSns.map(() => '?').join(',');
    const sessionIds = db
      .prepare(`SELECT id FROM packing_sessions WHERE order_sn IN (${placeholders})`)
      .all(...orderSns)
      .map((r) => r.id);
    if (sessionIds.length > 0) {
      const sessionPlaceholders = sessionIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM scan_progress WHERE session_id IN (${sessionPlaceholders})`).run(...sessionIds);
    }
    db.prepare(`DELETE FROM packing_sessions WHERE order_sn IN (${placeholders})`).run(...orderSns);
    db.prepare(`DELETE FROM order_income WHERE order_sn IN (${placeholders})`).run(...orderSns);
    db.prepare(`DELETE FROM order_items WHERE order_sn IN (${placeholders})`).run(...orderSns);
    db.prepare('DELETE FROM orders WHERE shop_id = ?').run(shopId);
  }
  db.prepare('DELETE FROM attendance_log').run();
  // Defensive: any scan_progress row left pointing at a session_id that no
  // longer exists (from this run or an earlier one) is dead weight either way.
  db.prepare('DELETE FROM scan_progress WHERE session_id NOT IN (SELECT id FROM packing_sessions)').run();
});
run();

console.log(`Cleared ${orderSns.length} order(s), their packing sessions, and all attendance history (shop_id ${shopId}).`);
console.log('Kept untouched: operators, product/HPP catalog, packing settings, admin accounts.');
