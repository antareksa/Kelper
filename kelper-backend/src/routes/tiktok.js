const crypto = require('crypto');
const express = require('express');
const { requireAdminAuth } = require('../adminSession');
const { isConfigured, buildAuthUrl, exchangeCode, getAuthorizedShops } = require('../tiktok/client');
const { saveConnection, clearConnection, getConnectionSummary, getValidAccessToken } = require('../tiktok/tokenStore');

// TikTok Shop connection (2026-11-03): connect / status / disconnect only.
// No order sync yet. Mounted at /auth/tiktok. Everything is admin-only:
// the authorization starts from the Settings page and lands back on the
// same Dashboard (App.jsx's /tiktok-callback), where the admin is logged in.
const router = express.Router();
router.use(requireAdminAuth);

function log(message) {
  // Never the code, a token or a cipher.
  console.log(`[server] tiktok auth: ${message}`);
}

// state values handed out by /login-url, each valid for 10 minutes and
// usable once. In memory on purpose: a restart in the middle of an
// authorization just means clicking Hubungkan again.
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();
function newState() {
  const state = crypto.randomBytes(16).toString('hex');
  const t = Date.now();
  for (const [s, at] of pendingStates) if (t - at > STATE_TTL_MS) pendingStates.delete(s);
  pendingStates.set(state, t);
  return state;
}
function takeState(state) {
  const at = pendingStates.get(state);
  pendingStates.delete(state);
  return at !== undefined && Date.now() - at <= STATE_TTL_MS;
}

// Every route but /status answers "not configured" until the env has the
// app key/secret (production never does).
function requireConfigured(req, res, next) {
  if (!isConfigured()) return res.status(404).json({ error: 'tiktok_not_configured' });
  next();
}

router.get('/status', (req, res) => {
  if (!isConfigured()) return res.json({ configured: false });
  res.json({ configured: true, connection: getConnectionSummary() });
});

router.get('/login-url', requireConfigured, (req, res) => {
  const url = buildAuthUrl(newState());
  if (!url) {
    return res.status(400).json({
      error: 'tiktok_auth_url_missing',
      message: 'TIKTOK_AUTH_URL (atau TIKTOK_SERVICE_ID) belum diisi di file env.',
    });
  }
  res.json({ url });
});

router.get('/exchange', requireConfigured, async (req, res) => {
  const code = req.query.code || req.query.auth_code;
  const { state } = req.query;
  if (!code) {
    log('rejected, no code');
    return res.status(400).json({ error: 'code_required', message: 'Tidak ada kode otorisasi dari TikTok.' });
  }
  if (!state || !takeState(String(state))) {
    log('rejected, unknown or expired state');
    return res.status(400).json({
      error: 'invalid_state',
      message: 'Sesi otorisasi tidak dikenali atau sudah kedaluwarsa. Klik Hubungkan lagi dari Pengaturan.',
    });
  }

  let tokens;
  try {
    tokens = await exchangeCode(String(code));
  } catch (err) {
    log(`token exchange refused: ${err.tiktokCode ?? ''} ${err.message}`);
    return res.status(502).json({ error: 'exchange_failed', message: `TikTok menolak: ${err.message}` });
  }

  let shops;
  try {
    shops = await getAuthorizedShops(tokens.accessToken);
  } catch (err) {
    // The scopes TikTok put on this token (names only, not secret): the
    // usual cause of this failure is a token issued without the needed one.
    // Keep the token anyway (with no shops), so "Cek koneksi" can retry
    // later and the token can be used for diagnosis (e.g. Partner Center's
    // API Testing Tool) without authorizing again.
    saveConnection(tokens, []);
    const scopes = tokens.grantedScopes.length ? tokens.grantedScopes.join(', ') : '(kosong)';
    const who = `${tokens.sellerName || '?'} (${tokens.sellerBaseRegion || '?'})`;
    log(`get authorized shops failed: code ${err.tiktokCode ?? '?'} ${err.message} | seller ${who} | granted scopes: ${scopes}`);
    return res.status(502).json({
      error: 'shops_failed',
      message: `Token didapat, tapi daftar toko gagal (kode TikTok ${err.tiktokCode ?? '?'}): ${err.message} | Seller: ${who} | Scope token: ${scopes}`,
    });
  }

  saveConnection(tokens, shops);
  log(`connected seller "${tokens.sellerName}" (${tokens.sellerBaseRegion}), ${shops.length} shop(s): ${shops.map((s) => s.name).join(', ') || '-'}`);
  res.json({ ok: true, connection: getConnectionSummary() });
});

// Live check against TikTok (refreshing the token if needed), for the
// Settings card's "Cek koneksi" button.
router.get('/check', requireConfigured, async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    const shops = await getAuthorizedShops(accessToken);
    res.json({ ok: true, shops: shops.map((s) => ({ id: String(s.id), name: s.name, region: s.region })) });
  } catch (err) {
    log(`check failed: ${err.tiktokCode ?? ''} ${err.message}`);
    res.status(502).json({ ok: false, message: err.message });
  }
});

// Forgets the connection in KELPER only. Removing the app's access on
// TikTok's side is done from TikTok Seller Center.
router.post('/logout', requireConfigured, (req, res) => {
  clearConnection();
  log('disconnected');
  res.json({ ok: true });
});

module.exports = router;
