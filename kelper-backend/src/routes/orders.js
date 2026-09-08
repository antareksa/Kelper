const express = require('express');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getOrderList, getOrderDetail } = require('../shopee/client');

const router = express.Router();

const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (order_sn, shop_id, status, buyer_name, created_at)
  VALUES (?, ?, 'READY_TO_PACK', ?, ?)
`);
const insertItem = db.prepare(`
  INSERT INTO order_items (order_sn, sku, product_name, qty)
  VALUES (?, ?, ?, ?)
`);

router.post('/sync', async (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  try {
    const accessToken = await getValidAccessToken(shop_id);

    const now = Math.floor(Date.now() / 1000);
    const timeFrom = now - 15 * 24 * 60 * 60; // Shopee caps create_time range at 15 days

    const listResult = await getOrderList(accessToken, shop_id, {
      timeFrom,
      timeTo: now,
      orderStatus: 'READY_TO_SHIP',
    });
    if (listResult.error) {
      return res.status(400).json(listResult);
    }

    const orderSns = (listResult.response.order_list || []).map((o) => o.order_sn);
    if (orderSns.length === 0) {
      return res.json({ ok: true, found: 0, added: 0 });
    }

    const detailResult = await getOrderDetail(accessToken, shop_id, orderSns);
    if (detailResult.error) {
      return res.status(400).json(detailResult);
    }

    let added = 0;
    const insertMany = db.transaction((orders) => {
      for (const order of orders) {
        const result = insertOrder.run(order.order_sn, Number(shop_id), order.buyer_username || null, now);
        if (result.changes > 0) {
          added += 1;
          for (const item of order.item_list || []) {
            const sku = item.model_sku || item.item_sku || `ITEM-${item.item_id}`;
            const productName = item.model_name ? `${item.item_name} - ${item.model_name}` : item.item_name;
            insertItem.run(order.order_sn, sku, productName, item.model_quantity_purchased);
          }
        }
      }
    });
    insertMany(detailResult.response.order_list || []);

    res.json({ ok: true, found: orderSns.length, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue-counts', (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  const readyToPack = db
    .prepare("SELECT COUNT(*) as c FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK'")
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
