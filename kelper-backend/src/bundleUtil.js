const db = require('./db');

const hasItems = db.prepare('SELECT 1 FROM bundle_items WHERE bundle_sku = ? LIMIT 1');

// A bundle listing is one whose SKU starts with KELPER (KELPER-12, "KELPER 22";
// single products are KEL-xx), or that already has contents on file in
// bundle_items (so a bundle with another SKU, detected from the barcode sheet,
// counts too). Shared by the List Bundle page, the bundle item editor and the
// List Barang catalog, which leaves bundles out.
function isBundleSku(sku) {
  const s = String(sku || '');
  return /^KELPER/i.test(s) || !!hasItems.get(s);
}

module.exports = { isBundleSku };
