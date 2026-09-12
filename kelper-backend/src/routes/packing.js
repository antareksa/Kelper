const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getOrderDetail, downloadShippingDocument } = require('../shopee/client');
const { bookShipment } = require('../shopee/shipping');
const { getConfig } = require('../config');

const router = express.Router();

function now() {
  return Math.floor(Date.now() / 1000);
}

function touch(sessionId) {
  db.prepare('UPDATE packing_sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId);
}

// Debug mode — mock orders never touch the real Shopee API. Marked by an
// order_sn prefix so every downstream step (shipping, labels, cancellation
// recheck) can tell a mock order apart from a real synced one.
function isMockOrder(orderSn) {
  return typeof orderSn === 'string' && orderSn.startsWith('MOCK-');
}

const MOCK_ITEMS = [
  { sku: 'MOCK-SKU-1', product_name: 'Mock Product A', qty: 2 },
  { sku: 'MOCK-SKU-2', product_name: 'Mock Product B', qty: 1 },
];

function createMockOrder(shopId) {
  const orderSn = `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  db.prepare(`
    INSERT INTO orders (order_sn, shop_id, status, buyer_name, created_at)
    VALUES (?, ?, 'LOCKED', 'Debug Buyer', ?)
  `).run(orderSn, shopId, now());
  for (const item of MOCK_ITEMS) {
    db.prepare('INSERT INTO order_items (order_sn, sku, product_name, qty) VALUES (?, ?, ?, ?)')
      .run(orderSn, item.sku, item.product_name, item.qty);
  }
  return orderSn;
}

// Builds a tiny valid PDF from scratch (no external deps) so debug-mode
// "labels" can flow through the same print/reprint/download paths as a real
// Shopee label, without ever calling Shopee.
function buildMockPdf(labelText) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 200] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // filled in below (needs the stream length)
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 20 150 Td (${labelText}) Tj ET`;
  objects[3] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((content, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${content}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body, 'latin1');
}

function getSessionWithOrder(sessionId) {
  const session = db.prepare('SELECT * FROM packing_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(session.order_sn);
  const items = db.prepare('SELECT * FROM order_items WHERE order_sn = ?').all(session.order_sn);
  const progress = db.prepare('SELECT sku, scanned_qty FROM scan_progress WHERE session_id = ?').all(sessionId);
  const progressBySku = Object.fromEntries(progress.map((p) => [p.sku, p.scanned_qty]));
  const itemsWithProgress = items.map((it) => ({
    ...it,
    scanned_qty: progressBySku[it.sku] || 0,
  }));
  const allComplete = itemsWithProgress.every((it) => it.scanned_qty === it.qty);
  return { session, order, items: itemsWithProgress, allComplete };
}

// B. NEXT ORDER — atomically lock the next ready order for this station's shop.
// better-sqlite3 runs synchronously on a single connection, so this select+update
// pair cannot interleave with a concurrent request — that's what satisfies AC1.
router.post('/next-order', (req, res) => {
  const { station_id, shop_id, operator_name, debug } = req.body;
  if (!station_id || !shop_id) {
    return res.status(400).json({ error: 'station_id and shop_id are required' });
  }

  // If this station already has an unfinished session (e.g. the browser reloaded
  // mid-order), resume it instead of locking a new one.
  const existing = db
    .prepare("SELECT id FROM packing_sessions WHERE station_id = ? AND status IN ('IN_PROGRESS', 'AWAITING_LABEL_SCAN') ORDER BY started_at DESC LIMIT 1")
    .get(station_id);
  if (existing) {
    return res.json(getSessionWithOrder(existing.id));
  }

  const lockNext = db.transaction(() => {
    let orderSn;
    if (debug) {
      orderSn = createMockOrder(shop_id);
    } else {
      const next = db
        .prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' ORDER BY created_at ASC LIMIT 1")
        .get(shop_id);
      if (!next) return null;
      db.prepare("UPDATE orders SET status = 'LOCKED' WHERE order_sn = ?").run(next.order_sn);
      orderSn = next.order_sn;
    }

    const result = db.prepare(`
      INSERT INTO packing_sessions (order_sn, station_id, operator_name, status, started_at, last_activity_at)
      VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)
    `).run(orderSn, station_id, operator_name || null, now(), now());

    return result.lastInsertRowid;
  });

  const sessionId = lockNext();
  if (!sessionId) {
    return res.status(404).json({ error: 'no_orders', message: 'No orders ready to pack for this shop' });
  }

  res.json(getSessionWithOrder(sessionId));
});

// C. ITEM SCAN — reject wrong SKU or over-quantity, otherwise increment progress.
router.post('/scan-item', (req, res) => {
  const { session_id, sku } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (state.session.status !== 'IN_PROGRESS') {
    return res.status(400).json({ error: 'session_not_active', status: state.session.status });
  }

  const item = state.items.find((it) => it.sku === sku);
  if (!item) {
    return res.status(400).json({ error: 'wrong_item', message: `${sku} is not part of this order` });
  }
  if (item.scanned_qty >= item.qty) {
    return res.status(400).json({ error: 'over_qty', message: `${sku} already fully scanned` });
  }

  db.prepare(`
    INSERT INTO scan_progress (session_id, sku, scanned_qty) VALUES (?, ?, 1)
    ON CONFLICT(session_id, sku) DO UPDATE SET scanned_qty = scanned_qty + 1
  `).run(session_id, sku);
  touch(session_id);

  res.json(getSessionWithOrder(session_id));
});

router.post('/undo-last-scan', (req, res) => {
  const { session_id, sku } = req.body;
  const row = db.prepare('SELECT scanned_qty FROM scan_progress WHERE session_id = ? AND sku = ?').get(session_id, sku);
  if (!row || row.scanned_qty <= 0) {
    return res.status(400).json({ error: 'nothing_to_undo' });
  }
  db.prepare('UPDATE scan_progress SET scanned_qty = scanned_qty - 1 WHERE session_id = ? AND sku = ?').run(session_id, sku);
  touch(session_id);
  res.json(getSessionWithOrder(session_id));
});

router.post('/masalah', (req, res) => {
  const { session_id } = req.body;
  db.prepare("UPDATE packing_sessions SET status = 'EXCEPTION' WHERE id = ?").run(session_id);
  res.json(getSessionWithOrder(session_id));
});

// RELEASE_ORDER — let a stuck order (operator started it and never came back)
// go back into the pool for any station to pick up fresh. Only valid while
// still IN_PROGRESS: once a real Shopee shipment is booked (AWAITING_LABEL_SCAN),
// releasing it back to READY_TO_PACK would be wrong — Shopee already thinks
// it's shipped, so that state needs a different resolution, not a re-pack.
router.post('/release-order', (req, res) => {
  const { session_id } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (state.session.status !== 'IN_PROGRESS') {
    return res.status(400).json({
      error: 'cannot_release',
      message: `Can't release a session in status ${state.session.status}`,
    });
  }

  const release = db.transaction(() => {
    db.prepare('DELETE FROM scan_progress WHERE session_id = ?').run(session_id);
    db.prepare('DELETE FROM packing_sessions WHERE id = ?').run(session_id);
    db.prepare("UPDATE orders SET status = 'READY_TO_PACK' WHERE order_sn = ?").run(state.order.order_sn);
  });
  release();

  res.json({ ok: true, order_sn: state.order.order_sn });
});

// Auto-release sessions nobody has touched in over an hour, so an operator
// walking away mid-order doesn't strand it forever. Both the timeout and how
// often this check runs are config-driven (config.json's `session` block) —
// re-read on every tick via a recursive setTimeout (rather than a fixed
// setInterval) so editing config.json with a text editor takes effect on the
// very next tick, no server restart needed.
function releaseStaleSessions() {
  const { staleSessionSeconds } = getConfig().session;
  const cutoff = now() - staleSessionSeconds;
  const stale = db
    .prepare("SELECT id, order_sn FROM packing_sessions WHERE status = 'IN_PROGRESS' AND last_activity_at < ?")
    .all(cutoff);

  for (const s of stale) {
    const release = db.transaction(() => {
      db.prepare('DELETE FROM scan_progress WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM packing_sessions WHERE id = ?').run(s.id);
      db.prepare("UPDATE orders SET status = 'READY_TO_PACK' WHERE order_sn = ?").run(s.order_sn);
    });
    release();
  }
}
function scheduleStaleCheck() {
  releaseStaleSessions();
  setTimeout(scheduleStaleCheck, getConfig().session.staleCheckIntervalMs);
}
scheduleStaleCheck();

// F/G. KIRIM HARI INI — real Shopee Logistics call: books the shipment
// (logistics/ship_order), then generates the real label document.
router.post('/ship-today', async (req, res) => {
  const { session_id } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (!state.allComplete) return res.status(400).json({ error: 'items_incomplete' });

  try {
    const trackingNo = isMockOrder(state.order.order_sn)
      ? `MOCKTRACK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
      : await bookShipment(await getValidAccessToken(state.order.shop_id), state.order.shop_id, state.order.order_sn);

    db.prepare(`
      UPDATE packing_sessions
      SET shipping_choice = 'KIRIM_HARI_INI', tracking_no = ?, status = 'AWAITING_LABEL_SCAN'
      WHERE id = ?
    `).run(trackingNo, session_id);

    res.json({ ...getSessionWithOrder(session_id), tracking_no: trackingNo });
  } catch (err) {
    res.status(502).json({ error: 'shopee_shipping_failed', message: err.message });
  }
});

// Pack Besok step A/B — defer resi, print an internal (non-Shopee) barcode instead.
router.post('/pack-besok', (req, res) => {
  const { session_id } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (!state.allComplete) return res.status(400).json({ error: 'items_incomplete' });

  const internalBarcode = `BESOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  db.prepare(`
    UPDATE packing_sessions
    SET shipping_choice = 'PACK_BESOK', internal_barcode = ?, status = 'DEFERRED_READY'
    WHERE id = ?
  `).run(internalBarcode, session_id);
  db.prepare("UPDATE orders SET status = 'DEFERRED' WHERE order_sn = ?").run(state.order.order_sn);

  res.json({ ...getSessionWithOrder(session_id), internal_barcode: internalBarcode });
});

// Shared by resume-besok and next-besok once each has claimed its session:
// rechecks the REAL order status via Shopee order/get_order_detail before
// generating the resi, and blocks it if the order was cancelled overnight (AC8).
async function recheckAndShip(session, order, res) {
  try {
    if (isMockOrder(order.order_sn)) {
      const trackingNo = `MOCKTRACK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      db.prepare(`
        UPDATE packing_sessions SET tracking_no = ?, status = 'AWAITING_LABEL_SCAN' WHERE id = ?
      `).run(trackingNo, session.id);
      return res.json({ ...getSessionWithOrder(session.id), tracking_no: trackingNo });
    }

    const accessToken = await getValidAccessToken(order.shop_id);
    const detail = await getOrderDetail(accessToken, order.shop_id, [order.order_sn]);
    const liveStatus = detail.response?.order_list?.[0]?.order_status;

    if (liveStatus === 'CANCELLED' || order.status === 'CANCELLED') {
      db.prepare("UPDATE packing_sessions SET status = 'EXCEPTION' WHERE id = ?").run(session.id);
      db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_sn = ?").run(order.order_sn);
      return res.status(400).json({
        error: 'order_cancelled',
        message: `Order was cancelled overnight (Shopee status: ${liveStatus}) — resi generation blocked`,
      });
    }

    const trackingNo = await bookShipment(accessToken, order.shop_id, order.order_sn);
    db.prepare(`
      UPDATE packing_sessions SET tracking_no = ?, status = 'AWAITING_LABEL_SCAN' WHERE id = ?
    `).run(trackingNo, session.id);

    res.json({ ...getSessionWithOrder(session.id), tracking_no: trackingNo });
  } catch (err) {
    // Leave it resumable — a transient Shopee failure (e.g. tracking number not
    // assigned yet) shouldn't strand the session in RESUMING with no way back.
    db.prepare("UPDATE packing_sessions SET status = 'DEFERRED_READY' WHERE id = ?").run(session.id);
    res.status(502).json({ error: 'shopee_shipping_failed', message: err.message });
  }
}

// Pack Besok step D — next-day scan of the specific internal barcode on a
// physical package. Claims the session synchronously before any async Shopee
// calls, the same way next-order claims an order — otherwise two
// near-simultaneous scans of the same barcode could both pass the status
// check and both call bookShipment before either write-back lands.
router.post('/resume-besok', async (req, res) => {
  const { internal_barcode } = req.body;

  const claim = db.transaction(() => {
    const s = db.prepare("SELECT * FROM packing_sessions WHERE internal_barcode = ? AND status = 'DEFERRED_READY'").get(internal_barcode);
    if (!s) return null;
    db.prepare("UPDATE packing_sessions SET status = 'RESUMING' WHERE id = ?").run(s.id);
    return s;
  });
  const session = claim();
  if (!session) return res.status(404).json({ error: 'barcode_not_found' });

  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(session.order_sn);
  await recheckAndShip(session, order, res);
});

// NEXT_ORDER_KEMAREN — same idea as NEXT_ORDER, but pulls the oldest
// Pack-Besok order waiting for this shop instead of a fresh one, for when the
// operator doesn't need to match a specific physical package/barcode by hand.
router.post('/next-besok', async (req, res) => {
  const { station_id, shop_id, operator_name } = req.body;
  if (!station_id || !shop_id) {
    return res.status(400).json({ error: 'station_id and shop_id are required' });
  }

  const claim = db.transaction(() => {
    const s = db.prepare(`
      SELECT ps.* FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ?
      ORDER BY ps.started_at ASC LIMIT 1
    `).get(shop_id);
    if (!s) return null;
    db.prepare("UPDATE packing_sessions SET status = 'RESUMING', station_id = ?, operator_name = ? WHERE id = ?")
      .run(station_id, operator_name || null, s.id);
    return s;
  });
  const session = claim();
  if (!session) return res.status(404).json({ error: 'no_deferred_orders', message: 'No Pack Besok orders waiting for this shop' });

  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(session.order_sn);
  await recheckAndShip(session, order, res);
});

// G/H. LABEL SCAN — confirm the printed label matches this order, mark Done.
router.post('/label-scan', (req, res) => {
  const { session_id, tracking_no } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (state.session.status !== 'AWAITING_LABEL_SCAN') {
    return res.status(400).json({ error: 'not_awaiting_label' });
  }
  if (tracking_no !== state.session.tracking_no) {
    return res.status(400).json({ error: 'label_mismatch' });
  }

  db.prepare("UPDATE packing_sessions SET status = 'DONE', completed_at = ? WHERE id = ?").run(now(), session_id);
  db.prepare("UPDATE orders SET status = 'DONE' WHERE order_sn = ?").run(state.order.order_sn);

  res.json(getSessionWithOrder(session_id));
});

// REPRINT RESI — returns the existing label, never creates a new shipment (AC9).
router.post('/reprint', (req, res) => {
  const { session_id } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (!state.session.tracking_no) {
    return res.status(400).json({ error: 'no_label_yet' });
  }
  res.json({ tracking_no: state.session.tracking_no, reprinted: true });
});

// Real label PDF, fetched from Shopee each time — safe to call repeatedly
// (REPRINT RESI) since it never re-books the shipment (AC9).
router.get('/label/:session_id', async (req, res) => {
  const state = getSessionWithOrder(req.params.session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (!state.session.tracking_no) return res.status(400).json({ error: 'no_label_yet' });

  if (isMockOrder(state.order.order_sn)) {
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(buildMockPdf(`MOCK LABEL - ${state.session.tracking_no}`));
  }

  try {
    const accessToken = await getValidAccessToken(state.order.shop_id);
    const result = await downloadShippingDocument(accessToken, state.order.shop_id, state.order.order_sn, state.session.tracking_no);
    if (!result.pdf) {
      return res.status(502).json({ error: 'download_failed', ...result });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.send(result.pdf);
  } catch (err) {
    res.status(502).json({ error: 'shopee_shipping_failed', message: err.message });
  }
});

router.get('/session/:id', (req, res) => {
  const state = getSessionWithOrder(req.params.id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  res.json(state);
});

// Test-only helper: simulate a Shopee cancellation happening overnight, to
// exercise the Pack Besok cancellation check (AC8) without real webhook wiring.
router.post('/mock-cancel-order', (req, res) => {
  const { order_sn } = req.body;
  db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_sn = ?").run(order_sn);
  res.json({ ok: true });
});

module.exports = router;
