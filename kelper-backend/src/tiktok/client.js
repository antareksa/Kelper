const crypto = require('crypto');

// TikTok Shop Open API client (2026-11-03, first step of the TikTok
// integration: login only, see docs/FEATURE-tiktok-integration.md).
// Kept fully separate from src/shopee/ -- nothing here is shared with or
// called by the Shopee code.
//
// Off unless TIKTOK_APP_KEY and TIKTOK_APP_SECRET are set in the env file.
// Production has neither, so on the live app every TikTok route answers
// "not configured" and the Settings card stays hidden.
//
// Env:
//   TIKTOK_APP_KEY, TIKTOK_APP_SECRET  from Partner Center -> the app -> Credentials
//   TIKTOK_AUTH_URL    the app's authorization link from Partner Center (preferred), or
//   TIKTOK_SERVICE_ID  the app's service id, used to build that link
//   TIKTOK_API_BASE    optional, default https://open-api.tiktokglobalshop.com
//   TIKTOK_AUTH_BASE   optional, default https://auth.tiktok-shops.com (token get/refresh)
//
// Token endpoints and the signing recipe are not in the bundled OpenAPI
// spec; they follow TikTok's documented v2 token API and request signing
// (also what the public "tiktok-shop" npm client implements).

const API_BASE = process.env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = process.env.TIKTOK_AUTH_BASE || 'https://auth.tiktok-shops.com';

function appKey() { return process.env.TIKTOK_APP_KEY || ''; }
function appSecret() { return process.env.TIKTOK_APP_SECRET || ''; }

function isConfigured() {
  return Boolean(appKey() && appSecret());
}

// Where the seller is sent to approve the app. `state` is echoed back on the
// redirect and checked by routes/tiktok.js, so a callback we didn't start is
// refused.
function buildAuthUrl(state) {
  let base = process.env.TIKTOK_AUTH_URL;
  if (!base && process.env.TIKTOK_SERVICE_ID) {
    base = `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(process.env.TIKTOK_SERVICE_ID)}`;
  }
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('state', state);
  return url.toString();
}

// TikTok returns expiry as a unix timestamp; guard against a plain duration
// just in case, so a token is never treated as expired in 1970.
function toExpiresAt(value) {
  const n = Number(value) || 0;
  const now = Math.floor(Date.now() / 1000);
  return n > 1e9 ? n : now + n;
}

// The token API puts the secret and code in the query string, so this URL
// must never be logged.
async function tokenRequest(path, params) {
  const url = new URL(path, AUTH_BASE);
  for (const [k, v] of Object.entries({ app_key: appKey(), app_secret: appSecret(), ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0 || !body.data?.access_token) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.tiktokCode = body.code;
    throw err;
  }
  const d = body.data;
  return {
    accessToken: d.access_token,
    accessExpiresAt: toExpiresAt(d.access_token_expire_in),
    refreshToken: d.refresh_token,
    refreshExpiresAt: toExpiresAt(d.refresh_token_expire_in),
    openId: d.open_id || '',
    sellerName: d.seller_name || '',
    sellerBaseRegion: d.seller_base_region || '',
    grantedScopes: Array.isArray(d.granted_scopes) ? d.granted_scopes : [],
  };
}

function exchangeCode(code) {
  return tokenRequest('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' });
}

function refreshTokens(refreshToken) {
  return tokenRequest('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' });
}

// sign = hex(HMAC-SHA256(secret, secret + path + sorted key+value pairs
// (without sign/access_token) + JSON body (if any) + secret)).
function sign(path, query, bodyText) {
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  let input = path + keys.map((k) => k + query[k]).join('');
  if (bodyText) input += bodyText;
  return crypto.createHmac('sha256', appSecret()).update(appSecret() + input + appSecret()).digest('hex');
}

// One signed call. shopCipher is required for shop-level APIs (orders,
// fulfillment, finance) and left out for seller-level ones (authorized shops).
async function apiRequest(method, path, { accessToken, shopCipher, query = {}, body } = {}) {
  const q = { ...query, app_key: appKey(), timestamp: String(Math.floor(Date.now() / 1000)) };
  if (shopCipher) q.shop_cipher = shopCipher;
  const bodyText = body !== undefined ? JSON.stringify(body) : '';
  q.sign = sign(path, q, bodyText);

  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body: bodyText || undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 0) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.tiktokCode = data.code;
    throw err;
  }
  return data.data;
}

// GET /authorization/202309/shops: the shops this seller authorized, each
// with the `cipher` every shop-level call needs.
async function getAuthorizedShops(accessToken) {
  const data = await apiRequest('GET', '/authorization/202309/shops', { accessToken });
  return data?.shops || [];
}

module.exports = { isConfigured, buildAuthUrl, exchangeCode, refreshTokens, apiRequest, getAuthorizedShops, sign };
