const express = require('express');
const db = require('../db');

const router = express.Router();

const { isBundleSku } = require('../bundleUtil');

// One entry per Shopee listing with a single variant (the Robot test item
// with two variants has no one SKU, so it never appears): the SKU it is
// sold under, same rule as /products/catalog.
function listingsBySku() {
  const modelsByItem = new Map();
  for (const m of db.prepare('SELECT item_id, model_sku, stock FROM shopee_item_models').all()) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }
  const bySku = new Map();
  for (const item of db.prepare('SELECT item_id, item_sku, name, item_status FROM shopee_items').all()) {
    const models = modelsByItem.get(item.item_id) || [];
    if (models.length > 1) continue;
    const sku = models[0]?.model_sku || item.item_sku;
    if (!sku) continue;
    bySku.set(sku, { sku, item_id: item.item_id, name: item.name, status: item.item_status, stock: models[0]?.stock ?? null });
  }
  return bySku;
}

// Every bundle with the items inside it, plus the list of single products
// the editor can pick components from.
router.get('/', (req, res) => {
  const listings = listingsBySku();
  const products = new Map(db.prepare('SELECT sku, name, barcode FROM products').all().map((p) => [p.sku, p]));
  const itemsByBundle = new Map();
  for (const r of db.prepare('SELECT bundle_sku, component_sku, qty FROM bundle_items ORDER BY rowid').all()) {
    if (!itemsByBundle.has(r.bundle_sku)) itemsByBundle.set(r.bundle_sku, []);
    itemsByBundle.get(r.bundle_sku).push(r);
  }

  const bundleSkus = new Set([...listings.keys()].filter(isBundleSku));
  for (const sku of itemsByBundle.keys()) bundleSkus.add(sku);

  const bundles = [...bundleSkus]
    .map((sku) => {
      const listing = listings.get(sku);
      const items = (itemsByBundle.get(sku) || []).map((i) => ({
        sku: i.component_sku,
        qty: i.qty,
        name: listings.get(i.component_sku)?.name || products.get(i.component_sku)?.name || null,
        barcode: products.get(i.component_sku)?.barcode ?? null,
      }));
      return {
        sku,
        item_id: listing?.item_id ?? null,
        name: listing?.name || products.get(sku)?.name || sku,
        status: listing?.status ?? null,
        stock: listing?.stock ?? null,
        items,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const singles = [...listings.values()]
    .filter((l) => !isBundleSku(l.sku))
    .map((l) => ({ sku: l.sku, name: l.name, barcode: products.get(l.sku)?.barcode ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ bundles, singles });
});

// Replaces a bundle's whole item list. Each component must be a known single
// product (never another bundle, and never the bundle itself), qty a positive
// whole number, no SKU twice -- so a typo can't silently create a component
// nobody can ever scan.
router.put('/:sku/items', (req, res) => {
  const bundleSku = req.params.sku;
  const items = req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'invalid_items', message: 'items harus berupa daftar.' });
  }

  const listings = listingsBySku();
  const known = new Set([...listings.keys(), ...db.prepare('SELECT sku FROM products').all().map((p) => p.sku)]);
  const seen = new Set();
  for (const it of items) {
    const sku = typeof it?.sku === 'string' ? it.sku.trim() : '';
    if (!sku || !known.has(sku)) {
      return res.status(400).json({ error: 'unknown_component', message: `SKU "${sku}" tidak ada di daftar produk.` });
    }
    if (sku === bundleSku || isBundleSku(sku)) {
      return res.status(400).json({ error: 'bundle_in_bundle', message: `${sku} adalah bundle, tidak bisa jadi isi bundle.` });
    }
    if (seen.has(sku)) {
      return res.status(400).json({ error: 'duplicate_component', message: `${sku} muncul dua kali.` });
    }
    if (!Number.isInteger(it.qty) || it.qty < 1) {
      return res.status(400).json({ error: 'invalid_qty', message: `Jumlah ${sku} harus bilangan bulat minimal 1.` });
    }
    seen.add(sku);
  }

  const save = db.transaction(() => {
    db.prepare('DELETE FROM bundle_items WHERE bundle_sku = ?').run(bundleSku);
    for (const it of items) {
      db.prepare('INSERT INTO bundle_items (bundle_sku, component_sku, qty) VALUES (?, ?, ?)').run(bundleSku, it.sku.trim(), it.qty);
    }
  });
  save();
  res.json({ ok: true, sku: bundleSku, count: items.length });
});

module.exports = router;
