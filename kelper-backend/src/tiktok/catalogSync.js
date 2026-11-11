const db = require('../db');
const { apiRequest } = require('./client');

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
          seller_sku: s.seller_sku || null,
          product_name: p.title,
          sku_name: detail ? (attrs.map((a) => a.value_name).filter(Boolean).join(' / ') || null) : null,
          price: Number(s.price?.sale_price) || null,
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
}

module.exports = { syncTikTokCatalog };
