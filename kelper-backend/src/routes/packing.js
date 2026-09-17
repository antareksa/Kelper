const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getOrderDetail } = require('../shopee/client');
const { getConfig } = require('../config');
const { getWIBHour, startOfDayWIB } = require('../wib');
const { isProduction } = require('../env');

const router = express.Router();

function now() {
  return Math.floor(Date.now() / 1000);
}

function touch(sessionId) {
  db.prepare('UPDATE packing_sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId);
}

// Debug mode — mock orders never touch the real Shopee API. Marked by an
// order_sn prefix so the one remaining Shopee-calling step (the leftover
// cancellation recheck) can tell a mock order apart from a real one.
function isMockOrder(orderSn) {
  return typeof orderSn === 'string' && orderSn.startsWith('MOCK-');
}

// order.label_pdf is excluded here (and everywhere else in this file) since
// it's a binary blob only needed by GET /label — including it in every JSON
// response would bloat every scan/status payload for no reason.
function getSessionWithOrder(sessionId) {
  const session = db.prepare('SELECT * FROM packing_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const order = db.prepare(`
    SELECT order_sn, shop_id, status, buyer_name, created_at, is_instant, logistics_channel_id, shipping_carrier, tracking_no, label_ready
    FROM orders WHERE order_sn = ?
  `).get(session.order_sn);
  const items = db.prepare('SELECT * FROM order_items WHERE order_sn = ?').all(session.order_sn);
  const progress = db.prepare('SELECT sku, scanned_qty FROM scan_progress WHERE session_id = ?').all(sessionId);
  const progressBySku = Object.fromEntries(progress.map((p) => [p.sku, p.scanned_qty]));
  // barcode is a display hint only (what the operator should physically scan
  // for this line) — matching itself always goes through the SKU, resolved
  // from the scanned barcode in /scan-item below.
  const itemsWithProgress = items.map((it) => ({
    ...it,
    scanned_qty: progressBySku[it.sku] || 0,
    barcode: db.prepare('SELECT barcode FROM products WHERE sku = ?').get(it.sku)?.barcode ?? null,
  }));
  // length check matters: an order whose items haven't arrived from Shopee
  // yet (get_order_detail can lag well behind label_ready) has zero rows
  // here, and .every() on an empty array is vacuously true — without this
  // guard that order would look "fully scanned" the instant it's opened.
  const allComplete = itemsWithProgress.length > 0 && itemsWithProgress.every((it) => it.scanned_qty === it.qty);
  return { session, order, items: itemsWithProgress, allComplete };
}

// Once items are scanned, the operator's KIRIM_HARI_INI/PACK_BESOK choice is
// no longer manual: the clock decides. Both branches only ever touch local
// storage — the tracking number and label were already fetched by Center
// Station (or its debug-mode mock equivalent) long before this point.
//
// AWAITING_LABEL_SCAN DOES block this station from grabbing the next order
// (see /next-order's resume check below) — printing the label is immediately
// followed by requiring the operator to scan that exact label back as a
// closed-loop confirmation. A failed/never-completed scan is treated as the
// signal that something's wrong with the printer (jam, out of paper, wrong
// tray) — there's no separate print-failure detection, this scan IS the
// health check. Only once that confirm-scan succeeds (see /confirm-print)
// does the order move to READY_FOR_PICKUP, which does NOT block — that
// status just means "waiting for Shipping Mode to confirm the courier took
// it", a separate, later, decoupled step.
function finalizeCompletedOrder(state, res) {
  const { shipCutoffHour } = getConfig().packing;
  // Explicit WIB, not the server's own system clock — a cutoff meant for
  // "before/after 16:00 in Jakarta" must stay 16:00 Jakarta time regardless
  // of what timezone the machine running this happens to be set to.
  const beforeCutoff = getWIBHour() < shipCutoffHour;

  if (beforeCutoff) {
    if (!state.order.tracking_no) {
      return res.status(500).json({ error: 'no_tracking_number', message: 'Order has no pre-fetched tracking number — the server has not labeled it yet' });
    }
    db.prepare(`
      UPDATE packing_sessions
      SET shipping_choice = 'KIRIM_HARI_INI', tracking_no = ?, status = 'AWAITING_LABEL_SCAN'
      WHERE id = ?
    `).run(state.order.tracking_no, state.session.id);
  } else {
    const internalBarcode = `BESOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    db.prepare(`
      UPDATE packing_sessions
      SET shipping_choice = 'PACK_BESOK', internal_barcode = ?, status = 'DEFERRED_READY'
      WHERE id = ?
    `).run(internalBarcode, state.session.id);
    db.prepare("UPDATE orders SET status = 'DEFERRED' WHERE order_sn = ?").run(state.order.order_sn);
  }

  res.json(getSessionWithOrder(state.session.id));
}

// Resumes a leftover (yesterday's DEFERRED_READY) order — used by both the
// leftover branch of NEXT_ORDER and RESUME_BESOK's specific-barcode scan.
// No booking call needed anymore (the server already did that on sync
// day); this just reconfirms the order wasn't cancelled overnight (AC8)
// before serving the label that's already stored.
async function finalizeLeftover(session, order, res) {
  if (isMockOrder(order.order_sn)) {
    db.prepare("UPDATE packing_sessions SET tracking_no = ?, status = 'AWAITING_LABEL_SCAN' WHERE id = ?")
      .run(order.tracking_no, session.id);
    return res.json({ ...getSessionWithOrder(session.id), tracking_no: order.tracking_no });
  }

  try {
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

    // Resuming a leftover reprints the same label it already has — that
    // print still needs the same closed-loop confirm-scan as a fresh one.
    db.prepare("UPDATE packing_sessions SET tracking_no = ?, status = 'AWAITING_LABEL_SCAN' WHERE id = ?")
      .run(order.tracking_no, session.id);
    res.json({ ...getSessionWithOrder(session.id), tracking_no: order.tracking_no });
  } catch (err) {
    // Leave it resumable — a transient Shopee failure shouldn't strand the
    // session in RESUMING with no way back.
    db.prepare("UPDATE packing_sessions SET status = 'DEFERRED_READY' WHERE id = ?").run(session.id);
    res.status(502).json({ error: 'shopee_check_failed', message: err.message });
  }
}

// B. NEXT ORDER — pulls the single highest-priority order from one combined
// pool: yesterday's leftovers (packing_sessions DEFERRED_READY) and today's
// fresh orders (orders READY_TO_PACK, already labeled by the server).
// Priority: Instant-shipment orders first (whichever pool), then leftovers,
// then fresh — FIFO by age within each tier. Replaces the old separate
// NEXT_ORDER_KEMAREN command entirely.
router.post('/next-order', async (req, res) => {
  const { station_id, shop_id, operator_name } = req.body;
  if (!station_id || !shop_id) {
    return res.status(400).json({ error: 'station_id and shop_id are required' });
  }

  // If this station already has an unfinished session (e.g. the browser reloaded
  // mid-order), resume it instead of locking a new one. AWAITING_LABEL_SCAN is
  // included on purpose — the operator hasn't confirmed the label printed
  // correctly yet, so this station must stay put. READY_FOR_PICKUP is
  // deliberately excluded — that confirm-scan already succeeded, so a
  // printed label doesn't block the next order; confirming the courier
  // pickup happens later, separately, in Shipping Mode.
  const existing = db
    .prepare("SELECT id FROM packing_sessions WHERE station_id = ? AND status IN ('IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN') ORDER BY started_at DESC LIMIT 1")
    .get(station_id);
  if (existing) {
    return res.json(getSessionWithOrder(existing.id));
  }

  // No debug branch here anymore — debugMode (config.json) makes the
  // server fabricate mock orders during its own discovery tick instead (see
  // shopeeSync.js), so a debug MOCK- order shows up in this same pool,
  // goes through Processing/Ready to Check exactly like a real one, and gets
  // picked up by the exact same query below.
  //
  // The leftover branch is restricted to orders deferred before today's WIB
  // midnight — without this, an order deferred moments ago tonight (past
  // shipCutoffHour) is immediately eligible again, and with the station's
  // auto-retry polling every 10s while idle, gets picked right back up and
  // resumed through finalizeLeftover (which never re-checks the cutoff,
  // since it's meant for "yesterday's leftover, resumed this morning") —
  // shipping it the very same night and defeating the defer entirely.
  const todayStartWIB = startOfDayWIB(0);
  const pick = db.prepare(`
    SELECT * FROM (
      SELECT ps.id AS session_id, ps.order_sn AS order_sn, ps.started_at AS age, o.is_instant AS is_instant, 'leftover' AS pool
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND ps.last_activity_at < ?
      UNION ALL
      SELECT NULL AS session_id, o.order_sn AS order_sn, o.created_at AS age, o.is_instant AS is_instant, 'fresh' AS pool
      FROM orders o
      WHERE o.shop_id = ? AND o.status = 'READY_TO_PACK' AND o.label_ready = 1
    )
    ORDER BY is_instant DESC, CASE pool WHEN 'leftover' THEN 0 ELSE 1 END ASC, age ASC
    LIMIT 1
  `).get(shop_id, todayStartWIB, shop_id);

  if (!pick) {
    return res.status(404).json({ error: 'no_orders', message: 'No orders ready to pack for this shop' });
  }

  if (pick.pool === 'leftover') {
    db.transaction(() => {
      db.prepare("UPDATE packing_sessions SET station_id = ?, operator_name = ?, status = 'RESUMING' WHERE id = ?")
        .run(station_id, operator_name || null, pick.session_id);
    })();
    const session = db.prepare('SELECT * FROM packing_sessions WHERE id = ?').get(pick.session_id);
    const order = db.prepare('SELECT order_sn, shop_id, status, tracking_no FROM orders WHERE order_sn = ?').get(pick.order_sn);
    return finalizeLeftover(session, order, res);
  }

  const sessionId = db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'LOCKED' WHERE order_sn = ?").run(pick.order_sn);
    const result = db.prepare(`
      INSERT INTO packing_sessions (order_sn, station_id, operator_name, status, started_at, last_activity_at)
      VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)
    `).run(pick.order_sn, station_id, operator_name || null, now(), now());
    return result.lastInsertRowid;
  })();

  res.json(getSessionWithOrder(sessionId));
});

// C. ITEM SCAN — reject wrong SKU or over-quantity, otherwise increment
// progress. Once the last item lands, auto-decide ship-today vs. defer.
//
// The operator scans the product's real physical barcode, not the internal
// SKU printed nowhere on the box — so the scanned value is resolved against
// the client's own HPP/barcode import (products.barcode) first. A scanned
// value that isn't a known barcode is still tried as a raw SKU directly,
// which keeps this working for debug/mock items that have no barcode at all.
router.post('/scan-item', (req, res) => {
  const { session_id, sku: scannedValue } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (state.session.status !== 'IN_PROGRESS') {
    return res.status(400).json({ error: 'session_not_active', status: state.session.status });
  }

  const resolved = db.prepare('SELECT sku FROM products WHERE barcode = ?').get(scannedValue);
  const sku = resolved ? resolved.sku : scannedValue;

  const item = state.items.find((it) => it.sku === sku);
  if (!item) {
    const label = sku === scannedValue ? sku : `${scannedValue} (SKU ${sku})`;
    return res.status(400).json({ error: 'wrong_item', message: `${label} is not part of this order` });
  }
  if (item.scanned_qty >= item.qty) {
    return res.status(400).json({ error: 'over_qty', message: `${sku} already fully scanned` });
  }

  db.prepare(`
    INSERT INTO scan_progress (session_id, sku, scanned_qty) VALUES (?, ?, 1)
    ON CONFLICT(session_id, sku) DO UPDATE SET scanned_qty = scanned_qty + 1
  `).run(session_id, sku);
  touch(session_id);

  const updated = getSessionWithOrder(session_id);
  if (updated.allComplete) {
    return finalizeCompletedOrder(updated, res);
  }
  res.json(updated);
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
// still IN_PROGRESS: once a real Shopee shipment is booked (AWAITING_LABEL_SCAN
// onward), releasing it back to READY_TO_PACK would be wrong — Shopee already
// thinks it's shipped, so that state needs a different resolution (REPRINT,
// not a re-pack).
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

// Pack Besok step D — next-day scan of the specific internal barcode on a
// physical package (the operator has a known package in hand). Distinct from
// NEXT_ORDER's generic highest-priority pick. Claims the session
// synchronously before any async work, the same reasoning as NEXT_ORDER's
// locking — two near-simultaneous scans of the same barcode shouldn't both
// succeed.
router.post('/resume-besok', async (req, res) => {
  const { internal_barcode } = req.body;
  const todayStartWIB = startOfDayWIB(0);

  // Same same-night guard as NEXT_ORDER's leftover pool — a BESOK- barcode
  // printed minutes ago (deferred tonight, after cutoff) isn't resumable
  // until tomorrow, even if physically scanned early by mistake. Checked
  // separately from the claim below so an operator scanning it too early
  // gets told that, instead of the generic "barcode not found".
  const found = db.prepare("SELECT last_activity_at FROM packing_sessions WHERE internal_barcode = ? AND status = 'DEFERRED_READY'").get(internal_barcode);
  if (found && found.last_activity_at >= todayStartWIB) {
    return res.status(400).json({ error: 'too_early', message: 'This order was set aside tonight — it can only be resumed tomorrow, not the same night.' });
  }

  const claim = db.transaction(() => {
    const s = db.prepare("SELECT * FROM packing_sessions WHERE internal_barcode = ? AND status = 'DEFERRED_READY' AND last_activity_at < ?").get(internal_barcode, todayStartWIB);
    if (!s) return null;
    db.prepare("UPDATE packing_sessions SET status = 'RESUMING' WHERE id = ?").run(s.id);
    return s;
  });
  const session = claim();
  if (!session) return res.status(404).json({ error: 'barcode_not_found' });

  const order = db.prepare('SELECT order_sn, shop_id, status, tracking_no FROM orders WHERE order_sn = ?').get(session.order_sn);
  await finalizeLeftover(session, order, res);
});

// CONFIRM PRINT — the closed-loop check that a just-printed label actually
// came out of the printer correctly: right after finalizeCompletedOrder /
// finalizeLeftover print the label, the station blocks (AWAITING_LABEL_SCAN)
// until the operator scans that same label back. The barcode on a real
// Shopee label encodes the order id ("No. Pesanan" / order_sn), not the
// tracking/shipping number — confirmed against a real printed label. A
// mismatch (or the operator giving up and scanning RELEASE_ORDER-equivalent
// elsewhere) is treated as "something's wrong with the printer" — there is
// deliberately no separate print-failure detection beyond this scan.
router.post('/confirm-print', (req, res) => {
  const { session_id, order_sn: scannedOrderSn } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (state.session.status !== 'AWAITING_LABEL_SCAN') {
    return res.status(400).json({ error: 'not_awaiting_label_scan', status: state.session.status });
  }
  if (scannedOrderSn !== state.order.order_sn) {
    return res.status(400).json({
      error: 'label_mismatch',
      message: `Scanned ${scannedOrderSn} doesn't match this order (${state.order.order_sn}) — printer may not have printed the right label. Scan REPRINT to try again.`,
    });
  }

  db.prepare("UPDATE packing_sessions SET status = 'READY_FOR_PICKUP' WHERE id = ?").run(session_id);
  res.json(getSessionWithOrder(session_id));
});

// SHIPPING MODE — CONFIRM PICKUP. Scanning a packed label's barcode marks
// that specific package Done and removes it from the Ready to Pickup pool.
// Deliberately decoupled from any station's active session_id: Shipping
// Mode is a separate, later pass over whatever's sitting in
// READY_FOR_PICKUP — it isn't "inside" the session that packed the order,
// and may well happen from a different station (or a batch, when the
// courier arrives) than the one that did the packing.
//
// The barcode actually printed on a real Shopee label encodes the order id
// ("No. Pesanan" / order_sn), not the tracking/shipping number — confirmed
// against a real printed label.
router.post('/confirm-pickup', (req, res) => {
  const { order_sn: scannedOrderSn } = req.body;
  const session = db.prepare("SELECT * FROM packing_sessions WHERE order_sn = ? AND status = 'READY_FOR_PICKUP'").get(scannedOrderSn);
  if (!session) {
    return res.status(400).json({ error: 'not_ready_for_pickup', message: `${scannedOrderSn} is not in the Ready to Pickup pool` });
  }

  db.prepare("UPDATE packing_sessions SET status = 'DONE', completed_at = ? WHERE id = ?").run(now(), session.id);
  db.prepare("UPDATE orders SET status = 'DONE' WHERE order_sn = ?").run(scannedOrderSn);

  // Shopee "confirm pickup" API: not currently used anywhere in this
  // codebase, and unconfirmed whether one exists/is required for
  // pickup-method orders — call it here if/when that's settled.

  res.json({ ok: true, order_sn: scannedOrderSn });
});

// REPRINT RESI — returns the existing label, never creates a new shipment
// (AC9). Used both while AWAITING_LABEL_SCAN (the confirm-scan didn't match,
// or nothing came out of the printer at all) and, less commonly, afterward.
router.post('/reprint', (req, res) => {
  const { session_id } = req.body;
  const state = getSessionWithOrder(session_id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  if (!state.session.tracking_no) {
    return res.status(400).json({ error: 'no_label_yet' });
  }
  res.json({ tracking_no: state.session.tracking_no, reprinted: true });
});

// Label PDF, served purely from local storage — the server (real or
// debug-mode mock) already fetched/generated it, so this never calls Shopee
// and is trivially safe to call repeatedly (REPRINT RESI, AC9).
router.get('/label/:session_id', (req, res) => {
  const session = db.prepare('SELECT order_sn FROM packing_sessions WHERE id = ?').get(req.params.session_id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const order = db.prepare('SELECT label_pdf FROM orders WHERE order_sn = ?').get(session.order_sn);
  if (!order?.label_pdf) return res.status(400).json({ error: 'no_label_yet' });

  res.setHeader('Content-Type', 'application/pdf');
  res.send(order.label_pdf);
});

router.get('/session/:id', (req, res) => {
  const state = getSessionWithOrder(req.params.id);
  if (!state) return res.status(404).json({ error: 'session_not_found' });
  res.json(state);
});

// Admin/dashboard view of the pools from the flow diagram:
// - "Processing": discovered from Shopee (exists locally) but the server
//   hasn't finished booking/labeling it yet — either still working
//   through it this tick, or stuck retrying on something like Shopee's
//   "package not ready to be shipped" window.
// - "Ready to check": discovered + labeled by the server, not yet
//   claimed by any Packing Station.
// - "On progress check": actively being packed right now — a Packing
//   Station has claimed it and is scanning items (or re-validating a resumed leftover),
//   or has printed a label and is waiting on the operator's confirm-scan
//   (AWAITING_LABEL_SCAN) — still "in the station's hands", not yet ready.
// - "Ready to pickup": label printed AND confirm-scanned back successfully,
//   waiting for Shipping Mode to confirm the courier took it.
// - "Ready to process tomorrow": deferred (Pack Besok) — already scanned,
//   waiting to be resumed and given a real label the next day.
router.get('/order-lists', (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const processing = db
    .prepare(`
      SELECT order_sn, buyer_name, created_at
      FROM orders
      WHERE shop_id = ? AND status = 'READY_TO_PACK' AND label_ready = 0
      ORDER BY created_at ASC
    `)
    .all(shop_id);

  const readyToCheck = db
    .prepare(`
      SELECT o.order_sn, o.buyer_name, o.created_at, o.is_instant
      FROM orders o
      WHERE o.shop_id = ? AND o.status = 'READY_TO_PACK' AND o.label_ready = 1
        AND NOT EXISTS (
          SELECT 1 FROM packing_sessions ps
          WHERE ps.order_sn = o.order_sn AND ps.status IN ('IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN', 'READY_FOR_PICKUP')
        )
      ORDER BY o.is_instant DESC, o.created_at ASC
    `)
    .all(shop_id);

  const onProgressCheck = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.started_at, ps.status, o.buyer_name
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status IN ('IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN') AND o.shop_id = ?
      ORDER BY ps.started_at ASC
    `)
    .all(shop_id);

  const readyForPickup = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.last_activity_at, o.tracking_no, o.buyer_name
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'READY_FOR_PICKUP' AND o.shop_id = ?
      ORDER BY ps.last_activity_at ASC
    `)
    .all(shop_id);

  const readyTomorrow = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.internal_barcode, o.buyer_name
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ?
      ORDER BY ps.started_at ASC
    `)
    .all(shop_id);

  res.json({ processing, readyToCheck, onProgressCheck, readyForPickup, readyTomorrow });
});

// Test-only helper: simulate a Shopee cancellation happening overnight, to
// exercise the Pack Besok cancellation check (AC8) without real webhook wiring.
// Cancels ANY order_sn with no auth or validation — must not exist in
// production, where it would let anyone who finds the URL cancel a real,
// live order.
if (!isProduction) {
  router.post('/mock-cancel-order', (req, res) => {
    const { order_sn } = req.body;
    db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_sn = ?").run(order_sn);
    res.json({ ok: true });
  });
}

module.exports = router;
