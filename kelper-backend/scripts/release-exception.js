// Releases an order that was auto-flagged to Masalah because booking kept
// failing (client-requested 2026-10-03, after two SiCepat REG orders landed
// there before KELPER could book drop-off), so the sync loop picks it up and
// tries to book it again. Run it once the underlying cause is fixed.
//
// Deliberately narrow: it only touches a session KELPER itself created for a
// booking failure (station_id = 'SYSTEM', status EXCEPTION, no scan
// progress). An order a real operator already worked on and flagged has
// physical packing behind it -- deleting that session could lose scan
// records, so this refuses and says why. Cancelled orders are refused too.
//
// Usage (from kelper-backend/):
//   node scripts/release-exception.js <order_sn> [<order_sn> ...]
const db = require('../src/db');

const orderSns = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (orderSns.length === 0) {
  console.error('Usage: node scripts/release-exception.js <order_sn> [<order_sn> ...]');
  process.exit(1);
}

let failed = 0;
for (const orderSn of orderSns) {
  const order = db.prepare('SELECT order_sn, status FROM orders WHERE order_sn = ?').get(orderSn);
  if (!order) { console.log(`${orderSn}: not found.`); failed++; continue; }
  if (order.status === 'CANCELLED') { console.log(`${orderSn}: refused -- the order is cancelled.`); failed++; continue; }

  const session = db.prepare('SELECT id, station_id, status FROM packing_sessions WHERE order_sn = ?').get(orderSn);
  if (!session) { console.log(`${orderSn}: no session -- it is not in Masalah (nothing to release).`); continue; }
  if (session.status !== 'EXCEPTION') { console.log(`${orderSn}: refused -- session is ${session.status}, not EXCEPTION.`); failed++; continue; }
  if (session.station_id !== 'SYSTEM') {
    console.log(`${orderSn}: refused -- flagged from ${session.station_id}, so an operator already worked on it; releasing could lose scan records.`);
    failed++;
    continue;
  }
  const scanned = db.prepare('SELECT COUNT(*) AS c FROM scan_progress WHERE session_id = ?').get(session.id).c;
  if (scanned > 0) { console.log(`${orderSn}: refused -- it has ${scanned} scan record(s).`); failed++; continue; }

  db.transaction(() => {
    db.prepare('DELETE FROM packing_sessions WHERE id = ?').run(session.id);
    db.prepare("UPDATE orders SET status = 'READY_TO_PACK', booking_fail_count = 0, booking_first_failed_at = NULL, booking_last_error = NULL WHERE order_sn = ?").run(orderSn);
  })();
  console.log(`${orderSn}: released -- booking will be retried on the next sync tick.`);
}
process.exit(failed > 0 ? 1 : 0);
