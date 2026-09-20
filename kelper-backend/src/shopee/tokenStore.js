const db = require('../db');
const { refreshToken, BRAND_CREDENTIALS } = require('./client');

const REFRESH_BUFFER_SECONDS = 300;

async function getValidAccessToken(shopId) {
  const row = db.prepare('SELECT * FROM shopee_tokens WHERE shop_id = ?').get(shopId);
  if (!row) throw new Error(`No token stored for shop ${shopId}`);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at - now > REFRESH_BUFFER_SECONDS) {
    return row.access_token;
  }

  const data = await refreshToken(row.refresh_token, shopId);
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.message || data.error}`);
  }

  db.prepare(`
    UPDATE shopee_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
    WHERE shop_id = ?
  `).run(data.access_token, data.refresh_token, now + data.expire_in, now, shopId);

  return data.access_token;
}

// Mirrors getValidAccessToken but against the Brand Portal app's own token
// table/credentials — see shopee_brand_tokens's comment in db.js for why
// this can't just reuse the main table.
async function getValidBrandAccessToken(shopId) {
  const row = db.prepare('SELECT * FROM shopee_brand_tokens WHERE shop_id = ?').get(shopId);
  if (!row) throw new Error(`No Brand Portal token stored for shop ${shopId}`);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at - now > REFRESH_BUFFER_SECONDS) {
    return row.access_token;
  }

  const data = await refreshToken(row.refresh_token, shopId, BRAND_CREDENTIALS);
  if (data.error) {
    throw new Error(`Brand Portal token refresh failed: ${data.message || data.error}`);
  }

  db.prepare(`
    UPDATE shopee_brand_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
    WHERE shop_id = ?
  `).run(data.access_token, data.refresh_token, now + data.expire_in, now, shopId);

  return data.access_token;
}

module.exports = { getValidAccessToken, getValidBrandAccessToken };
