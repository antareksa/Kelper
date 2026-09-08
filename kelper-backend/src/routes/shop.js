const express = require('express');
const db = require('../db');
const { getShopInfo } = require('../shopee/client');

const router = express.Router();

router.get('/info', async (req, res) => {
  const { shop_id } = req.query;

  const row = shop_id
    ? db.prepare('SELECT * FROM shopee_tokens WHERE shop_id = ?').get(Number(shop_id))
    : db.prepare('SELECT * FROM shopee_tokens ORDER BY updated_at DESC LIMIT 1').get();

  if (!row) {
    return res.status(404).json({ error: 'no_token', message: 'No shop has been authorized yet' });
  }

  const data = await getShopInfo(row.access_token, row.shop_id);
  if (data.error) {
    return res.status(400).json(data);
  }

  res.json({ shop_id: row.shop_id, shop_name: data.shop_name });
});

module.exports = router;
