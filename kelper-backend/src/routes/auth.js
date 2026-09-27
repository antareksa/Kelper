const express = require('express');
const db = require('../db');
const { buildAuthUrl, exchangeToken, BRAND_CREDENTIALS } = require('../shopee/client');
const { getValidAccessToken, getValidBrandAccessToken } = require('../shopee/tokenStore');

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

// Forgets the locally stored token so the Dashboard shows disconnected and
// the sync loop stops touching this shop until someone logs in again. This
// doesn't revoke anything on Shopee's own side (Shopee doesn't expose a
// revoke endpoint to partner apps the way it exposes obtaining one) — it
// just clears what KELPER itself remembers, which is the only thing "log
// out" can practically mean from this side.
router.post('/logout', (req, res) => {
  const { shop_id } = req.body;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
  db.prepare('DELETE FROM shopee_tokens WHERE shop_id = ?').run(shop_id);
  res.json({ ok: true });
});

// Ordered most-recently-connected first (client-requested 2026-09-27) —
// the frontend's shopConfig.js uses row 0 as "the active shop" now that
// SHOP_ID is resolved at runtime instead of frozen at build time
// (VITE_SHOP_ID). Reconnecting under a different shop doesn't delete the
// old token row, so without this order the "active" pick would be
// arbitrary (SQLite gives no ordering guarantee) whenever more than one
// shop has ever been connected.
router.get('/status', (req, res) => {
  const rows = db.prepare('SELECT shop_id, expires_at, updated_at FROM shopee_tokens ORDER BY updated_at DESC').all();
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

// Brand Portal is a second, separate Shopee app (own Partner ID/Key,
// registered with its own redirect URI in the Partner Console) used only
// for the Affiliasi/Pengunjung metrics that need Brand Portal-specific
// APIs — everything below mirrors the routes above exactly, just against
// shopee_brand_tokens/BRAND_CREDENTIALS instead of the main app's, so
// connecting or disconnecting it can never affect the main Shopee
// connection that order sync depends on.
router.get('/brand/login', (req, res) => {
  res.redirect(buildAuthUrl(BRAND_CREDENTIALS));
});

router.get('/brand/login-url', (req, res) => {
  res.json({ url: buildAuthUrl(BRAND_CREDENTIALS) });
});

router.get('/brand/exchange', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) {
    return res.status(400).json({ error: 'code and shop_id query params are required' });
  }

  const data = await exchangeToken(code, shop_id, BRAND_CREDENTIALS);
  if (data.error) {
    return res.status(400).json(data);
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO shopee_brand_tokens (shop_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(Number(shop_id), data.access_token, data.refresh_token, now + data.expire_in, now);

  res.json({ ok: true, shop_id: Number(shop_id), expires_at: now + data.expire_in });
});

router.post('/brand/logout', (req, res) => {
  const { shop_id } = req.body;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
  db.prepare('DELETE FROM shopee_brand_tokens WHERE shop_id = ?').run(shop_id);
  res.json({ ok: true });
});

router.get('/brand/check', async (req, res) => {
  const { shop_id } = req.query;
  if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });

  try {
    await getValidBrandAccessToken(shop_id);
    res.json({ connected: true });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

module.exports = router;
