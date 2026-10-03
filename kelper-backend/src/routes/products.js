const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getItemList, getItemBaseInfo, getModelList } = require('../shopee/client');
const { startOfMonthWIB } = require('../wib');
const { isBundleSku } = require('../bundleUtil');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// "Rp.10.000" -> 10000. Returns null (never 0) when the cell can't be read as
// a number, so profit math elsewhere never silently treats an unreadable
// cost as zero cost — same rule the tech doc sets for HPP generally.
function parseRupiah(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Math.round(value);
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits ? Number(digits) : null;
}

const upsertProduct = db.prepare(`
  INSERT INTO products (sku, name, hpp, barcode, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    name = excluded.name,
    hpp = excluded.hpp,
    barcode = excluded.barcode,
    updated_at = excluded.updated_at
`);

// ExcelJS hands back formula cells as { formula, result } (or a bare
// { sharedFormula } when the file carries no cached value) and rich text as
// { richText }. Only a cell that actually resolves to a value is usable.
function cellValue(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? null;
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    return null; // formula with no cached result
  }
  return v;
}

function cellText(cell) {
  const v = cellValue(cell);
  return v == null ? '' : String(v).trim();
}

// The client's spreadsheets identify products by their Shopee listing NAME,
// not SKU. Names are compared after lowercasing, dropping every
// non-alphanumeric character, and folding the one spelling the sheets and
// Shopee disagree on (telescopic/teleskopik), so spacing, punctuation and
// "125CM" vs "125 cm" differences don't matter.
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/telescopic/g, 'teleskopik')
    .replace(/[^a-z0-9]/g, '');
}

// Name -> SKU for every product we know by name: single-variant Shopee
// listings (SKU = model SKU or item SKU, same rule as /catalog) plus names
// kept in the products table. A normalized name that points at two different
// SKUs is ambiguous and dropped, so an upload never guesses between them.
function buildNameToSku() {
  const map = new Map();
  const ambiguous = new Set();
  const add = (name, sku) => {
    const key = normalizeName(name);
    if (!key || !sku) return;
    if (map.has(key) && map.get(key) !== sku) ambiguous.add(key);
    else map.set(key, sku);
  };

  const modelsByItem = new Map();
  for (const m of db.prepare('SELECT item_id, model_sku FROM shopee_item_models').all()) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }
  for (const item of db.prepare('SELECT item_id, item_sku, name FROM shopee_items').all()) {
    const itemModels = modelsByItem.get(item.item_id) || [];
    if (itemModels.length > 1) continue; // variations share one listing name
    add(item.name, itemModels[0]?.model_sku || item.item_sku);
  }
  for (const p of db.prepare("SELECT sku, name FROM products WHERE name IS NOT NULL AND name != ''").all()) {
    add(p.name, p.sku);
  }
  for (const key of ambiguous) map.delete(key);
  return map;
}

// Finds a header cell by its text so an upload still works if the client adds
// or reorders columns; returns the 1-based column number or null.
function findColumn(sheet, headerRow, pattern) {
  let found = null;
  sheet.getRow(headerRow).eachCell((cell, col) => {
    if (found == null && pattern.test(cellText(cell))) found = col;
  });
  return found;
}

// Parses the uploaded workbook's first sheet, or answers 400 itself and
// returns null.
async function loadSheet(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'file_required', message: 'No file was uploaded.' });
    return null;
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    res.status(400).json({ error: 'invalid_file', message: 'Could not read this as an Excel (.xlsx) file.' });
    return null;
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    res.status(400).json({ error: 'empty_file', message: 'The file has no sheets.' });
    return null;
  }
  return sheet;
}

// Two accepted layouts, told apart by the header row:
//  - "Nama Barang online | HPP" (the client's sheet from 2026-10-03): matched
//    to products by listing name; writes HPP only.
//  - the older "Nama | SKU | Modal | Barcode" sheet: matched by SKU.
// Row 1 is always the header.
router.post('/import-hpp', upload.single('file'), async (req, res) => {
  const sheet = await loadSheet(req, res);
  if (!sheet) return;

  const now = Math.floor(Date.now() / 1000);

  if (!/sku/i.test(cellText(sheet.getRow(1).getCell(2)))) {
    const nameCol = findColumn(sheet, 1, /nama/i) || 1;
    const hppCol = findColumn(sheet, 1, /hpp|modal/i) || 2;
    const nameToSku = buildNameToSku();
    let imported = 0;
    const unmatched = [];
    const unreadable = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = cellText(row.getCell(nameCol));
      if (!name) return;
      const hpp = parseRupiah(cellValue(row.getCell(hppCol)));
      if (hpp == null) {
        unreadable.push(name);
        return;
      }
      const sku = nameToSku.get(normalizeName(name));
      if (!sku) {
        unmatched.push(name);
        return;
      }
      upsertHpp.run(sku, hpp, now);
      imported += 1;
    });

    return res.json({ ok: true, imported, unmatched, unreadable, skippedRows: [] });
  }

  let imported = 0;
  const skippedRows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header: Nama | SKU | Modal | Barcode

    const nameCell = row.getCell(1).value;
    const skuCell = row.getCell(2).value;
    const hpp = parseRupiah(row.getCell(3).value);
    const barcodeCell = row.getCell(4).value;

    const sku = skuCell != null ? String(skuCell).trim() : '';
    if (!sku) {
      skippedRows.push(rowNumber);
      return;
    }

    const name = nameCell != null ? String(nameCell).trim() : null;
    const barcode = barcodeCell != null ? String(barcodeCell).trim() : null;
    upsertProduct.run(sku, name, hpp, barcode, now);
    imported += 1;
  });

  res.json({ ok: true, imported, skippedRows, unmatched: [], unreadable: [] });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT sku, name, hpp, barcode, updated_at FROM products ORDER BY name').all();
  res.json(rows);
});

// Upserts only `stock` — a bare INSERT ... ON CONFLICT touching every column
// (like upsertProduct above) would blank out an existing row's name/hpp/
// barcode for a SKU that's never been through the HPP import.
const upsertStock = db.prepare(`
  INSERT INTO products (sku, stock, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    stock = excluded.stock,
    updated_at = excluded.updated_at
`);

// Client's own manual stock count per SKU — see db.js migration comment for
// why this is a separate field from Shopee's live stock.
router.put('/:sku/stock', (req, res) => {
  const sku = req.params.sku;
  const { stock } = req.body;
  if (stock !== null && (typeof stock !== 'number' || !Number.isInteger(stock) || stock < 0)) {
    return res.status(400).json({ error: 'invalid_stock', message: 'stock must be a non-negative integer or null.' });
  }
  upsertStock.run(sku, stock, Math.floor(Date.now() / 1000));
  res.json({ ok: true, sku, stock });
});

const BARCODE_PATTERN = /^[A-Za-z0-9._\-/]{1,64}$/;

// The client's "BARCODE ONLINE" sheet (a Shopee Product List export): per row,
// a GTIN (column under the "GTIN" header) and the Shopee listing name two
// columns to its right. A listing on ONE row is a single product and gets
// that GTIN as its barcode. A bundle listing is a merged block of SEVERAL
// rows, one per component GTIN ("8994450940097 X 10" = ten of that
// component) -- detected from that layout alone, see below. Each
// component GTIN is resolved to a single product through the same sheet's
// single rows, and the bundle's item list is stored in bundle_items.
//
// Anything it can't place with certainty is returned by name, not guessed:
//  - unmatched: listing name that isn't a known product
//  - ambiguous: a non-bundle listing that appears with more than one GTIN
//  - conflicts: a barcode already used by a different product
//  - unresolvedBundles: a bundle with a component GTIN no product owns
router.post('/import-barcode', upload.single('file'), async (req, res) => {
  const sheet = await loadSheet(req, res);
  if (!sheet) return;

  let headerRow = null;
  let gtinCol = null;
  sheet.eachRow((row, rowNumber) => {
    if (headerRow != null) return;
    row.eachCell((cell, col) => {
      if (headerRow == null && /^gtin$/i.test(cellText(cell))) {
        headerRow = rowNumber;
        gtinCol = col;
      }
    });
  });
  if (headerRow == null) {
    return res.status(400).json({ error: 'gtin_column_missing', message: 'Kolom "GTIN" tidak ditemukan di sheet pertama.' });
  }
  const shortNameCol = gtinCol + 1;
  const nameCol = gtinCol + 2;

  // Bundles are detected from the sheet's own layout, not from any SKU
  // naming: a BLOCK is a run of consecutive rows sharing both the short name
  // and the Shopee listing name (in the sheet they are merged cells, ExcelJS
  // mirrors the merged value onto every row). A block with several rows is a
  // bundle -- one row per component barcode -- and so is a single row written
  // "<barcode> X <n>" (n of that component). A one-row block is a single
  // product. Rows that merely share a listing name but have DIFFERENT short
  // names (two separate products typed against one listing) are not a block,
  // so they are never mistaken for a bundle.
  const blocks = [];
  const unmatched = [];
  let prev = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const m = cellText(row.getCell(gtinCol)).match(/^(\d{8,14})(?:\s*[xX]\s*(\d+))?$/);
    if (!m) return; // blank, or a repeated header row
    const name = cellText(row.getCell(nameCol));
    if (!name) {
      unmatched.push(`${cellText(row.getCell(shortNameCol)) || m[1]} (tanpa nama produk Shopee)`);
      prev = null;
      return;
    }
    const shortKey = normalizeName(cellText(row.getCell(shortNameCol)));
    const key = normalizeName(name);
    const qty = m[2] ? Number(m[2]) : 1;
    if (prev && prev.key === key && prev.shortKey === shortKey) {
      if (!prev.entries.some((e) => e.gtin === m[1] && e.qty === qty)) prev.entries.push({ gtin: m[1], qty });
    } else {
      prev = { key, shortKey, name, entries: [{ gtin: m[1], qty }] };
      blocks.push(prev);
    }
  });

  // Per listing: its bundle blocks and its single blocks. The same bundle
  // typed twice (as the sheet does for Handle + Sponge Mop) just repeats the
  // same components.
  const listings = new Map();
  for (const b of blocks) {
    if (!listings.has(b.key)) listings.set(b.key, { name: b.name, bundleEntries: new Map(), bundleConflict: false, singleGtins: new Set(), hasBundle: false });
    const l = listings.get(b.key);
    if (b.entries.length > 1 || b.entries.some((e) => e.qty > 1)) {
      l.hasBundle = true;
      for (const e of b.entries) {
        if (l.bundleEntries.has(e.gtin) && l.bundleEntries.get(e.gtin) !== e.qty) l.bundleConflict = true;
        l.bundleEntries.set(e.gtin, e.qty);
      }
    } else {
      l.singleGtins.add(b.entries[0].gtin);
    }
  }

  const nameToSku = buildNameToSku();
  const singles = []; // { sku, gtin }
  const bundles = []; // { sku, name, entries }
  const ambiguous = [];
  for (const [key, l] of listings) {
    const sku = nameToSku.get(key);
    if (!sku) {
      unmatched.push(l.name);
    } else if (l.hasBundle && l.singleGtins.size === 0 && !l.bundleConflict) {
      bundles.push({ sku, name: l.name, entries: [...l.bundleEntries].map(([gtin, qty]) => ({ gtin, qty })) });
    } else if (!l.hasBundle && l.singleGtins.size === 1) {
      singles.push({ sku, gtin: [...l.singleGtins][0] });
    } else {
      ambiguous.push(l.name);
    }
  }

  // Barcodes for single products.
  const now = Math.floor(Date.now() / 1000);
  const conflicts = [];
  const gtinToSku = new Map();
  let barcodesSet = 0;
  const seenGtin = new Map();
  for (const s of singles) {
    if (seenGtin.has(s.gtin) && seenGtin.get(s.gtin) !== s.sku) {
      conflicts.push(`${s.gtin} dipakai ${seenGtin.get(s.gtin)} dan ${s.sku} di file`);
      continue;
    }
    seenGtin.set(s.gtin, s.sku);
    if (!BARCODE_PATTERN.test(s.gtin)) continue;
    const other = db.prepare('SELECT sku FROM products WHERE barcode = ? AND sku != ?').get(s.gtin, s.sku);
    if (other) {
      conflicts.push(`${s.gtin} (${s.sku}) sudah dipakai ${other.sku}`);
      continue;
    }
    upsertBarcode.run(s.sku, s.gtin, now);
    gtinToSku.set(s.gtin, s.sku);
    barcodesSet += 1;
  }

  // Bundles: resolve each component GTIN, preferring this sheet's singles,
  // then any barcode already stored.
  const unresolvedBundles = [];
  let bundlesSet = 0;
  const replaceItems = db.transaction((bundleSku, items) => {
    db.prepare('DELETE FROM bundle_items WHERE bundle_sku = ?').run(bundleSku);
    for (const it of items) {
      db.prepare('INSERT INTO bundle_items (bundle_sku, component_sku, qty) VALUES (?, ?, ?)').run(bundleSku, it.sku, it.qty);
    }
  });
  for (const b of bundles) {
    const items = [];
    let failed = null;
    for (const e of b.entries) {
      const sku = gtinToSku.get(e.gtin) || db.prepare('SELECT sku FROM products WHERE barcode = ?').get(e.gtin)?.sku;
      if (!sku || sku === b.sku) {
        failed = e.gtin;
        break;
      }
      const existing = items.find((i) => i.sku === sku);
      if (existing) existing.qty += e.qty;
      else items.push({ sku, qty: e.qty });
    }
    if (failed) {
      unresolvedBundles.push(`${b.name}: barcode ${failed} bukan milik produk mana pun`);
      continue;
    }
    replaceItems(b.sku, items);
    bundlesSet += 1;
  }

  res.json({ ok: true, barcodesSet, bundlesSet, unmatched, ambiguous, conflicts, unresolvedBundles });
});

// Bulk version of the stock edit above, from the client's daily stock sheet
// ("STOKAN ONLINE ..."): matches each DESCRIPSI to a product by listing name
// and sets the local stock count to its "STOK AKHIR" column. A row whose
// STOK AKHIR is empty (or a formula the file carries no result for) is
// reported, never written as 0 -- an unknown count must not read as sold out.
router.post('/import-stock', upload.single('file'), async (req, res) => {
  const sheet = await loadSheet(req, res);
  if (!sheet) return;

  const nameCol = findColumn(sheet, 1, /descrip|deskrip|nama/i) || 1;
  const stockCol = findColumn(sheet, 1, /stok\s*akhir|stock\s*akhir/i);
  if (!stockCol) {
    return res.status(400).json({
      error: 'stock_column_missing',
      message: 'Kolom "STOK AKHIR" tidak ditemukan di baris pertama sheet pertama.',
    });
  }

  const nameToSku = buildNameToSku();
  const now = Math.floor(Date.now() / 1000);
  let imported = 0;
  const unmatched = [];
  const unreadable = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellText(row.getCell(nameCol));
    if (!name) return;

    const raw = cellValue(row.getCell(stockCol));
    const stock = raw === null || raw === '' ? null : Number(raw);
    if (stock === null || !Number.isFinite(stock) || stock < 0) {
      unreadable.push(name);
      return;
    }
    const sku = nameToSku.get(normalizeName(name));
    if (!sku) {
      unmatched.push(name);
      return;
    }
    upsertStock.run(sku, Math.round(stock), now);
    imported += 1;
  });

  res.json({ ok: true, imported, unmatched, unreadable });
});

const upsertHpp = db.prepare(`
  INSERT INTO products (sku, hpp, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    hpp = excluded.hpp,
    updated_at = excluded.updated_at
`);

// Client-requested (2026-09-28): inline single-SKU HPP edit in List Barang,
// alongside the existing bulk Excel import (/import-hpp above) — both write
// to the same products.hpp column, so either path stays valid and neither
// overwrites fields the other doesn't touch (unlike upsertProduct, this
// only touches hpp/updated_at).
router.put('/:sku/hpp', (req, res) => {
  const sku = req.params.sku;
  const { hpp } = req.body;
  if (hpp !== null && (typeof hpp !== 'number' || !Number.isInteger(hpp) || hpp < 0)) {
    return res.status(400).json({ error: 'invalid_hpp', message: 'hpp must be a non-negative integer or null.' });
  }
  upsertHpp.run(sku, hpp, Math.floor(Date.now() / 1000));
  res.json({ ok: true, sku, hpp });
});

const upsertPrice = db.prepare(`
  INSERT INTO products (sku, price, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    price = excluded.price,
    updated_at = excluded.updated_at
`);

// Client's own manual selling price per SKU — see db.js migration comment.
// This is what the Dashboard's Omzet/Laba and this page's own profit
// columns are computed from now, not Shopee's synced price.
router.put('/:sku/price', (req, res) => {
  const sku = req.params.sku;
  const { price } = req.body;
  if (price !== null && (typeof price !== 'number' || !Number.isInteger(price) || price < 0)) {
    return res.status(400).json({ error: 'invalid_price', message: 'price must be a non-negative integer or null.' });
  }
  upsertPrice.run(sku, price, Math.floor(Date.now() / 1000));
  res.json({ ok: true, sku, price });
});

const upsertBarcode = db.prepare(`
  INSERT INTO products (sku, barcode, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    barcode = excluded.barcode,
    updated_at = excluded.updated_at
`);

// Client-requested (2026-10-03): inline single-SKU barcode edit in List
// Barang. Until now a barcode could only arrive through the Excel import, and
// one misaligned row left a product with no barcode (and its barcode number
// sitting in the HPP column), so the Packing Station couldn't match that
// product's scan at all -- see routes/packing.js's /scan-item, which resolves
// a scanned value through products.barcode first.
//
// Rejects a barcode already used by a DIFFERENT product (or equal to another
// product's SKU): /scan-item takes the first match, so a shared value would
// silently resolve to the wrong item instead of failing visibly. Only touches
// barcode/updated_at, like the HPP/price edits. Empty clears it back to null.
router.put('/:sku/barcode', (req, res) => {
  const sku = req.params.sku;
  const raw = req.body.barcode;
  if (raw !== null && typeof raw !== 'string') {
    return res.status(400).json({ error: 'invalid_barcode', message: 'barcode must be text or null.' });
  }
  const barcode = raw == null || raw.trim() === '' ? null : raw.trim();
  if (barcode !== null && !/^[A-Za-z0-9._\-/]{1,64}$/.test(barcode)) {
    return res.status(400).json({
      error: 'invalid_barcode',
      message: 'Barcode hanya boleh huruf, angka, dan . _ - / (tanpa spasi), maksimal 64 karakter.',
    });
  }

  if (barcode !== null) {
    const sameBarcode = db.prepare('SELECT sku FROM products WHERE barcode = ? AND sku != ?').get(barcode, sku);
    if (sameBarcode) {
      return res.status(409).json({
        error: 'duplicate_barcode',
        message: `Barcode ${barcode} sudah dipakai SKU ${sameBarcode.sku}.`,
      });
    }
    const sameAsSku = db.prepare('SELECT sku FROM products WHERE sku = ? AND sku != ?').get(barcode, sku);
    if (sameAsSku) {
      return res.status(409).json({
        error: 'duplicate_barcode',
        message: `Barcode ${barcode} sama dengan SKU ${sameAsSku.sku}.`,
      });
    }
  }

  upsertBarcode.run(sku, barcode, Math.floor(Date.now() / 1000));
  res.json({ ok: true, sku, barcode });
});

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

// Pulls the shop's live catalog from Shopee into the local cache tables —
// on demand (the Refresh button), not on every page load. Items without
// variants ("has_model": false) don't appear in get_model_list at all; their
// price/stock live directly on the item, so they're synthesized into a
// single model_id=0 row to keep the rest of the app dealing with one shape.
router.post('/sync-shopee', async (req, res) => {
  const shopId = Number(req.body.shop_id || req.query.shop_id);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  try {
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

    res.json({ ok: true, items: syncedItems, models: syncedModels });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: err.message });
  }
});

// null (never 0) when there's no basis for a % change — same convention as
// dashboard.js's own pctChange, duplicated here rather than shared since
// it's a 3-line pure function and the two route files have no other reason
// to depend on each other.
function pctChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// Qty sold per SKU in [startTs, endTs) — used for the catalog's Qty/Omset
// Ini/Lalu columns (client-requested 2026-09-26). Omset is estimated as
// qty x CURRENT catalog price (same "no real per-order historical price
// available" trade-off dashboard.js already makes for this shop, not a new
// approximation invented here), so a since-changed price isn't reflected
// for past months either — consistent with how the rest of the app already
// treats this limitation, not hidden or presented as more precise than it is.
function skuQtyInRange(startTs, endTs) {
  const rows = db
    .prepare(`
      SELECT oi.sku, SUM(oi.qty) AS qty
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      WHERE o.order_sn NOT LIKE 'MOCK-%' AND o.created_at >= ? AND o.created_at < ?
      GROUP BY oi.sku
    `)
    .all(startTs, endTs);
  return new Map(rows.map((r) => [r.sku, r.qty]));
}

// Joins the Shopee catalog cache (names/images/status/stock — things only
// Shopee knows) with the client's own price/HPP/barcode/stock (by SKU) —
// two separate sources of truth, joined at read time rather than merged
// into one table, since either can exist without the other. price/hpp/
// profit are null (never 0) when there's no matching entry, per the tech
// doc's rule that an unknown number must never be silently treated as
// zero. Client-requested (2026-09-28): price now comes ONLY from
// products.price (editable — see PUT /:sku/price above), never
// shopee_item_models.price, same as buildSkuPriceMap in routes/dashboard.js.
router.get('/catalog', (req, res) => {
  // Bundles are managed on the List Bundle page (client-requested 2026-10-03),
  // so they are left out of List Barang.
  const items = db.prepare('SELECT * FROM shopee_items ORDER BY name').all().filter((i) => !isBundleSku(i.item_sku));
  const models = db.prepare('SELECT * FROM shopee_item_models').all();
  const productBySku = new Map(db.prepare('SELECT sku, hpp, barcode, stock, price FROM products').all().map((p) => [p.sku, p]));

  const thisMonthStart = startOfMonthWIB(0);
  const lastMonthStart = startOfMonthWIB(1);
  const now = Math.floor(Date.now() / 1000);
  const qtyThisMonth = skuQtyInRange(thisMonthStart, now);
  const qtyLastMonth = skuQtyInRange(lastMonthStart, thisMonthStart);

  const modelsByItem = new Map();
  for (const m of models) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }

  const catalog = items.map((item) => {
    const itemModels = (modelsByItem.get(item.item_id) || []).map((m) => {
      const sku = m.model_sku || item.item_sku || `ITEM-${item.item_id}`;
      const matched = productBySku.get(sku);
      const hpp = matched?.hpp ?? null;
      const barcode = matched?.barcode ?? null;
      const dashboardStock = matched?.stock ?? null;
      const price = matched?.price ?? null;
      const profit = hpp != null && price != null ? price - hpp : null;
      const profitPct = profit != null && price ? Math.round((profit / price) * 1000) / 10 : null;
      const qtyIni = qtyThisMonth.get(sku) || 0;
      const qtyLalu = qtyLastMonth.get(sku) || 0;
      const omsetIni = price != null ? qtyIni * price : null;
      const omsetLalu = price != null ? qtyLalu * price : null;
      return {
        model_id: m.model_id,
        sku,
        name: m.model_name,
        price,
        stock: m.stock,
        dashboardStock,
        status: m.model_status,
        image: m.image_url || item.image_url || null,
        hpp,
        barcode,
        profit,
        profitPct,
        qtyIni,
        qtyLalu,
        omsetIni,
        omsetLalu,
      };
    });

    // Product-row Trend: omzet this month vs last month, summed across all
    // of the item's variants — a single trend per row, not one per variant.
    const omsetIniTotal = itemModels.reduce((sum, v) => sum + (v.omsetIni ?? 0), 0);
    const omsetLaluTotal = itemModels.reduce((sum, v) => sum + (v.omsetLalu ?? 0), 0);
    const trendPct = pctChange(omsetIniTotal, omsetLaluTotal);

    return {
      item_id: item.item_id,
      sku: item.item_sku || `ITEM-${item.item_id}`,
      name: item.name,
      status: item.item_status,
      trendPct,
      omsetIni: omsetIniTotal,
      omsetLalu: omsetLaluTotal,
      minPurchase: item.min_purchase_limit,
      image: item.image_url,
      soldOut: itemModels.length > 0 && itemModels.every((m) => (m.stock ?? 0) <= 0),
      variants: itemModels,
    };
  });

  res.json(catalog);
});

module.exports = router;
