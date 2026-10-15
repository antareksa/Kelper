const express = require('express');
const db = require('../db');
const { syncAndLabelOrders, getFetchBudget } = require('../shopeeSync');
const { getSetting, setSetting } = require('../settings');
const { expandPackingItems } = require('../packingItems');
const { getConfig } = require('../config');
const { packingVideoFile } = require('../gcs');

// Whether the order's packing video is in the bucket: true / false, or null when
// that can't be told (video upload off, or Google didn't answer within 4 s) -- the
// button is then still offered and the download itself says what is wrong.
async function hasPackingVideo(orderSn) {
  const { gcsEnabled, gcsBucket } = getConfig().evidence;
  if (!gcsEnabled) return null;
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
    const [exists] = await Promise.race([packingVideoFile(gcsBucket, orderSn).exists(), timeout]);
    return exists;
  } catch {
    return null;
  }
}

const router = express.Router();

// Order fetching is off by default (see shopeeSync.js's isSyncEnabled) —
// these two let the Order Lists screen show current status and let an admin
// start/pause it. Genuinely global: pausing here also stops the manual
// /sync endpoint below and the background timer, since all three share the
// same underlying check.
router.get('/sync-status', (req, res) => {
  // remaining: orders still allowed in by a limited unlock (null = no limit).
  res.json({ enabled: getSetting('syncEnabled', 'false') === 'true', remaining: getFetchBudget() });
});

router.post('/sync-toggle', (req, res) => {
  const { enabled } = req.body;
  setSetting('syncEnabled', enabled ? 'true' : 'false');
  // The button is a plain on/off: it ends any limited unlock (see shopeeSync.js).
  setSetting('fetchBudget', '');
  setSetting('fetchDrain', 'false');
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
router.get('/search', async (req, res) => {
  const orderSn = (req.query.order_sn || '').trim();
  if (!orderSn) return res.status(400).json({ error: 'order_sn_required' });

  const order = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(orderSn);
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  const items = expandPackingItems(orderSn).map(({ sku, product_name, qty, from_bundles }) => ({ sku, product_name, qty, from_bundles }));
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
    has_video: await hasPackingVideo(orderSn),
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

// Order menu's list (client-requested 2026-10-15): every order a Packing Station
// processed in [from, to) (unix seconds), by the time its latest packing session
// started. Clicking one opens /search's detail. Total = the order's items at the
// price frozen for it (order_items.price_snapshot, else today's Harga); left out
// for a Packing Station admin, who sees no prices anywhere.
router.get('/list', (req, res) => {
  const shopId = Number(req.query.shop_id);
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!shopId || !Number.isFinite(from) || !Number.isFinite(to)) {
    return res.status(400).json({ error: 'shop_id, from and to are required' });
  }
  const LIMIT = 2000;
  const rows = db
    .prepare(`
      SELECT o.order_sn, o.status, o.buyer_name, o.shipping_carrier, o.is_instant, o.tracking_no,
             ps.status AS session_status, ps.operator_name, ps.station_id, ps.started_at, ps.completed_at,
             (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi WHERE oi.order_sn = o.order_sn) AS item_qty,
             (SELECT SUM(oi.qty * COALESCE(oi.price_snapshot, p.price)) FROM order_items oi
                LEFT JOIN products p ON p.sku = oi.sku WHERE oi.order_sn = o.order_sn) AS total
      FROM orders o
      JOIN packing_sessions ps ON ps.id = (SELECT MAX(id) FROM packing_sessions WHERE order_sn = o.order_sn)
      WHERE o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%' AND ps.started_at >= ? AND ps.started_at < ?
      ORDER BY ps.started_at DESC
      LIMIT ?
    `)
    .all(shopId, from, to, LIMIT + 1);
  const hidePrices = req.adminRole === 'packing';
  res.json({
    truncated: rows.length > LIMIT,
    orders: rows.slice(0, LIMIT).map((r) => ({ ...r, is_instant: !!r.is_instant, total: hidePrices ? undefined : r.total })),
  });
});

// The order's packing video from the bucket, as a download (client-requested
// 2026-10-15: the button in the order detail). Streamed through the server: the
// bucket is not public, and the browser sends the admin login with this request.
router.get('/video', async (req, res) => {
  const orderSn = (req.query.order_sn || '').trim();
  if (!orderSn) return res.status(400).json({ error: 'order_sn_required' });
  const { gcsEnabled, gcsBucket } = getConfig().evidence;
  if (!gcsEnabled) return res.status(404).json({ error: 'video_storage_off', message: 'Penyimpanan video tidak aktif di server ini.' });

  const file = packingVideoFile(gcsBucket, orderSn);
  try {
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'no_video', message: 'Tidak ada video untuk order ini.' });
    const [meta] = await file.getMetadata();
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Content-Disposition', `attachment; filename="${orderSn.replace(/[^A-Za-z0-9_-]/g, '')}.webm"`);
    if (meta.size) res.setHeader('Content-Length', meta.size);
    file.createReadStream()
      .on('error', (err) => {
        console.warn(`[packing-video] download failed for ${orderSn}: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'gcs_read_failed', message: err.message });
        else res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    console.warn(`[packing-video] download failed for ${orderSn}: ${err.message}`);
    const denied = err.code === 403 || /permission|denied|forbidden/i.test(err.message);
    res.status(502).json({
      error: 'gcs_read_failed',
      message: denied ? 'Server tidak punya izin membaca video di Google Cloud Storage.' : `Gagal mengambil video: ${err.message}`,
    });
  }
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
