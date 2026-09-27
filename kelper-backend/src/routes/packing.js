const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getOrderDetail, cancelOrder } = require('../shopee/client');
const { requireAdminAuth } = require('../adminSession');
const { getConfig } = require('../config');
const { isProduction } = require('../env');
const { getOrderDelaySeconds, getPackingSettings, setPackingSettings, isWithinWorkHour, getReadyToCheckStuckSeconds } = require('../packingSettings');
const { startOfDayWIB } = require('../wib');

const router = express.Router();

function now() {
  return Math.floor(Date.now() / 1000);
}

function touch(sessionId) {
  db.prepare('UPDATE packing_sessions SET last_activity_at = ? WHERE id = ?').run(now(), sessionId);
}

// Client-requested (2026-09-25): the manual dashboard stock (products.stock,
// see db.js) is consumed as items get physically scanned for shipping, and
// restored if a scan is undone. A SKU with no dashboard stock entered yet
// (NULL) stays NULL either way — nothing to consume, per the "unknown is
// never treated as zero" rule — and consumption never goes below zero.
const consumeStock = db.prepare(`
  UPDATE products SET stock = MAX(stock - 1, 0), updated_at = ? WHERE sku = ? AND stock IS NOT NULL
`);
const restoreStock = db.prepare(`
  UPDATE products SET stock = stock + 1, updated_at = ? WHERE sku = ? AND stock IS NOT NULL
`);

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
    SELECT order_sn, shop_id, status, buyer_name, created_at, is_instant, logistics_channel_id, shipping_carrier, tracking_no, label_ready, label_printed
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
    // Same model-then-item image fallback as products.js's catalog listing —
    // purely cosmetic (the Packing Station thumbnail), never used for
    // matching a scan, so a SKU with no synced catalog entry just shows no
    // image instead of failing anything.
    image_url: db.prepare(`
      SELECT COALESCE(m.image_url, i.image_url) AS image_url
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      WHERE COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) = ?
    `).get(it.sku)?.image_url ?? null,
  }));
  // length check matters: an order whose items haven't arrived from Shopee
  // yet (get_order_detail can lag well behind label_ready) has zero rows
  // here, and .every() on an empty array is vacuously true — without this
  // guard that order would look "fully scanned" the instant it's opened.
  const allComplete = itemsWithProgress.length > 0 && itemsWithProgress.every((it) => it.scanned_qty === it.qty);
  // Lets the frontend pick the right "please wait" copy for a just-deferred
  // order (real label coming soon vs. only a temp barcode until work hour
  // reopens) without duplicating the WIB work-hour window logic client-side.
  return { session, order, items: itemsWithProgress, allComplete, withinWorkHour: isWithinWorkHour() };
}

// Once items are scanned, the ship-today/pack-besok choice is no longer
// manual, and (as of the 2026-09-22 work-hour redesign) no longer a clock
// check either — it's simply whether Shopee has already given this order a
// real label. Booking now happens on its own schedule, gated on work hour
// (see shopeeSync.js's bookAndLabelPendingOrders/bookDeferredOrders), fully
// independent of when an operator happens to finish scanning it.
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
  if (state.order.label_ready && state.order.tracking_no) {
    db.prepare(`
      UPDATE packing_sessions
      SET shipping_choice = 'KIRIM_HARI_INI', tracking_no = ?, status = 'AWAITING_LABEL_SCAN'
      WHERE id = ?
    `).run(state.order.tracking_no, state.session.id);
    console.log(`[server] bucket: ${state.order.order_sn} -> On Progress Check (AWAITING_LABEL_SCAN) — frontend will now attempt to print the label`);
  } else {
    const internalBarcode = `BESOK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    db.prepare(`
      UPDATE packing_sessions
      SET shipping_choice = 'PACK_BESOK', internal_barcode = ?, status = 'DEFERRED_READY'
      WHERE id = ?
    `).run(internalBarcode, state.session.id);
    db.prepare("UPDATE orders SET status = 'DEFERRED' WHERE order_sn = ?").run(state.order.order_sn);
    console.log(`[server] bucket: ${state.order.order_sn} -> Ready to Process Tomorrow (temp barcode ${internalBarcode})`);
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

// B. NEXT ORDER — pulls the single highest-priority fresh order (orders
// READY_TO_PACK). Deliberately does NOT auto-pick leftovers (packing_sessions
// DEFERRED_READY) the way it used to — client-requested (2026-09-23): a Pack
// Besok box can only ever be identified by its own temp barcode, so resuming
// one must always go through an explicit /resume-besok scan of that exact
// code — EXCEPT it does not immediately print anything for one: a labeled
// Pack Besok leftover is auto-assigned into RESUMING and handed back as-is,
// still requiring the operator to scan its own BESOK- barcode (see
// /resume-besok, which now also accepts a RESUMING session already assigned
// to a station) before finalizeLeftover ever runs. Client-requested
// (2026-09-23): "Ready to Check" orders — including labeled leftovers — are
// automatically brought to whichever station is free, but the operator must
// still physically confirm they have the right box via that scan; auto-
// picking straight into a print (the old behavior) skipped that
// confirmation and left the operator with no way to know which box the
// system had picked (confirmed against production on order 260923QG061V7A).
// An unlabeled leftover (still in Processing/Ready to Process Tomorrow) is
// never auto-picked here — nothing to hand a station yet.
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
  // goes through Ready to Check exactly like a real one, and gets picked up
  // by the exact same query below.
  //
  // DURING work hour, an order must already be booked (label_ready = 1)
  // before it's claimable — a station must never grab it while
  // shopeeSync.js's bookAndLabelPendingOrders is still in flight for it, or
  // a fast operator can finish scanning before that booking call returns
  // and get needlessly deferred to a temp barcode even though a real label
  // was moments away (confirmed happening in production: order
  // 260923QAHDPSY8 was claimed and fully scanned in 3s while its own
  // booking call, already ~10s in, hadn't finished). OUTSIDE work hour, no
  // booking is going to happen at all until the window reopens, so
  // label_ready is irrelevant and the delay (getOrderDelaySeconds) is the
  // only gate — that's the whole point of letting an order be packed with
  // just a temp barcode.
  const cutoff = now() - getOrderDelaySeconds();
  const withinWorkHour = isWithinWorkHour();
  const pick = db.prepare(`
    SELECT * FROM (
      SELECT ps.id AS session_id, ps.order_sn AS order_sn, ps.started_at AS age, o.is_instant AS is_instant, 'leftover' AS pool
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND o.label_ready = 1
      UNION ALL
      SELECT NULL AS session_id, o.order_sn AS order_sn, o.created_at AS age, o.is_instant AS is_instant, 'fresh' AS pool
      FROM orders o
      WHERE o.shop_id = ? AND o.status = 'READY_TO_PACK' AND o.created_at <= ?
        AND (o.label_ready = 1 OR ? = 0)
    )
    ORDER BY is_instant DESC, CASE pool WHEN 'leftover' THEN 0 ELSE 1 END ASC, age ASC
    LIMIT 1
  `).get(shop_id, shop_id, cutoff, withinWorkHour ? 1 : 0);

  if (!pick) {
    return res.status(404).json({ error: 'no_orders', message: 'No orders ready to pack for this shop' });
  }

  if (pick.pool === 'leftover') {
    // Auto-assign only — deliberately does NOT call finalizeLeftover here.
    // The operator still has to scan this exact session's BESOK- barcode
    // (see /resume-besok) before anything prints; this just brings the
    // order to the station and tells it (via getSessionWithOrder's
    // allComplete + the order's internal_barcode) which one to look for.
    db.prepare("UPDATE packing_sessions SET station_id = ?, operator_name = ?, status = 'RESUMING' WHERE id = ?")
      .run(station_id, operator_name || null, pick.session_id);
    console.log(`[server] bucket: ${pick.order_sn} -> On Progress Check (RESUMING, auto-assigned to ${station_id}) — awaiting temp barcode scan`);
    return res.json(getSessionWithOrder(pick.session_id));
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
  consumeStock.run(now(), sku);
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
  restoreStock.run(now(), sku);
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

  // Gated on label_ready now, not a wall-clock guess — a BESOK- barcode
  // isn't resumable until shopeeSync.js's bookDeferredOrders has actually
  // booked it during work hour, since there's no label to print before
  // then. Checked separately from the claim below so an operator scanning
  // it too early gets told that specifically, instead of a generic
  // "barcode not found".
  //
  // Status can be DEFERRED_READY (a direct lookup — the operator already
  // knows this barcode, e.g. from the Ready to Process Tomorrow list) or
  // RESUMING (this session was already auto-assigned to a station by
  // /next-order — see there — and this scan is the required confirmation
  // before finalizeLeftover actually runs). Either way the barcode itself
  // is what's being verified, not who claimed it first.
  const found = db
    .prepare(`
      SELECT o.label_ready FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.internal_barcode = ? AND ps.status IN ('DEFERRED_READY', 'RESUMING')
    `)
    .get(internal_barcode);
  if (found && !found.label_ready) {
    return res.status(400).json({ error: 'label_not_ready', message: "This order's label isn't ready yet — it'll book automatically once work hour starts." });
  }

  const claim = db.transaction(() => {
    const s = db
      .prepare(`
        SELECT ps.* FROM packing_sessions ps
        JOIN orders o ON o.order_sn = ps.order_sn
        WHERE ps.internal_barcode = ? AND ps.status IN ('DEFERRED_READY', 'RESUMING') AND o.label_ready = 1
      `)
      .get(internal_barcode);
    if (!s) return null;
    db.prepare("UPDATE packing_sessions SET status = 'RESUMING' WHERE id = ?").run(s.id);
    return s;
  });
  const session = claim();
  if (!session) return res.status(404).json({ error: 'barcode_not_found' });

  const order = db.prepare('SELECT order_sn, shop_id, status, tracking_no FROM orders WHERE order_sn = ?').get(session.order_sn);
  console.log(`[server] bucket: ${order.order_sn} -> On Progress Check (AWAITING_LABEL_SCAN) — barcode ${internal_barcode} confirmed, frontend will now attempt to print the real label`);
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
  db.prepare('UPDATE orders SET label_printed = 1 WHERE order_sn = ?').run(state.order.order_sn);
  console.log(`[server] bucket: ${state.order.order_sn} -> Ready to Pickup (label_printed confirmed via scan)`);
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
// Shared by the route below and the "Force All Pickup" bulk action. Returns
// the picked-up timestamp, or null if the order wasn't actually in
// Ready to Pickup (caller decides how to report that).
function confirmOrderPickedUp(orderSn) {
  const session = db.prepare("SELECT * FROM packing_sessions WHERE order_sn = ? AND status = 'READY_FOR_PICKUP'").get(orderSn);
  if (!session) return null;

  const pickedUpAt = now();
  db.prepare("UPDATE packing_sessions SET status = 'DONE', completed_at = ? WHERE id = ?").run(pickedUpAt, session.id);
  db.prepare("UPDATE orders SET status = 'DONE' WHERE order_sn = ?").run(orderSn);

  // No Shopee API call needed here (researched 2026-09-26, against
  // Shopee's own Open API Developer Guide) — the seller's side of the API
  // call flow ends at "Arrange Shipment & Get TrackingNo & Print AirwayBill"
  // (bookOneOrder above). order_status then auto-advances to SHIPPED once
  // the 3PL/courier actually collects the parcel — that transition, and any
  // resulting webhook push, is entirely on Shopee/logistics' side. This
  // local DONE status is purely our own dashboard bookkeeping.
  return pickedUpAt;
}

router.post('/confirm-pickup', (req, res) => {
  const { order_sn: scannedOrderSn } = req.body;
  const pickedUpAt = confirmOrderPickedUp(scannedOrderSn);
  if (pickedUpAt == null) {
    return res.status(400).json({ error: 'not_ready_for_pickup', message: `${scannedOrderSn} is not in the Ready to Pickup pool` });
  }

  // created_at/picked_up_at let the Shipping Mode screen show the same
  // "ORDER ID / DITERIMA / DIPICKUP EKSPEDISI" confirmation as the wireframe,
  // instead of just an ok flag.
  const order = db.prepare('SELECT created_at FROM orders WHERE order_sn = ?').get(scannedOrderSn);
  res.json({ ok: true, order_sn: scannedOrderSn, created_at: order.created_at, picked_up_at: pickedUpAt });
});

// "Force All Pickup" (client-requested 2026-09-25) — the bulk form of
// confirm-pickup, for every order currently sitting in Ready to Pickup, the
// same as scanning each one's label in Shipping Mode without needing the
// physical labels in hand.
router.post('/force-pickup-all', requireAdminAuth, (req, res) => {
  const shopId = Number(req.body.shop_id || req.query.shop_id);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const orderSns = db
    .prepare(`
      SELECT o.order_sn FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'READY_FOR_PICKUP' AND o.shop_id = ?
    `)
    .all(shopId)
    .map((r) => r.order_sn);

  const run = db.transaction(() => {
    for (const orderSn of orderSns) confirmOrderPickedUp(orderSn);
  });
  run();

  res.json({ ok: true, count: orderSns.length });
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

// Admin/dashboard view of the pools from the flow diagram. Client-requested
// (2026-09-23): "Processing" is any order currently having its book-ship
// call attempted with Shopee — that definition is the same whether the
// order is brand new or a Pack Besok leftover whose 8am sweep just started,
// so both feed the same bucket:
// - "Processing": ONLY exists during work hour — past its buyer-cancellation
//   delay, not yet labeled. Covers two cases: (a) a fresh order waiting on
//   shopeeSync.js's bookAndLabelPendingOrders, (b) a Pack Besok order
//   (packing_sessions.status = DEFERRED_READY) waiting on
//   bookDeferredOrders once work hour has opened. Outside work hour this
//   bucket is always empty for case (a) since nothing's being booked at
//   all; a Pack Besok order outside work hour sits in "Ready to process
//   tomorrow" instead (see below), not here.
// - "Ready to check": claimable right now. For a fresh order, during work
//   hour that means already labeled (o.label_ready = 1) — a station must
//   never grab one while its booking call is still in flight, or an
//   operator fast enough to finish scanning before that call returns gets
//   it needlessly deferred to a temp barcode (this exact race hit
//   production on order 260923QAHDPSY8); outside work hour label_ready is
//   irrelevant, since no booking is happening regardless. A Pack Besok
//   order also lands here once bookDeferredOrders labels it — but unlike a
//   fresh order, it's only claimable via its own barcode scan
//   (/resume-besok), never a generic NEXT_ORDER pick, hence
//   internal_barcode being included on those rows.
// - "On progress check": actively being packed right now — a Packing
//   Station has claimed it and is scanning items (or re-validating a resumed leftover),
//   or has printed a label and is waiting on the operator's confirm-scan
//   (AWAITING_LABEL_SCAN) — still "in the station's hands", not yet ready.
// - "Ready to pickup": label printed AND confirm-scanned back successfully,
//   waiting for Shipping Mode to confirm the courier took it.
// - "Ready to process tomorrow": deferred (Pack Besok), unlabeled, AND work
//   hour hasn't opened yet — genuinely just waiting. Moves to "Processing"
//   the moment work hour opens, then "Ready to check" once labeled; never
//   moves back here.
//
// "Waiting List" (client-requested 2026-09-22): an order newer than the
// configured delay (see packingSettings.js) sits here — gives the buyer a
// window to cancel before it becomes claimable/packable at all.
// Order tags (client-requested 2026-09-25) — computed here rather than
// stored, since all three are derived facts (instant-shipping flag, whether
// a packing session dates back to a previous WIB day, how long a row has
// sat in Ready to Check) rather than independent state. `sessionStartedAt`
// is null for a fresh order with no packing_sessions row yet — "from
// yesterday" only ever applies to a Pack Besok order that's been through at
// least one. `readyToCheckEnteredAt` is only passed for Ready to Check rows,
// per the client's own definition of "stuck" (time in that bucket
// specifically, not the order's total age).
function computeTags({ isInstant, sessionStartedAt, readyToCheckEnteredAt, needsRetryShip }) {
  const tags = [];
  if (isInstant) tags.push('instant');
  if (sessionStartedAt != null && sessionStartedAt < startOfDayWIB(0)) tags.push('from_yesterday');
  if (readyToCheckEnteredAt != null && now() - readyToCheckEnteredAt > getReadyToCheckStuckSeconds()) tags.push('stuck');
  if (needsRetryShip) tags.push('retry_ship');
  return tags;
}

router.get('/order-lists', requireAdminAuth, (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const cutoff = now() - getOrderDelaySeconds();
  const withinWorkHour = isWithinWorkHour();

  const waitingList = db
    .prepare(`
      SELECT order_sn, buyer_name, created_at, is_instant
      FROM orders
      WHERE shop_id = ? AND status = 'READY_TO_PACK' AND created_at > ?
      ORDER BY created_at ASC
    `)
    .all(shop_id, cutoff)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant }) }));

  // "Processing" = any order whose book-ship call with Shopee is currently
  // being attempted — true for a brand-new order the same way it's true for
  // a Pack Besok order once work hour opens and bookDeferredOrders starts
  // sweeping it. Same rule, same bucket, regardless of which one it is.
  const processing = db
    .prepare(`
      SELECT order_sn, buyer_name, created_at, is_instant, NULL AS session_started_at FROM orders o
      WHERE shop_id = ? AND status = 'READY_TO_PACK' AND created_at <= ? AND label_ready = 0 AND ? = 1
        -- Without this, a Pack Besok order (packing_sessions.status =
        -- DEFERRED_READY) would match here too — orders.status stays
        -- READY_TO_PACK for the whole Pack Besok flow, only the session's
        -- own status changes — duplicating it alongside the leftover branch
        -- below, which already covers it.
        AND NOT EXISTS (SELECT 1 FROM packing_sessions ps WHERE ps.order_sn = o.order_sn)
      UNION ALL
      SELECT o.order_sn, o.buyer_name, ps.started_at AS created_at, o.is_instant, ps.started_at AS session_started_at
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND o.label_ready = 0 AND ? = 1
      ORDER BY created_at ASC
    `)
    .all(shop_id, cutoff, withinWorkHour ? 1 : 0, shop_id, withinWorkHour ? 1 : 0)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.session_started_at }) }));

  const readyToCheck = db
    .prepare(`
      SELECT o.order_sn, o.buyer_name, o.created_at, o.is_instant, o.label_ready, o.label_ready_at, NULL AS internal_barcode, NULL AS session_started_at
      FROM orders o
      WHERE o.shop_id = ? AND o.status = 'READY_TO_PACK' AND o.created_at <= ?
        AND (o.label_ready = 1 OR ? = 0)
        -- Any existing packing_sessions row (not just an active one) means
        -- this order is already represented by a different bucket/branch —
        -- a DEFERRED_READY one by the leftover branch below (once labeled)
        -- or by Processing/Ready to Process Tomorrow (while not), so it
        -- must never also leak into this "never touched yet" branch.
        AND NOT EXISTS (SELECT 1 FROM packing_sessions ps WHERE ps.order_sn = o.order_sn)
      UNION ALL
      -- A Pack Besok order that's now labeled: claimable, but only via its
      -- own barcode scan (resume-besok), not a generic NEXT_ORDER pick —
      -- internal_barcode is included so ops can see which code to look for.
      SELECT o.order_sn, o.buyer_name, o.created_at, o.is_instant, o.label_ready, o.label_ready_at, ps.internal_barcode, ps.started_at AS session_started_at
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND o.label_ready = 1
      ORDER BY is_instant DESC, created_at ASC
    `)
    .all(shop_id, cutoff, withinWorkHour ? 1 : 0, shop_id)
    .map((row) => {
      // Fallback for a row labeled before label_ready_at existed (or, for the
      // fresh/unlabeled-outside-work-hour case, one that was never booked at
      // all) — entered the pool when it cleared its own delay.
      const enteredAt = row.label_ready_at ?? row.created_at + getOrderDelaySeconds();
      return { ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.session_started_at, readyToCheckEnteredAt: enteredAt }) };
    });

  const onProgressCheck = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.started_at, ps.status, o.buyer_name, o.is_instant, o.label_ready, o.label_printed
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status IN ('IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN') AND o.shop_id = ?
      ORDER BY ps.started_at ASC
    `)
    .all(shop_id)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.started_at }) }));

  const readyForPickup = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.started_at, ps.last_activity_at, o.tracking_no, o.buyer_name, o.is_instant, o.needs_retry_ship
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'READY_FOR_PICKUP' AND o.shop_id = ?
      ORDER BY ps.last_activity_at ASC
    `)
    .all(shop_id)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.started_at, needsRetryShip: row.needs_retry_ship }) }));

  // Only genuinely still waiting — work hour hasn't opened yet, so
  // bookDeferredOrders hasn't even started trying to book it. Once work
  // hour opens it moves to "Processing" above (booking in flight), then
  // "Ready to Check" once labeled — never back here.
  const readyTomorrow = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.internal_barcode, ps.started_at, o.buyer_name, o.is_instant
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND o.label_ready = 0 AND ? = 0
      ORDER BY ps.started_at ASC
    `)
    .all(shop_id, withinWorkHour ? 1 : 0)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.started_at }) }));

  // Client-requested (2026-09-26): a session an operator flagged via
  // "Masalah" (see /masalah below) used to just vanish from every bucket —
  // EXCEPTION was never selected by any of the queries above. Giving it its
  // own bucket at least makes a stuck/problem order visible again; there's
  // no resolve action yet (still reachable via the Order Detail popup's
  // Cancel Order/Force actions once one is clicked, same as any other order).
  const problemOrders = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.started_at, o.is_instant
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'EXCEPTION' AND o.shop_id = ?
      ORDER BY ps.started_at ASC
    `)
    .all(shop_id)
    .map((row) => ({ ...row, tags: computeTags({ isInstant: row.is_instant, sessionStartedAt: row.started_at }) }));

  res.json({ waitingList, processing, readyToCheck, onProgressCheck, readyForPickup, readyTomorrow, problemOrders });
});

// Cancel & Masalah (client-requested 2026-09-27) — a dedicated admin view for
// orders that dropped out of the normal flow entirely: buyer/seller-cancelled
// orders (which just vanish from every /order-lists bucket once CANCELLED,
// with nowhere else to see them) and Problem Order (EXCEPTION) sessions,
// alongside the live "Problem Order" bucket already in Order Lists — this is
// the broader, longer-history view of the same thing plus cancellations.
// Capped at the most recent 200 cancellations so this never grows unbounded.
router.get('/cancel-masalah-list', requireAdminAuth, (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const cancelled = db
    .prepare(`
      SELECT order_sn, buyer_name, created_at
      FROM orders
      WHERE shop_id = ? AND status = 'CANCELLED'
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all(shop_id);

  const masalah = db
    .prepare(`
      SELECT ps.id AS session_id, ps.order_sn, ps.station_id, ps.operator_name, ps.started_at
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'EXCEPTION' AND o.shop_id = ?
      ORDER BY ps.started_at DESC
    `)
    .all(shop_id);

  res.json({ cancelled, masalah });
});

// Packing Station configuration (client-requested 2026-09-22) — Delay, Max
// Process Order (concurrent bookings), Max Ready to Check. Stored in the
// `settings` table (see packingSettings.js), not config.json, so an admin's
// edit from the UI persists across deploys instead of being reverted by the
// next git pull.
// currentlyWithinWorkHour is computed fresh on every call, separate from
// the workHourEnabled/Start/End settings themselves — the settings say what
// the rule IS, this says what it currently EVALUATES to. Without this, the
// UI's Aktif/Nonaktif toggle (which only says whether the rule is being
// enforced at all) reads as if it means "we're in work hours right now",
// which is a different question and was genuinely confusing when the two
// disagreed (rule enabled, but the clock is at 2am).
router.get('/settings', requireAdminAuth, (req, res) => {
  res.json({ ...getPackingSettings(), currentlyWithinWorkHour: isWithinWorkHour() });
});

router.post('/settings', requireAdminAuth, (req, res) => {
  res.json({ ...setPackingSettings(req.body || {}), currentlyWithinWorkHour: isWithinWorkHour() });
});

// Client-requested (2026-09-25): the Order Detail popup's single source of
// truth for "which bucket is this order in right now" — mirrors the bucket
// rules /order-lists computes per-column, but for one order looked up
// directly rather than derived from which list query happened to match it.
// `rank` gates the popup's action buttons: only Ready to Check or later
// (rank >= 2) is far enough along to offer Cancel/Force actions — an order
// still in Waiting List or Processing hasn't been touched yet, and Ready to
// Process Tomorrow is deliberately the same tier as Processing (nothing to
// manage until work hour sweeps it forward). Problem Order (EXCEPTION) is
// also manageable — that's the whole point of surfacing it at all, since
// there's no dedicated resolve flow yet.
function resolveOrderBucket(orderSn) {
  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(orderSn);
  if (!order) return null;
  if (order.status === 'CANCELLED') return { order, session: null, bucket: 'Cancelled', rank: -1 };

  const session = db.prepare('SELECT * FROM packing_sessions WHERE order_sn = ?').get(orderSn);
  const withinWorkHour = isWithinWorkHour();
  const cutoff = now() - getOrderDelaySeconds();

  if (session) {
    if (session.status === 'DEFERRED_READY') {
      if (order.label_ready) return { order, session, bucket: 'Ready to Check', rank: 2 };
      return { order, session, bucket: withinWorkHour ? 'Processing' : 'Ready to Process Tomorrow', rank: 1 };
    }
    if (['IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN'].includes(session.status)) {
      return { order, session, bucket: 'On Progress Check', rank: 3 };
    }
    if (session.status === 'READY_FOR_PICKUP') {
      return { order, session, bucket: 'Ready to Pickup', rank: 4 };
    }
    return { order, session, bucket: 'Problem Order', rank: 2 };
  }

  if (order.created_at > cutoff) return { order, session: null, bucket: 'Waiting List', rank: 0 };
  if (!order.label_ready && withinWorkHour) return { order, session: null, bucket: 'Processing', rank: 1 };
  return { order, session: null, bucket: 'Ready to Check', rank: 2 };
}

// Order Detail popup (client-requested 2026-09-25): clicking any order row
// in the Order Lists panel. Returns just enough to render it — order_sn,
// when it was received, its shipping carrier, current bucket, per-item scan
// progress, and whether it's already far enough along (rank >= 2) for the
// popup's Cancel/Force actions to be offered at all.
router.get('/order-detail', requireAdminAuth, (req, res) => {
  const { order_sn } = req.query;
  const resolved = resolveOrderBucket(order_sn);
  if (!resolved) return res.status(404).json({ error: 'order_not_found' });
  const { order, session, bucket, rank } = resolved;

  const items = db.prepare('SELECT sku, product_name, qty FROM order_items WHERE order_sn = ?').all(order_sn);
  const progressBySku = session
    ? Object.fromEntries(
        db.prepare('SELECT sku, scanned_qty FROM scan_progress WHERE session_id = ?').all(session.id).map((p) => [p.sku, p.scanned_qty])
      )
    : {};

  res.json({
    order_sn: order.order_sn,
    created_at: order.created_at,
    shipping_carrier: order.shipping_carrier,
    bucket,
    canManage: rank >= 2,
    forced: session?.forced === 1,
    items: items.map((it) => ({ ...it, scanned_qty: progressBySku[it.sku] || 0 })),
  });
});

// Admin override for a genuinely stuck order — forces it straight to Ready
// to Pickup regardless of real scan/label progress. `forced` is recorded on
// the session (see db.js migration) so a forced completion stays visibly
// distinguishable from a normal one rather than looking identical in the
// Ready to Pickup list. Creates a session from scratch if the order never
// had one yet (still in Waiting List/Processing/fresh Ready to Check).
// Shared by the single-order route below and the "Move All to Ready to
// Pickup" bulk action.
function forceOrderToReadyForPickup(orderSn) {
  const session = db.prepare('SELECT id FROM packing_sessions WHERE order_sn = ?').get(orderSn);
  if (session) {
    db.prepare("UPDATE packing_sessions SET status = 'READY_FOR_PICKUP', forced = 1, completed_at = ?, last_activity_at = ? WHERE id = ?")
      .run(now(), now(), session.id);
  } else {
    db.prepare(`
      INSERT INTO packing_sessions (order_sn, station_id, operator_name, status, started_at, completed_at, last_activity_at, forced)
      VALUES (?, 'ADMIN', 'Forced (Admin)', 'READY_FOR_PICKUP', ?, ?, ?, 1)
    `).run(orderSn, now(), now(), now());
  }
  console.log(`[server] bucket: ${orderSn} -> Ready to Pickup (FORCED via admin override)`);
}

router.post('/force-ready-for-pickup', requireAdminAuth, (req, res) => {
  const { order_sn } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(order_sn);
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  db.transaction(() => forceOrderToReadyForPickup(order_sn))();
  res.json({ ok: true, order_sn });
});

// "Move All to Ready to Pickup" (client-requested 2026-09-25) — the bulk
// form of the single-order action above, for every order currently at
// Ready to Check or On Progress Check (rank 2/3, via the same
// resolveOrderBucket the Order Detail popup uses to gate its own button).
// Waiting List/Processing/Ready to Process Tomorrow are excluded, same as
// the single-order button never showing for them; already-Ready-to-Pickup
// or terminal (Cancelled/Done) orders are naturally excluded too.
router.post('/force-ready-for-pickup-all', requireAdminAuth, (req, res) => {
  const shopId = Number(req.body.shop_id || req.query.shop_id);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const orderSns = db.prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK'").all(shopId).map((r) => r.order_sn);
  const candidates = orderSns.filter((sn) => {
    const resolved = resolveOrderBucket(sn);
    return resolved && (resolved.bucket === 'Ready to Check' || resolved.bucket === 'On Progress Check');
  });

  const run = db.transaction(() => {
    for (const orderSn of candidates) forceOrderToReadyForPickup(orderSn);
  });
  run();

  res.json({ ok: true, count: candidates.length });
});

// Real seller-initiated cancellation (client-requested 2026-09-25) — calls
// Shopee's own cancel_order so the shipment is actually cancelled on their
// side too, not just hidden in our queue (see shopee/client.js's
// cancelOrder for the reason code). Mock orders skip the Shopee call
// entirely, same as everywhere else debug mode touches the API. Any
// existing packing_sessions row is torn down the same way release-order
// does, so a cancelled order also disappears from every other bucket.
router.post('/cancel-order', requireAdminAuth, async (req, res) => {
  const { order_sn } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(order_sn);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.status === 'CANCELLED') return res.json({ ok: true, order_sn, alreadyCancelled: true });

  if (!isMockOrder(order_sn)) {
    try {
      const accessToken = await getValidAccessToken(order.shop_id);
      const result = await cancelOrder(accessToken, order.shop_id, order_sn);
      if (result.error) {
        return res.status(502).json({ error: 'shopee_cancel_failed', message: result.message || result.error });
      }
    } catch (err) {
      return res.status(502).json({ error: 'shopee_cancel_failed', message: err.message });
    }
  }

  const cancel = db.transaction(() => {
    const session = db.prepare('SELECT id FROM packing_sessions WHERE order_sn = ?').get(order_sn);
    if (session) {
      db.prepare('DELETE FROM scan_progress WHERE session_id = ?').run(session.id);
      db.prepare('DELETE FROM packing_sessions WHERE id = ?').run(session.id);
    }
    db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_sn = ?").run(order_sn);
  });
  cancel();

  console.log(`[server] order ${order_sn} cancelled via admin action (Order Detail popup)`);
  res.json({ ok: true, order_sn });
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
