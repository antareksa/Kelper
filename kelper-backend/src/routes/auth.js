const express = require('express');
const db = require('../db');
const { buildAuthUrl, exchangeToken } = require('../shopee/client');
const { getValidAccessToken } = require('../shopee/tokenStore');

const router = express.Router();

router.get('/login', (req, res) => {
  res.redirect(buildAuthUrl());
});

router.get('/login-url', (req, res) => {
  res.json({ url: buildAuthUrl() });
});

router.get('/exchange', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) {
    return res.status(400).json({ error: 'code and shop_id query params are required' });
  }

  const data = await exchangeToken(code, shop_id);
  if (data.error) {
    return res.status(400).json(data);
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO shopee_tokens (shop_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(Number(shop_id), data.access_token, data.refresh_token, now + data.expire_in, now);

  res.json({ ok: true, shop_id: Number(shop_id), expires_at: now + data.expire_in });
});

router.get('/status', (req, res) => {
  const rows = db.prepare('SELECT shop_id, expires_at, updated_at FROM shopee_tokens').all();
  res.json(rows);
});

// Real connectivity check — not just "a row exists", but "the refresh_token
// still actually works" (it can fail if 30 days have passed with no re-login).
router.get('/check', async (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  try {
    await getValidAccessToken(shop_id);
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

module.exports = router;
