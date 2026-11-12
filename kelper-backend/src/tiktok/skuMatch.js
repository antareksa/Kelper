const db = require('../db');

// TikTok Seller SKU -> KELPER SKU (2026-11-12). Staff type TikTok's Seller SKUs
// by hand, and on live four were "Kel-32" where Shopee (and so KELPER's HPP,
// barcode and stock) has "KEL-32": KELPER saw two different products, so the
// TikTok one had no HPP or barcode and its order would not match a scan. The
// Shopee catalog is the master list: a TikTok SKU that matches one of its SKUs
// apart from upper/lower case or spaces takes the Shopee spelling. Anything
// else is kept as TikTok has it.
function tiktokSkuMatcher() {
  const bySkuKey = new Map();
  const add = (sku) => { if (sku && !bySkuKey.has(sku.trim().toUpperCase())) bySkuKey.set(sku.trim().toUpperCase(), sku); };
  for (const r of db.prepare('SELECT item_sku FROM shopee_items').all()) add(r.item_sku);
  for (const r of db.prepare('SELECT model_sku FROM shopee_item_models').all()) add(r.model_sku);
  return (sku) => {
    if (!sku) return sku;
    return bySkuKey.get(String(sku).trim().toUpperCase()) || String(sku).trim();
  };
}

module.exports = { tiktokSkuMatcher };
