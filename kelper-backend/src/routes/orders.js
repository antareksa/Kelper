const express = require('express');
const db = require('../db');
const { syncAndLabelOrders } = require('../shopeeSync');

const router = express.Router();

// Manual/on-demand trigger for the same discover+book+label logic the
// server's own background sync loop already runs continuously — harmless to
// call anytime since both paths share syncAndLabelOrders and it's idempotent.
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
