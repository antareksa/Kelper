const { getPriorityCarriers } = require('./packingSettings');

// The order in which Packing Station hands out (and books) orders, one rule
// everywhere (client-requested 2026-10-12):
//   1. INSTANT orders first,
//   2. then orders whose expedition is on the priority list (Packing Station
//      Dashboard > Prioritas Ekspedisi; earlier in the list = higher; an empty
//      list means this rule changes nothing),
//   3. then orders with fewer pieces to scan (a bundle counts as its parts),
//   4. then the oldest first (and order number, so ties are stable).
//
// The same rule exists twice on purpose: as SQL (priorityOrderBy) for the queries
// that hand out and book orders, and as a JS comparator (priorityCompare) for the
// Order Lists panel, whose UNION query cannot order by columns of its source
// tables. They must stay in step: both give the same order for the same orders.

// Pieces the operator has to scan for an order: each line's qty, times the
// parts-per-bundle for a bundle line (see packingItems.js, which does the actual
// expansion at scan time). Orders without items yet count 0 = unknown, and sort
// after orders whose size is known.
function piecesSql(alias) {
  return `(SELECT COALESCE(SUM(oi.qty * COALESCE((SELECT SUM(bi.qty) FROM bundle_items bi WHERE bi.bundle_sku = oi.sku), 1)), 0) FROM order_items oi WHERE oi.order_sn = ${alias}.order_sn)`;
}

// { sql, params }: an "ORDER BY ..." clause. Its params come AFTER every other
// parameter of the statement that precedes it (and before a LIMIT's).
function priorityOrderBy(alias = 'o') {
  const list = getPriorityCarriers();
  const params = [...list];
  const carrier = list.length === 0
    ? 'CAST(0 AS INTEGER)' // not a bare 0: SQLite reads an integer in ORDER BY as a column number
    : `CASE ${list.map((_, i) => `WHEN INSTR(LOWER(COALESCE(${alias}.shipping_carrier, '')), ?) > 0 THEN ${i}`).join(' ')} ELSE ${list.length} END`;
  const sql = `ORDER BY COALESCE(${alias}.is_instant, 0) DESC, ${carrier} ASC, (${piecesSql(alias)} = 0) ASC, ${piecesSql(alias)} ASC, ${alias}.created_at ASC, ${alias}.order_sn ASC`;
  return { sql, params };
}

function carrierRank(carrier, list = getPriorityCarriers()) {
  if (list.length === 0) return 0;
  const c = String(carrier || '').toLowerCase();
  const i = list.findIndex((entry) => c.includes(entry));
  return i === -1 ? list.length : i;
}

// Rows need is_instant, shipping_carrier, pieces, created_at, order_sn.
function priorityCompare(list = getPriorityCarriers()) {
  return (a, b) =>
    (b.is_instant ? 1 : 0) - (a.is_instant ? 1 : 0) ||
    carrierRank(a.shipping_carrier, list) - carrierRank(b.shipping_carrier, list) ||
    ((a.pieces > 0 ? 0 : 1) - (b.pieces > 0 ? 0 : 1)) ||
    (a.pieces || 0) - (b.pieces || 0) ||
    a.created_at - b.created_at ||
    (a.order_sn < b.order_sn ? -1 : a.order_sn > b.order_sn ? 1 : 0);
}

module.exports = { priorityOrderBy, priorityCompare, piecesSql, carrierRank };
