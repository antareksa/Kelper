const db = require('./db');
const { getValidAccessToken } = require('./shopee/tokenStore');
const { getItemList, getItemBaseInfo, getModelList } = require('./shopee/client');

// The shop's Shopee catalog -> the local cache tables (shopee_items,
// shopee_item_models), and Harga -> products.price. Run by List Barang's Refresh
// button (routes/products.js) and by the server itself about every hour
// (shopeeSync.js's enrichment loop).
//
// Client-requested (2026-10-15): Harga follows Shopee again. From 2026-09-28 it
// was the client's own number (Item Data Excel / edited in List Barang); now every
// catalog sync copies each SKU's Shopee price into products.price, and Harga can
// no longer be set by hand. Past figures never change: an order's price is frozen
// when the order arrives (order_items.price_snapshot, see shopeeSync.js), so a
// later price change only affects orders after it.

const upsertItem = db.prepare(`
  INSERT INTO shopee_items (item_id, shop_id, item_sku, name, item_status, min_purchase_limit, has_model, image_url, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    shop_id = excluded.shop_id,
    item_sku = excluded.item_sku,
    name = excluded.name,
    item_status = excluded.item_status,
    min_purchase_limit = excluded.min_purchase_limit,
    has_model = excluded.has_model,
    image_url = excluded.image_url,
    updated_at = excluded.updated_at
`);

const upsertModel = db.prepare(`
  INSERT INTO shopee_item_models (item_id, model_id, model_sku, model_name, price, stock, model_status, image_url, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id, model_id) DO UPDATE SET
    model_sku = excluded.model_sku,
    model_name = excluded.model_name,
    price = excluded.price,
    stock = excluded.stock,
    model_status = excluded.model_status,
    image_url = excluded.image_url,
    updated_at = excluded.updated_at
`);

// A model's tier_index picks one option per tier_variation dimension (e.g.
// [1, 0] -> color option_list[1], Size option_list[0]). Shopee only attaches
// an "image" to a tier option when the seller explicitly set one per
// variation (typically per-color) — most shops never do, so this is usually
// null and the catalog endpoint falls back to the item's own photo.
function findModelImage(tierVariation, tierIndex) {
  if (!tierVariation || !tierIndex) return null;
  for (let i = 0; i < tierIndex.length; i += 1) {
    const option = tierVariation[i]?.option_list?.[tierIndex[i]];
    if (option?.image?.image_url) return option.image.image_url;
  }
  return null;
}

// Each SKU's Shopee price (current_price: the selling price, after a seller
// discount) into products.price. Only real SKUs (a listing without one has no
// row to match orders against); a SKU on several listings takes the last.
const upsertShopeePrice = db.prepare(`
  INSERT INTO products (sku, price, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    price = excluded.price,
    updated_at = excluded.updated_at
  WHERE products.price IS NOT excluded.price
`);
function applyShopeePrices(shopId) {
  const rows = db
    .prepare(`
      SELECT COALESCE(NULLIF(m.model_sku, ''), NULLIF(i.item_sku, '')) AS sku, m.price
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      WHERE i.shop_id = ? AND m.price IS NOT NULL
      ORDER BY m.updated_at
    `)
    .all(shopId)
    .filter((r) => r.sku);
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const r of rows) upsertShopeePrice.run(r.sku, Math.round(r.price), now);
  })();
  return rows.length;
}

// Pulls the shop's live catalog from Shopee into the local cache tables. Items
// without variants ("has_model": false) don't appear in get_model_list at all;
// their price/stock live directly on the item, so they're synthesized into a
// single model_id=0 row to keep the rest of the app dealing with one shape.
// Throws on a Shopee error.
async function syncShopeeCatalog(shopId) {
  const accessToken = await getValidAccessToken(shopId);
  const now = Math.floor(Date.now() / 1000);

  // Shopee's get_item_list requires a specific item_status per call — a
  // product the seller archives on Shopee (UNLIST) or that gets banned
  // simply stops appearing under NORMAL, so querying only NORMAL would
  // silently leave stale "still active" rows in the local cache forever.
  // Pulling all three keeps status filtering (below) actually meaningful.
  const itemIds = new Set();
  for (const itemStatus of ['NORMAL', 'UNLIST', 'BANNED']) {
    let offset = 0;
    for (;;) {
      const list = await getItemList(accessToken, shopId, { offset, pageSize: 50, itemStatus });
      if (list.error) throw new Error(list.message || list.error);
      for (const item of list.response.item || []) itemIds.add(item.item_id);
      if (!list.response.has_next_page) break;
      offset = list.response.next;
    }
  }

  const itemIdList = [...itemIds];
  let syncedItems = 0;
  let syncedModels = 0;
  for (let i = 0; i < itemIdList.length; i += 50) {
    const batch = itemIdList.slice(i, i + 50);
    const baseInfo = await getItemBaseInfo(accessToken, shopId, batch);
    if (baseInfo.error) throw new Error(baseInfo.message || baseInfo.error);

    for (const item of baseInfo.response.item_list || []) {
      upsertItem.run(
        item.item_id,
        shopId,
        item.item_sku || null,
        item.item_name,
        item.item_status,
        item.purchase_limit_info?.min_purchase_limit ?? null,
        item.has_model ? 1 : 0,
        item.image?.image_url_list?.[0] || null,
        now
      );
      syncedItems += 1;

      if (item.has_model) {
        const models = await getModelList(accessToken, shopId, item.item_id);
        if (models.error) continue; // best-effort — one item's models failing shouldn't abort the whole sync
        for (const model of models.response.model || []) {
          upsertModel.run(
            item.item_id,
            model.model_id,
            model.model_sku || null,
            model.model_name,
            model.price_info?.[0]?.current_price ?? null,
            model.stock_info_v2?.summary_info?.total_available_stock ?? null,
            model.model_status,
            findModelImage(models.response.tier_variation, model.tier_index),
            now
          );
          syncedModels += 1;
        }
      } else {
        upsertModel.run(
          item.item_id,
          0,
          item.item_sku || null,
          item.item_name,
          item.price_info?.[0]?.current_price ?? null,
          item.stock_info_v2?.summary_info?.total_available_stock ?? null,
          item.item_status,
          null,
          now
        );
        syncedModels += 1;
      }
    }
  }

  applyShopeePrices(shopId);
  return { items: syncedItems, models: syncedModels };
}

// The enrichment loop's call: at most every CATALOG_REFRESH_SECONDS (a failed
// attempt waits too), so Harga follows a price change on Shopee within the hour.
const CATALOG_REFRESH_SECONDS = 60 * 60;
const catalogAttemptAt = new Map(); // shopId -> unix seconds of the last attempt
async function refreshCatalogIfDue(shopId) {
  const last = catalogAttemptAt.get(shopId);
  const now = Math.floor(Date.now() / 1000);
  if (last && now - last < CATALOG_REFRESH_SECONDS) return;
  catalogAttemptAt.set(shopId, now);
  await syncShopeeCatalog(shopId);
}

module.exports = { syncShopeeCatalog, applyShopeePrices, refreshCatalogIfDue };
