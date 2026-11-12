const db = require('../db');
const { apiRequest } = require('./client');
const { tiktokSkuMatcher } = require('./skuMatch');

// TikTok Shop / Tokopedia product list (2026-11-10, client-requested: List
// Barang per marketplace, each with its own stock and price). Copies TikTok's
// own catalog into tiktok_catalog (see db.js), one row per TikTok SKU, about
// every REFRESH_SECONDS. Read-only toward TikTok.
//
// The search answer has price, stock and seller SKU but no images or variant
// names, so a product's detail is read too -- only when TikTok's update_time
// for it changed since the last sync, to keep the call count down.

const REFRESH_SECONDS = 60 * 60;
const PAGE_SIZE = '100';
const lastSyncAt = new Map(); // tiktok shop id -> unix seconds; in memory, a restart syncs at once

function now() {
  return Math.floor(Date.now() / 1000);
}

const firstUrl = (img) => img?.urls?.[0] || img?.thumb_urls?.[0] || null;

async function searchAllProducts(opts) {
  const products = [];
  let pageToken = '';
  do {
    const query = { page_size: PAGE_SIZE };
    if (pageToken) query.page_token = pageToken;
    const page = await apiRequest('POST', '/product/202309/products/search', { ...opts, query, body: {} });
    products.push(...(page?.products || []));
    pageToken = page?.next_page_token || '';
  } while (pageToken);
  return products;
}

const upsertRow = db.prepare(`
  INSERT INTO tiktok_catalog (shop_id, product_id, sku_id, seller_sku, product_name, sku_name, price, tiktok_stock, image_url, status, product_update_time, synced_at)
  VALUES (@shop_id, @product_id, @sku_id, @seller_sku, @product_name, @sku_name, @price, @tiktok_stock, @image_url, @status, @product_update_time, @synced_at)
  ON CONFLICT(shop_id, sku_id) DO UPDATE SET
    product_id = excluded.product_id, seller_sku = excluded.seller_sku, product_name = excluded.product_name,
    sku_name = COALESCE(excluded.sku_name, tiktok_catalog.sku_name), price = excluded.price,
    tiktok_stock = excluded.tiktok_stock, image_url = COALESCE(excluded.image_url, tiktok_catalog.image_url),
    status = excluded.status, product_update_time = excluded.product_update_time, synced_at = excluded.synced_at
`);

async function syncTikTokCatalog(opts, tiktokShopId, { force = false } = {}) {
  const shopId = String(tiktokShopId);
  if (!force && now() - (lastSyncAt.get(shopId) || 0) < REFRESH_SECONDS) return;
  lastSyncAt.set(shopId, now());

  const products = await searchAllProducts(opts);
  const known = new Map(
    db.prepare('SELECT product_id, MAX(product_update_time) AS t FROM tiktok_catalog WHERE shop_id = ? GROUP BY product_id').all(shopId).map((r) => [r.product_id, r.t])
  );
  const syncedAt = now();
  const toKelperSku = tiktokSkuMatcher();
  let detailed = 0;

  for (const p of products) {
    // Variant names and images: from the detail, only when the product changed.
    let detail = null;
    if (known.get(p.id) !== p.update_time) {
      try {
        detail = await apiRequest('GET', `/product/202309/products/${p.id}`, opts);
        detailed += 1;
      } catch (err) {
        console.warn(`[server] TikTok product detail ${p.id} failed: ${err.tiktokCode ?? ''} ${err.message}`);
      }
    }
    const detailSkus = new Map((detail?.skus || []).map((s) => [s.id, s]));
    const mainImage = firstUrl(detail?.main_images?.[0]);

    db.transaction(() => {
      for (const s of p.skus || []) {
        const d = detailSkus.get(s.id);
        const attrs = d?.sales_attributes || [];
        upsertRow.run({
          shop_id: shopId,
          product_id: p.id,
          sku_id: s.id,
          seller_sku: toKelperSku(s.seller_sku) || null,
          product_name: p.title,
          sku_name: detail ? (attrs.map((a) => a.value_name).filter(Boolean).join(' / ') || null) : null,
          // sale_price is filled for cross-border sellers only; a local seller
          // (the client, Indonesia) gets tax_exclusive_price (API spec; live
          // 2026-11-12: every price was empty with sale_price alone).
          price: Number(s.price?.sale_price) || Number(s.price?.tax_exclusive_price) || null,
          tiktok_stock: (s.inventory || []).reduce((t, i) => t + (Number(i.quantity) || 0), 0),
          image_url: firstUrl(attrs.find((a) => a.sku_img)?.sku_img) || mainImage,
          status: p.status || null,
          product_update_time: p.update_time || null,
          synced_at: syncedAt,
        });
      }
    })();
  }

  // A product TikTok no longer lists at all is marked, not deleted, so its stock
  // and history stay readable.
  db.prepare("UPDATE tiktok_catalog SET status = 'DELETED' WHERE shop_id = ? AND synced_at < ?").run(shopId, syncedAt);
  console.log(`[server] TikTok catalog: ${products.length} product(s), ${detailed} detail(s) read (shop ${shopId})`);

  try {
    await syncTikTokDiscounts(opts, shopId);
  } catch (err) {
    // 105005: the app has no Promotion scope yet (needs adding in Partner Center
    // and the shop connecting again). Said once per run, not every hour.
    if (err.tiktokCode === 105005) {
      if (!promotionDeniedLogged.has(shopId)) console.warn(`[server] TikTok discounts: no Promotion permission yet (shop ${shopId}) — Harga shows the normal price`);
      promotionDeniedLogged.add(shopId);
    } else {
      console.warn(`[server] TikTok discounts failed: ${err.tiktokCode ?? ''} ${err.message}`);
    }
  }
}

// Harga after discount (2026-11-12, client-requested). TikTok's product list has
// only the normal price; discounts live in the Promotion API. For every ongoing
// product promotion open to all buyers -- fixed price, % off, flash sale -- the
// price each SKU gets, and the lowest one wins (TikTok shows the buyer the best
// price). Shipping discounts, buy-more-save-more and gifts are not a SKU price
// and are left out. Stored with the end time, so an ended promotion stops
// counting even before the next hourly sync.
const promotionDeniedLogged = new Set();
const PRICE_TYPES = new Set(['FIXED_PRICE', 'DIRECT_DISCOUNT', 'FLASHSALE']);

// The price one promotion entry gives a SKU whose normal price is base.
function promoPrice(entry, base) {
  const fixed = Number(entry?.activity_price?.amount);
  if (fixed > 0) return fixed;
  const pct = Number(entry?.discount);
  if (pct > 0 && pct < 100 && base > 0) return Math.round(base * (100 - pct) / 100);
  return null;
}

async function syncTikTokDiscounts(opts, shopId) {
  const activities = [];
  let pageToken = '';
  do {
    const body = { status: 'ONGOING', page_size: 100 };
    if (pageToken) body.page_token = pageToken;
    const page = await apiRequest('POST', '/promotion/202309/activities/search', { ...opts, body });
    activities.push(...(page?.activities || []).filter((a) => PRICE_TYPES.has(a.activity_type)));
    pageToken = page?.next_page_token || '';
  } while (pageToken);
  promotionDeniedLogged.delete(shopId);

  const skus = db.prepare("SELECT product_id, sku_id, price FROM tiktok_catalog WHERE shop_id = ? AND COALESCE(status, '') != 'DELETED'").all(shopId);
  const skusByProduct = new Map();
  for (const s of skus) {
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push(s);
  }
  const best = new Map(); // sku_id -> { price, until }
  const offer = (sku, price, until) => {
    if (!(price > 0) || (sku.price && price >= sku.price)) return;
    const cur = best.get(sku.sku_id);
    if (!cur || price < cur.price) best.set(sku.sku_id, { price, until });
  };

  for (const a of activities) {
    const detail = await apiRequest('GET', `/promotion/202309/activities/${a.id}`, opts);
    const userType = detail?.target_user_info?.user_type;
    if (userType && userType !== 'ALL_USER') continue; // e.g. new-customer only: not the public price
    const until = detail?.end_time || a.end_time || null;
    for (const p of detail?.products || []) {
      const productSkus = skusByProduct.get(p.id) || [];
      if (p.skus?.length) {
        for (const e of p.skus) {
          const sku = productSkus.find((s) => s.sku_id === e.id);
          if (sku) offer(sku, promoPrice(e, sku.price), until);
        }
      } else {
        for (const sku of productSkus) offer(sku, promoPrice(p, sku.price), until);
      }
    }
  }

  db.transaction(() => {
    db.prepare('UPDATE tiktok_catalog SET discount_price = NULL, discount_until = NULL WHERE shop_id = ?').run(shopId);
    const set = db.prepare('UPDATE tiktok_catalog SET discount_price = ?, discount_until = ? WHERE shop_id = ? AND sku_id = ?');
    for (const [skuId, d] of best) set.run(d.price, d.until, shopId, skuId);
  })();
  console.log(`[server] TikTok discounts: ${activities.length} ongoing promotion(s), ${best.size} SKU(s) discounted (shop ${shopId})`);
}

// The price a TikTok SKU sells at right now: the promotion price while one runs,
// else the normal price. SQL for a tiktok_catalog row aliased c (or none).
const EFFECTIVE_PRICE_SQL = (c = '') => `CASE WHEN ${c}discount_price IS NOT NULL AND (${c}discount_until IS NULL OR ${c}discount_until > strftime('%s','now')) THEN ${c}discount_price ELSE ${c}price END`;

module.exports = { syncTikTokCatalog, syncTikTokDiscounts, promoPrice, EFFECTIVE_PRICE_SQL };
