const express = require('express');
const db = require('../db');
const { buildAuthUrl, exchangeToken, refreshToken, BRAND_CREDENTIALS } = require('../shopee/client');
const { getValidAccessToken, getValidBrandAccessToken } = require('../shopee/tokenStore');

const router = express.Router();

router.get('/login', (req, res) => {
  res.redirect(buildAuthUrl());
});

router.get('/login-url', (req, res) => {
  res.json({ url: buildAuthUrl() });
});

// Everything below logs the outcome of each connection attempt (never the
// code or any token) -- this route used to say nothing at all, so a rejected
// or never-attempted exchange was invisible on the server. Added when a real
// client authorization landed back on the Dashboard still disconnected and
// there was nothing to read to tell why.
function logExchange(label, message) {
  console.log(`[server] shopee auth exchange (${label}): ${message}`);
}

async function runExchange(label, req, res, creds, table) {
  const { code, shop_id, main_account_id } = req.query;
  if (!code || (!shop_id && !main_account_id)) {
    logExchange(label, `rejected, missing params (code ${code ? 'present' : 'MISSING'}, shop_id ${shop_id ? 'present' : 'MISSING'}, main_account_id ${main_account_id ? 'present' : 'absent'})`);
    return res.status(400).json({ error: 'code and shop_id (or main_account_id) query params are required' });
  }

  let data;
  try {
    data = await exchangeToken(code, shop_id, creds, shop_id ? null : main_account_id);
  } catch (err) {
    logExchange(label, `could not reach Shopee: ${err.message}`);
    return res.status(502).json({ error: 'exchange_failed', message: err.message });
  }
  const who = shop_id ? `shop_id=${shop_id}` : `main_account_id=${main_account_id}`;
  if (data.error) {
    logExchange(label, `${who} refused by Shopee: ${data.error} - ${data.message || ''}`);
    return res.status(400).json(data);
  }

  let shopId = shop_id ? Number(shop_id) : null;
  let tokens = data;

  // Authorized through a main account (client-reported 2026-10-02: the
  // redirect carried code + main_account_id and no shop_id, so the callback
  // was silently ignored and nothing connected). Shopee lists the shops it
  // authorized in shop_id_list; KELPER supports one active shop at a time, so
  // the first is used and the rest are logged.
  if (!shopId) {
    const shops = data.shop_id_list || [];
    logExchange(label, `${who} authorized shops=[${shops.join(', ')}] merchants=[${(data.merchant_id_list || []).join(', ')}]`);
    if (shops.length === 0) {
      return res.status(400).json({
        error: 'no_shops_authorized',
        message: 'Shopee authorized this account but did not list any shop under it.',
      });
    }
    shopId = Number(shops[0]);
    if (shops.length > 1) {
      logExchange(label, `WARNING: ${shops.length} shops were authorized but only one can be active -- using shop_id=${shopId}`);
    }

    // Whether Shopee accepts a refresh by shop_id for a token that came from
    // a main-account authorization isn't something the docs make clear, and
    // finding out 4 hours after connecting (when the access token expires)
    // would be a bad time. So refresh once right now: on success the fresh
    // pair is what gets stored; on failure the original pair is kept and the
    // log says so loudly while someone is still watching.
    try {
      const refreshed = await refreshToken(tokens.refresh_token, shopId, creds);
      if (refreshed.error) {
        logExchange(label, `refresh check for shop_id=${shopId} FAILED (${refreshed.error} - ${refreshed.message || ''}); keeping the original tokens, which will stop working when the access token expires`);
      } else {
        tokens = refreshed;
        logExchange(label, `refresh check for shop_id=${shopId} ok`);
      }
    } catch (err) {
      logExchange(label, `refresh check for shop_id=${shopId} could not reach Shopee: ${err.message}; keeping the original tokens`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO ${table} (shop_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(shopId, tokens.access_token, tokens.refresh_token, now + tokens.expire_in, now);

  logExchange(label, `connected shop_id=${shopId}`);
  res.json({ ok: true, shop_id: shopId, expires_at: now + tokens.expire_in });
}

router.get('/exchange', (req, res) => runExchange('main', req, res, undefined, 'shopee_tokens'));

// The Shopee redirect lands on the frontend first (/check-connection*), and
// the frontend only calls /exchange when the URL has both `code` and
// `shop_id` -- if Shopee sends something else (e.g. main_account_id instead
// of shop_id) the page just opens as a normal Dashboard and the backend is
// never contacted, so /exchange can't log it. The frontend therefore reports
// what actually arrived here. Parameter NAMES only, never values: the code
// is a one-time credential. Public on purpose (the callback happens before
// any admin login), so everything is whitelisted/sanitized before it reaches
// the log.
router.post('/callback-seen', (req, res) => {
  const { path, params } = req.body || {};
  const safePath = ['/check-connection', '/check-connection-brand'].includes(path) ? path : '(unexpected path)';
  const names = Array.isArray(params)
    ? params.filter((p) => typeof p === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(p)).slice(0, 20)
    : [];
  console.log(`[server] shopee callback landed on the frontend: path=${safePath} params=[${names.join(', ')}]`);
  res.json({ ok: true });
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

router.get('/brand/exchange', (req, res) => runExchange('brand', req, res, BRAND_CREDENTIALS, 'shopee_brand_tokens'));

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
