const express = require('express');
const db = require('../db');
const { syncAndLabelOrders } = require('../shopeeSync');
const { getSetting, setSetting } = require('../settings');

const router = express.Router();

// Order fetching is off by default (see shopeeSync.js's isSyncEnabled) —
// these two let the Order Lists screen show current status and let an admin
// start/pause it. Genuinely global: pausing here also stops the manual
// /sync endpoint below and the background timer, since all three share the
// same underlying check.
router.get('/sync-status', (req, res) => {
  res.json({ enabled: getSetting('syncEnabled', 'false') === 'true' });
});

router.post('/sync-toggle', (req, res) => {
  const { enabled } = req.body;
  setSetting('syncEnabled', enabled ? 'true' : 'false');
  res.json({ enabled: !!enabled });
});

// Manual/on-demand trigger for the same discover+book+label logic the
// server's own background sync loop already runs continuously — harmless to
// call anytime since both paths share syncAndLabelOrders and it's idempotent.
// Still a no-op while fetching is paused (see sync-toggle above).
router.post('/sync', async (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  try {
    await syncAndLabelOrders(shop_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New "Order" menu (client-requested 2026-09-27): a standalone search-by-
// order_sn lookup, deliberately separate from packing.js's /order-detail
// (which is bucket/rank-driven for the Packing Station's own Cancel/Force
// actions) — this is a plain read-only view of whatever the local DB has for
// that order, no Shopee API calls. order_sn is globally unique, so no
// shop_id is needed to disambiguate.
router.get('/search', (req, res) => {
  const orderSn = (req.query.order_sn || '').trim();
  if (!orderSn) return res.status(400).json({ error: 'order_sn_required' });

  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(orderSn);
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  const items = db.prepare('SELECT sku, product_name, qty FROM order_items WHERE order_sn = ?').all(orderSn);
  const session = db.prepare('SELECT * FROM packing_sessions WHERE order_sn = ? ORDER BY id DESC LIMIT 1').get(orderSn);
  const progressBySku = session
    ? Object.fromEntries(
        db.prepare('SELECT sku, scanned_qty FROM scan_progress WHERE session_id = ?').all(session.id).map((p) => [p.sku, p.scanned_qty])
      )
    : {};

  res.json({
    order_sn: order.order_sn,
    status: order.status,
    buyer_name: order.buyer_name,
    created_at: order.created_at,
    shipping_carrier: order.shipping_carrier,
    is_instant: !!order.is_instant,
    tracking_no: order.tracking_no,
    label_ready: !!order.label_ready,
    label_printed: !!order.label_printed,
    needs_retry_ship: !!order.needs_retry_ship,
    items: items.map((it) => ({ ...it, scanned_qty: progressBySku[it.sku] || 0 })),
    session: session
      ? {
          station_id: session.station_id,
          operator_name: session.operator_name,
          status: session.status,
          shipping_choice: session.shipping_choice,
          internal_barcode: session.internal_barcode,
          started_at: session.started_at,
          completed_at: session.completed_at,
          forced: session.forced === 1,
        }
      : null,
  });
});

router.get('/queue-counts', (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  const readyToPack = db
    .prepare("SELECT COUNT(*) as c FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' AND label_ready = 1")
    .get(shop_id).c;
  const deferredReady = db
    .prepare(`
      SELECT COUNT(*) as c FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ?
    `)
    .get(shop_id).c;

  res.json({ ready_to_pack: readyToPack, deferred_ready: deferredReady });
});

module.exports = router;
