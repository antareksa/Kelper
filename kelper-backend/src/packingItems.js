const db = require('./db');

const bundleComponents = db.prepare('SELECT component_sku, qty FROM bundle_items WHERE bundle_sku = ? ORDER BY rowid');

// Same model-then-item lookup the rest of the app uses to turn a SKU into its
// listing name; falls back to the products table, then the bare SKU.
const listingName = db.prepare(`
  SELECT COALESCE(NULLIF(m.model_name, ''), i.name) AS name, i.name AS item_name
  FROM shopee_item_models m
  JOIN shopee_items i ON i.item_id = m.item_id
  WHERE COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) = ?
  LIMIT 1
`);
const productName = db.prepare('SELECT name FROM products WHERE sku = ?');

function nameForSku(sku) {
  const l = listingName.get(sku);
  if (l?.item_name) return l.item_name;
  return productName.get(sku)?.name || sku;
}

// What an operator actually has to put in the box and scan for an order
// (client-requested 2026-10-03). A bundle line is replaced by the single
// products inside it -- bundle A = item a + item b, ordered together with an
// item a, means three scans: a, b, a. Parts of the same SKU are summed (a x2)
// because scan_progress is keyed by SKU, and a part ordered x2 of a bundle
// ordered x3 needs 6 scans.
//
// A bundle with no contents on file yet stays a plain line, so it is still
// scanned by its own SKU/barcode exactly as before -- an incomplete bundle
// list must never make an order unpackable. Lines that came from a bundle
// carry `from_bundles` (the bundle SKUs) so the UI can say why they are there.
//
// Only packing looks through bundles. Money (Omzet/Laba, price/HPP snapshots)
// is still computed from the order_items rows as Shopee sold them.
function expandPackingItems(orderSn) {
  const rows = db.prepare('SELECT * FROM order_items WHERE order_sn = ?').all(orderSn);
  const lines = new Map();

  const add = (sku, line) => {
    const existing = lines.get(sku);
    if (!existing) {
      lines.set(sku, line);
      return;
    }
    existing.qty += line.qty;
    for (const b of line.from_bundles || []) {
      if (!existing.from_bundles) existing.from_bundles = [];
      if (!existing.from_bundles.includes(b)) existing.from_bundles.push(b);
    }
  };

  for (const row of rows) {
    const parts = bundleComponents.all(row.sku);
    if (parts.length === 0) {
      add(row.sku, { ...row });
      continue;
    }
    for (const p of parts) {
      add(p.component_sku, {
        sku: p.component_sku,
        product_name: nameForSku(p.component_sku),
        qty: p.qty * row.qty,
        from_bundles: [row.sku],
      });
    }
  }
  return [...lines.values()];
}

module.exports = { expandPackingItems };
