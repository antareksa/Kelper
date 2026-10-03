const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);

// Same rule as packing.js's undo: a SKU with no dashboard stock entered yet
// (NULL) stays NULL.
const restoreStock = db.prepare(`
  UPDATE products SET stock = stock + ?, updated_at = ? WHERE sku = ? AND stock IS NOT NULL
`);

// Hands an order that is still being scanned (IN_PROGRESS) back to the pool as
// if nobody had touched it: the session and its scan progress are deleted, the
// order returns to READY_TO_PACK (so it is claimable again — "Ready to Check"),
// and the dashboard stock already deducted for the items scanned so far is
// put back, since those scans no longer stand. Shared by the manual
// RELEASE_ORDER command, the 1h stale sweep, and the pause/logout release
// below, so all three behave identically.
const releaseInProgress = db.transaction((session) => {
  for (const row of db.prepare('SELECT sku, scanned_qty FROM scan_progress WHERE session_id = ?').all(session.id)) {
    if (row.scanned_qty > 0) restoreStock.run(row.scanned_qty, now(), row.sku);
  }
  db.prepare('DELETE FROM scan_progress WHERE session_id = ?').run(session.id);
  db.prepare('DELETE FROM packing_sessions WHERE id = ?').run(session.id);
  db.prepare("UPDATE orders SET status = 'READY_TO_PACK' WHERE order_sn = ?").run(session.order_sn);
});

// Client-requested (2026-10-03): when an operator pauses or logs out, an order
// that station is still working on must not stay stuck on it until the 1h
// stale sweep (nobody else could take it meanwhile). Releases:
//  - IN_PROGRESS (still scanning items): back to Ready to Check, scans undone.
//  - RESUMING (a packed Pack Besok leftover auto-assigned to this station,
//    waiting for its temp-barcode scan): back to DEFERRED_READY, which is
//    where it sat in Ready to Check before being assigned.
// Deliberately NOT released: AWAITING_LABEL_SCAN. By then every item is
// scanned and a real label is printed on the operator's package, so handing
// it to another station would throw that work away and risk a second box.
//
// Returns [{ session_id, order_sn, from }] for what was released.
function releaseStationSessions(stationId) {
  const released = [];
  if (!stationId) return released;

  const sessions = db
    .prepare("SELECT id, order_sn, status FROM packing_sessions WHERE station_id = ? AND status IN ('IN_PROGRESS', 'RESUMING')")
    .all(stationId);
  for (const s of sessions) {
    if (s.status === 'IN_PROGRESS') {
      releaseInProgress(s);
    } else {
      db.prepare("UPDATE packing_sessions SET status = 'DEFERRED_READY', operator_name = NULL WHERE id = ?").run(s.id);
    }
    released.push({ session_id: s.id, order_sn: s.order_sn, from: s.status });
    console.log(`[server] bucket: ${s.order_sn} -> Ready to Check (released from station ${stationId}, was ${s.status})`);
  }
  return released;
}

module.exports = { releaseInProgress, releaseStationSessions };
