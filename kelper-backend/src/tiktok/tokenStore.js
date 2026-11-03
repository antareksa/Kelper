const db = require('../db');
const { refreshTokens } = require('./client');

// TikTok's own tables, separate from shopee_tokens (2026-11-03). Created
// here rather than in db.js so the Shopee schema file stays untouched;
// CREATE IF NOT EXISTS only adds empty tables, so this is harmless on a
// database that never connects TikTok (production).
//
// One row per TikTok seller authorization (open_id), and one row per shop
// that authorization covers. KELPER supports one TikTok seller at a time,
// like the Shopee side; connecting again replaces the previous one.
db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_tokens (
    open_id TEXT PRIMARY KEY,
    seller_name TEXT,
    seller_base_region TEXT,
    access_token TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    refresh_token TEXT NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    granted_scopes TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tiktok_shops (
    shop_id TEXT PRIMARY KEY,
    open_id TEXT NOT NULL,
    cipher TEXT NOT NULL,
    name TEXT,
    code TEXT,
    region TEXT,
    seller_type TEXT,
    updated_at INTEGER NOT NULL
  );
`);

const REFRESH_BUFFER_SECONDS = 300;
const now = () => Math.floor(Date.now() / 1000);

function saveConnection(tokens, shops) {
  const t = now();
  db.transaction(() => {
    db.prepare('DELETE FROM tiktok_shops').run();
    db.prepare('DELETE FROM tiktok_tokens').run();
    db.prepare(`
      INSERT INTO tiktok_tokens (open_id, seller_name, seller_base_region, access_token, access_expires_at,
        refresh_token, refresh_expires_at, granted_scopes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tokens.openId, tokens.sellerName, tokens.sellerBaseRegion, tokens.accessToken, tokens.accessExpiresAt,
      tokens.refreshToken, tokens.refreshExpiresAt, tokens.grantedScopes.join(','), t);
    const insertShop = db.prepare(`
      INSERT INTO tiktok_shops (shop_id, open_id, cipher, name, code, region, seller_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of shops) {
      insertShop.run(String(s.id), tokens.openId, s.cipher, s.name || '', s.code || '', s.region || '', s.seller_type || '', t);
    }
  })();
}

function clearConnection() {
  db.transaction(() => {
    db.prepare('DELETE FROM tiktok_shops').run();
    db.prepare('DELETE FROM tiktok_tokens').run();
  })();
}

// Safe to send to the browser: no tokens, no ciphers.
function getConnectionSummary() {
  const row = db.prepare('SELECT open_id, seller_name, seller_base_region, access_expires_at, refresh_expires_at, granted_scopes, updated_at FROM tiktok_tokens LIMIT 1').get();
  if (!row) return null;
  const shops = db.prepare('SELECT shop_id, name, code, region, seller_type FROM tiktok_shops ORDER BY name').all();
  return {
    sellerName: row.seller_name,
    region: row.seller_base_region,
    connectedAt: row.updated_at,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    scopes: row.granted_scopes ? row.granted_scopes.split(',').filter(Boolean) : [],
    shops: shops.map((s) => ({ id: s.shop_id, name: s.name, code: s.code, region: s.region, sellerType: s.seller_type })),
  };
}

// The stored access token, refreshed first when it's within 5 minutes of
// expiring (TikTok rotates the refresh token too, so both are saved).
async function getValidAccessToken() {
  const row = db.prepare('SELECT * FROM tiktok_tokens LIMIT 1').get();
  if (!row) throw new Error('TikTok Shop belum terhubung.');
  if (row.access_expires_at - now() > REFRESH_BUFFER_SECONDS) return row.access_token;

  const fresh = await refreshTokens(row.refresh_token);
  db.prepare(`
    UPDATE tiktok_tokens SET access_token = ?, access_expires_at = ?, refresh_token = ?, refresh_expires_at = ?, updated_at = ?
    WHERE open_id = ?
  `).run(fresh.accessToken, fresh.accessExpiresAt, fresh.refreshToken, fresh.refreshExpiresAt, now(), row.open_id);
  return fresh.accessToken;
}

module.exports = { saveConnection, clearConnection, getConnectionSummary, getValidAccessToken };
