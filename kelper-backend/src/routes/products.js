const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db');
const { syncShopeeCatalog } = require('../catalogSync');
const { startOfMonthWIB, dateStringWIB, startOfDateWIB, shiftDateStringWIB } = require('../wib');
const { getSetting } = require('../settings');
const { isBundleSku } = require('../bundleUtil');
const { withStockLog } = require('../stockLog');
const { EFFECTIVE_PRICE_SQL } = require('../tiktok/catalogSync');

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

// KELPER's own TikTok/Tokopedia stock (2026-11-10, separate per marketplace, see
// db.js tiktok_stock_dashboard).
const upsertTikTokStock = db.prepare(`
  INSERT INTO tiktok_stock_dashboard (sku, stock, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    stock = excluded.stock,
    updated_at = excluded.updated_at
`);

// Which marketplace's stock a request is about: ?platform= or body.platform,
// 'tiktok' or (default, as before) 'shopee'.
const stockPlatformOf = (req) => ((req.query.platform || req.body?.platform) === 'tiktok' ? 'tiktok' : 'shopee');

// Writes one SKU's stock for that marketplace, logged.
function setStock(platform, sku, stock, reason, ref, at) {
  if (platform === 'tiktok') withStockLog(sku, reason, ref, at, () => upsertTikTokStock.run(sku, stock, at), 'tiktok');
  else withStockLog(sku, reason, ref, at, () => upsertStock.run(sku, stock, at));
}

// Client's own manual stock count per SKU — see db.js migration comment for
// why this is a separate field from Shopee's live stock. body.platform
// 'tiktok' (2026-11-10) edits the TikTok stock instead.
router.put('/:sku/stock', (req, res) => {
  const sku = req.params.sku;
  const { stock } = req.body;
  if (stock !== null && (typeof stock !== 'number' || !Number.isInteger(stock) || stock < 0)) {
    return res.status(400).json({ error: 'invalid_stock', message: 'stock must be a non-negative integer or null.' });
  }
  const at = Math.floor(Date.now() / 1000);
  setStock(stockPlatformOf(req), sku, stock, 'manual', req.adminUsername || null, at);
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

// The single upload format for List Barang (client-requested 2026-10-12): the
// "Item Data" sheet, one row per listing --
//   SKU | Nama Item | GTIN | HPP | Harga | Item Bundle? | List Item (GTIN)
// It replaces the separate HPP and barcode uploads (those endpoints stay for
// old clients). Per row it sets HPP and the GTIN barcode (a Harga column is
// accepted but ignored since 2026-10-15: Harga follows Shopee, catalogSync.js), and for a bundle ("Item Bundle?" = Yes) the contents
// from "List Item (GTIN)": lines of "<GTIN> - <qty>". A row marked No clears
// any contents on file for that SKU, so the sheet stays the source of truth.
//
// A blank cell never overwrites what is stored (blank HPP/Harga/GTIN = leave
// as is). A row is matched by SKU; if the SKU cell is empty the item name is
// tried instead (older sheets). Anything not applied is returned by name:
//  - unknownSku: SKU that is in neither the Shopee catalog nor the products table
//  - unmatched: no SKU and the name is not a known product
//  - unreadable: HPP / Harga cell that is not a number (left unchanged)
//  - conflicts: GTIN already used by another product / SKU, or twice in the file
//  - unresolvedBundles: contents that could not be placed (bundle left unchanged)
//  - duplicateRows: the same SKU on several rows (the last one wins)
const upsertItemData = db.prepare(`
  INSERT INTO products (sku, name, hpp, price, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET
    name = COALESCE(excluded.name, products.name),
    hpp = COALESCE(excluded.hpp, products.hpp),
    price = COALESCE(excluded.price, products.price),
    updated_at = excluded.updated_at
`);

// The SKUs a TikTok stock upload may set (2026-11-10): TikTok's own catalog,
// plus any SKU that already has a TikTok stock or a products row.
function knownTikTokSkus() {
  const set = new Set(db.prepare('SELECT sku FROM products').all().map((p) => p.sku));
  for (const r of db.prepare('SELECT seller_sku FROM tiktok_catalog WHERE seller_sku IS NOT NULL').all()) set.add(r.seller_sku);
  for (const r of db.prepare('SELECT sku FROM tiktok_stock_dashboard').all()) set.add(r.sku);
  return set;
}

function knownSkus() {
  const set = new Set(db.prepare('SELECT sku FROM products').all().map((p) => p.sku));
  const modelsByItem = new Map();
  for (const m of db.prepare('SELECT item_id, model_sku FROM shopee_item_models').all()) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }
  for (const item of db.prepare('SELECT item_id, item_sku FROM shopee_items').all()) {
    if (item.item_sku) set.add(item.item_sku);
    for (const m of modelsByItem.get(item.item_id) || []) if (m.model_sku) set.add(m.model_sku);
  }
  return set;
}

// "8994450940004 - 1,\n8994450940097 - 1" -> [{ ref, qty }, ...]; null on a line it cannot read.
function parseBundleList(text) {
  const out = [];
  for (const piece of String(text || '').split(/[\n;,]+/).map((x) => x.trim()).filter(Boolean)) {
    let m = piece.match(/^(.+?)\s+[-xX\u00d7:]\s+(\d+)$/) || piece.match(/^(\d{8,14})\s*[xX\u00d7]\s*(\d+)$/);
    if (m) { out.push({ ref: m[1].trim(), qty: Number(m[2]) }); continue; }
    if (/^\S+$/.test(piece)) { out.push({ ref: piece, qty: 1 }); continue; }
    return null;
  }
  return out;
}

router.post('/import-item-data', upload.single('file'), async (req, res) => {
  const sheet = await loadSheet(req, res);
  if (!sheet) return;

  const skuCol = findColumn(sheet, 1, /^sku$/i);
  const nameCol = findColumn(sheet, 1, /^nama/i);
  if (!skuCol && !nameCol) {
    return res.status(400).json({ error: 'columns_missing', message: 'Kolom "SKU" / "Nama Item" tidak ditemukan di baris pertama. Pakai format Item Data.' });
  }
  const gtinCol = findColumn(sheet, 1, /^gtin$/i);
  const hppCol = findColumn(sheet, 1, /^hpp/i);
  const bundleCol = findColumn(sheet, 1, /bundle/i);
  const listCol = findColumn(sheet, 1, /list\s*item/i);

  // ?platform=tiktok (2026-11-12, List Barang TikTok): TikTok's SKUs are accepted too.
  const known = stockPlatformOf(req) === 'tiktok' ? knownTikTokSkus() : knownSkus();
  const nameToSku = buildNameToSku();
  const now = Math.floor(Date.now() / 1000);
  const unknownSku = [];
  const unmatched = [];
  const unreadable = [];
  const conflicts = [];
  const unresolvedBundles = [];
  const duplicateRows = [];

  // ---- read the rows
  const bySku = new Map();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = nameCol ? cellText(row.getCell(nameCol)) : '';
    let sku = skuCol ? cellText(row.getCell(skuCol)) : '';
    if (!sku && !name) return; // blank row
    const label = name || sku;
    if (!sku) {
      sku = nameToSku.get(normalizeName(name)) || '';
      if (!sku) { unmatched.push(label); return; }
    } else if (!known.has(sku)) {
      unknownSku.push(`${sku}${name ? ' (' + name + ')' : ''}`);
      return;
    }

    const readMoney = (col) => {
      if (!col) return null;
      const raw = cellValue(row.getCell(col));
      if (raw == null || String(raw).trim() === '' || String(raw).trim() === '-') return null;
      const v = parseRupiah(raw);
      if (v == null) unreadable.push(`${label} (${cellText(row.getCell(col))})`);
      return v;
    };
    let gtin = gtinCol ? cellText(row.getCell(gtinCol)) : '';
    if (gtin === '-') gtin = '';
    if (bySku.has(sku)) duplicateRows.push(sku);
    bySku.set(sku, {
      sku, name: name || null, label,
      hpp: readMoney(hppCol), price: null, gtin, // Harga comes from Shopee since 2026-10-15 (catalogSync.js): the file's Harga column is ignored
      isBundle: bundleCol ? /^\s*(y|ya|yes|true|1)\b/i.test(cellText(row.getCell(bundleCol))) : false,
      listText: listCol ? cellText(row.getCell(listCol)) : '',
    });
  });

  const rows = [...bySku.values()];
  let barcodesSet = 0;
  let bundlesSet = 0;
  let bundlesCleared = 0;

  const apply = db.transaction(() => {
    // ---- product fields
    for (const r of rows) upsertItemData.run(r.sku, r.name, r.hpp, r.price, now);

    // ---- barcodes (single products only; a bundle has none of its own)
    const gtinToSku = new Map();
    const seen = new Map();
    for (const r of rows) {
      if (r.isBundle || !r.gtin) continue;
      if (!BARCODE_PATTERN.test(r.gtin)) { conflicts.push(`${r.gtin} (${r.sku}) bukan barcode yang valid`); continue; }
      if (seen.has(r.gtin) && seen.get(r.gtin) !== r.sku) { conflicts.push(`${r.gtin} dipakai ${seen.get(r.gtin)} dan ${r.sku} di file`); continue; }
      seen.set(r.gtin, r.sku);
      const other = db.prepare('SELECT sku FROM products WHERE barcode = ? AND sku != ?').get(r.gtin, r.sku);
      const sameAsSku = db.prepare('SELECT sku FROM products WHERE sku = ? AND sku != ?').get(r.gtin, r.sku);
      if (other || sameAsSku) { conflicts.push(`${r.gtin} (${r.sku}) sudah dipakai ${(other || sameAsSku).sku}`); continue; }
      upsertBarcode.run(r.sku, r.gtin, now);
      gtinToSku.set(r.gtin, r.sku);
      barcodesSet += 1;
    }

    // ---- bundle contents
    for (const r of rows) {
      if (!r.isBundle) {
        const had = db.prepare('DELETE FROM bundle_items WHERE bundle_sku = ?').run(r.sku).changes;
        if (had > 0) bundlesCleared += 1;
        continue;
      }
      const parsed = parseBundleList(r.listText);
      if (!parsed || parsed.length === 0) {
        unresolvedBundles.push(`${r.label}: kolom List Item (GTIN) kosong / tidak terbaca`);
        continue;
      }
      const items = [];
      let failed = null;
      for (const p of parsed) {
        const sku = gtinToSku.get(p.ref) || db.prepare('SELECT sku FROM products WHERE barcode = ?').get(p.ref)?.sku || (known.has(p.ref) ? p.ref : null);
        if (!sku || sku === r.sku || !(p.qty >= 1)) { failed = p.ref; break; }
        const existing = items.find((i) => i.sku === sku);
        if (existing) existing.qty += p.qty; else items.push({ sku, qty: p.qty });
      }
      if (failed) {
        unresolvedBundles.push(`${r.label}: isi "${failed}" bukan barcode/SKU produk mana pun`);
        continue;
      }
      db.prepare('DELETE FROM bundle_items WHERE bundle_sku = ?').run(r.sku);
      for (const it of items) db.prepare('INSERT INTO bundle_items (bundle_sku, component_sku, qty) VALUES (?, ?, ?)').run(r.sku, it.sku, it.qty);
      bundlesSet += 1;
    }
  });
  apply();

  res.json({
    ok: true, imported: rows.length, hppSet: rows.filter((r) => r.hpp != null).length, priceSet: rows.filter((r) => r.price != null).length,
    barcodesSet, bundlesSet, bundlesCleared, unknownSku, unmatched, unreadable, conflicts, unresolvedBundles, duplicateRows,
  });
});

// Bulk version of the stock edit above, from the client's "Item Stok" sheet
// (client-requested 2026-10-12): SKU | Stok. Matched by SKU; a SKU that is in
// neither the Shopee catalog nor the products table is reported (unknownSku) and
// skipped, the same rule as the Item Data upload. This replaced the older daily
// sheet that was matched by listing name (DESCRIPSI | STOK AKHIR).
// A blank Stock cell is skipped silently, not reported -- the "Unduh Template
// Stok" download (see /stock-template) lists every SKU, and the expected use
// is filling in only the ones that changed and leaving the rest blank
// (client-requested 2026-10-17); a blank row is no longer an exceptional
// case. A stock that IS filled in but negative or not a number is still
// reported as unreadable, never written as 0 -- an unknown count must not
// read as sold out. A real 0 is written.
router.post('/import-stock', upload.single('file'), async (req, res) => {
  const sheet = await loadSheet(req, res);
  if (!sheet) return;

  const skuColumn = findColumn(sheet, 1, /^sku$/i);
  // "Stok Total" is the header of the Unduh Template Stok file (2026-10-17).
  const stokColumn = findColumn(sheet, 1, /^(stok|stock)( total)?$/i);
  if (!skuColumn || !stokColumn) {
    return res.status(400).json({
      error: 'stock_column_missing',
      message: 'Kolom "SKU" dan "Stok" tidak ditemukan di baris pertama sheet pertama. Pakai format Item Stok (SKU, Stok).',
    });
  }

  const platform = stockPlatformOf(req);
  const known = platform === 'tiktok' ? knownTikTokSkus() : knownSkus();
  const nowTs = Math.floor(Date.now() / 1000);
  const bySku = new Map();
  const unknownSku = [];
  const unreadable = [];
  const duplicateRows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const sku = cellText(row.getCell(skuColumn));
    if (!sku) return;
    if (!known.has(sku)) { unknownSku.push(sku); return; }
    const raw = cellValue(row.getCell(stokColumn));
    if (raw === null || String(raw).trim() === '') return; // intentionally left blank -- no change for this SKU
    const stock = Number(raw);
    if (!Number.isFinite(stock) || stock < 0) { unreadable.push(`${sku} (${cellText(row.getCell(stokColumn))})`); return; }
    if (bySku.has(sku)) duplicateRows.push(sku);
    bySku.set(sku, Math.round(stock));
  });
  db.transaction(() => {
    for (const [sku, stock] of bySku) setStock(platform, sku, stock, 'upload', req.adminUsername || null, nowTs);
  })();
  res.json({ ok: true, imported: bySku.size, unknownSku, unmatched: [], unreadable, duplicateRows });
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

// PUT /:sku/price (a hand-entered Harga) is gone since 2026-10-15: Harga follows
// Shopee, copied in by every catalog sync (catalogSync.js).

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

// The Refresh button in List Barang: the same catalog sync the server also runs
// by itself every hour (catalogSync.js), which also brings Harga up to date.
router.post('/sync-shopee', async (req, res) => {
  const shopId = Number(req.body.shop_id || req.query.shop_id);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  try {
    const { items, models } = await syncShopeeCatalog(shopId);
    res.json({ ok: true, items, models });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: err.message });
  }
});

// Item Bundle? and List Item (GTIN) cells for one SKU in a download, written the
// way /import-item-data reads them, so a downloaded list can be edited and
// uploaded again as Item Data without losing bundle contents (2026-11-12).
// A part is named by its barcode, or by its SKU when it has none.
function bundleExportCells() {
  const barcodeBySku = new Map(db.prepare('SELECT sku, barcode FROM products').all().map((p) => [p.sku, p.barcode]));
  const partsByBundle = new Map();
  for (const r of db.prepare('SELECT bundle_sku, component_sku, qty FROM bundle_items ORDER BY rowid').all()) {
    if (!partsByBundle.has(r.bundle_sku)) partsByBundle.set(r.bundle_sku, []);
    partsByBundle.get(r.bundle_sku).push(`${barcodeBySku.get(r.component_sku) || r.component_sku} - ${r.qty}`);
  }
  return (sku) => {
    const parts = partsByBundle.get(sku);
    return parts || isBundleSku(sku) ? ['Ya', (parts || []).join('\n') || null] : ['Tidak', null];
  };
}

// Unduh Daftar Item on List Barang TikTok (2026-11-12): one row per TikTok SKU
// from the TikTok catalog cache, same idea as the Shopee export above.
async function exportTikTokItems(res) {
  const productBySku = new Map(db.prepare('SELECT sku, hpp, barcode FROM products').all().map((p) => [p.sku, p]));
  const stockBySku = new Map(db.prepare('SELECT sku, stock FROM tiktok_stock_dashboard').all().map((r) => [r.sku, r.stock]));
  const bundleCells = bundleExportCells();
  const rows = db.prepare(`SELECT *, ${EFFECTIVE_PRICE_SQL()} AS sell_price FROM tiktok_catalog WHERE COALESCE(status, '') != 'DELETED'`).all()
    .map((r) => ({ ...r, sku: r.seller_sku || `TT-${r.sku_id}` }))
    .sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Item TikTok');
  ws.columns = [
    { header: 'Product ID', width: 22 }, { header: 'SKU ID', width: 22 }, { header: 'SKU', width: 26 },
    { header: 'Nama Item', width: 70 }, { header: 'Variasi', width: 28 }, { header: 'Status', width: 12 },
    { header: 'Stok TikTok', width: 13 }, { header: 'Stok Dashboard TikTok', width: 20 }, { header: 'Harga TikTok', width: 14 }, { header: 'Harga Normal TikTok', width: 18 },
    { header: 'GTIN', width: 20 }, { header: 'HPP', width: 15 }, { header: 'Item Bundle?', width: 13 },
    { header: 'List Item (GTIN)', width: 30 }, { header: 'Catatan', width: 26 },
  ];
  for (const r of rows) {
    const p = r.seller_sku ? productBySku.get(r.seller_sku) : null;
    ws.addRow([
      r.product_id, r.sku_id, r.sku, r.product_name, r.sku_name, r.status,
      r.tiktok_stock, r.seller_sku ? stockBySku.get(r.seller_sku) ?? null : null, r.sell_price, r.price,
      p?.barcode ?? null, p?.hpp ?? null, ...bundleCells(r.sku),
      r.seller_sku ? '' : 'Belum ada Seller SKU di TikTok',
    ]);
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const col of [1, 2, 11]) ws.getColumn(col).numFmt = '@'; // IDs and barcodes as text: keeps leading zeros
  ws.getColumn(14).alignment = { wrapText: true };
  for (const col of [9, 10, 12]) ws.getColumn(col).numFmt = '[$Rp]#,##0';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="item-tiktok.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}

// Item list with SKUs as an Excel file (client-requested 2026-10-12): one row per
// Shopee variant (an item without variants is one row), straight from the
// catalog cache that sync-shopee fills -- press the sync button first for live
// data. The SKU columns show where the SKU actually comes from, because KELPER
// uses the variant's SKU, else the item's, else "ITEM-<id>" when the seller never
// typed one into Shopee (those are the rows to fix in Seller Centre).
router.get('/export-items', async (req, res) => {
  if (stockPlatformOf(req) === 'tiktok') return exportTikTokItems(res);
  const items = db.prepare('SELECT * FROM shopee_items').all();
  const modelsByItem = new Map();
  for (const m of db.prepare('SELECT * FROM shopee_item_models ORDER BY model_id').all()) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }
  const productBySku = new Map(db.prepare('SELECT sku, hpp, barcode FROM products').all().map((p) => [p.sku, p]));
  const bundleCells = bundleExportCells();

  const rows = [];
  for (const item of items) {
    for (const m of modelsByItem.get(item.item_id) || []) {
      const sku = m.model_sku || item.item_sku || `ITEM-${item.item_id}`;
      const p = productBySku.get(sku);
      rows.push({
        sku,
        values: [
          item.item_id, m.model_id || null, sku, item.item_sku || null, m.model_sku || null,
          item.name, m.model_id ? m.model_name : null, m.model_status || item.item_status,
          m.stock, m.price, p?.barcode ?? null, p?.hpp ?? null, ...bundleCells(sku),
          m.model_sku || item.item_sku ? '' : 'Belum ada SKU di Shopee',
        ],
      });
    }
  }
  rows.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Item Shopee');
  ws.columns = [
    { header: 'Item ID', width: 16 }, { header: 'Model ID', width: 16 }, { header: 'SKU', width: 26 },
    { header: 'SKU Induk', width: 22 }, { header: 'SKU Variasi', width: 22 }, { header: 'Nama Item', width: 70 },
    { header: 'Variasi', width: 28 }, { header: 'Status', width: 12 }, { header: 'Stok Shopee', width: 13 },
    { header: 'Harga Shopee', width: 14 }, { header: 'GTIN', width: 20 }, { header: 'HPP', width: 15 },
    { header: 'Item Bundle?', width: 13 }, { header: 'List Item (GTIN)', width: 30 }, { header: 'Catatan', width: 26 },
  ];
  for (const r of rows) ws.addRow(r.values);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // Headers match /import-item-data (SKU, Nama Item, GTIN, HPP, Item Bundle?, List
  // Item (GTIN)) so this file can be edited and uploaded back as Item Data.
  for (const col of [1, 2]) ws.getColumn(col).numFmt = '0';
  ws.getColumn(11).numFmt = '@'; // barcodes as text: keeps leading zeros
  ws.getColumn(14).alignment = { wrapText: true };
  for (const col of [10, 12]) ws.getColumn(col).numFmt = '[$Rp]#,##0';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="item-shopee.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// Stock Opname's "Unduh Template Stok" (client-requested 2026-10-17): every
// SKU currently in the Shopee catalog cache, SKU | Name | Stock, Stock left
// blank to fill in and re-upload via /products/import-stock (which reads
// only SKU and Stock -- Name is for reference, ignored on upload; a blank
// Stock cell is skipped there, not an error, so leaving most rows untouched
// and filling in only what changed is the expected use). Built live from
// shopee_items/shopee_item_models on every request, same join /export-items
// uses -- not a static file, so a SKU added by the next catalog sync shows
// up the next time this is downloaded, with no template to maintain by hand.
router.get('/stock-template', async (req, res) => {
  const rows = [];
  if (stockPlatformOf(req) === 'tiktok') {
    // TikTok's own catalog (2026-11-10), one row per seller SKU.
    const seen = new Set();
    for (const r of db.prepare("SELECT seller_sku, product_name, sku_name FROM tiktok_catalog WHERE seller_sku IS NOT NULL AND COALESCE(status, '') != 'DELETED'").all()) {
      if (seen.has(r.seller_sku)) continue;
      seen.add(r.seller_sku);
      rows.push({ sku: r.seller_sku, name: r.sku_name ? `${r.product_name} - ${r.sku_name}` : r.product_name });
    }
  } else {
    const items = db.prepare('SELECT * FROM shopee_items').all();
    const modelsByItem = new Map();
    for (const m of db.prepare('SELECT * FROM shopee_item_models ORDER BY model_id').all()) {
      if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
      modelsByItem.get(m.item_id).push(m);
    }
    for (const item of items) {
      for (const m of modelsByItem.get(item.item_id) || []) {
        const sku = m.model_sku || item.item_sku || `ITEM-${item.item_id}`;
        const name = m.model_name && m.model_name !== item.name ? `${item.name} - ${m.model_name}` : item.name;
        rows.push({ sku, name });
      }
    }
  }
  rows.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Item Stok');
  ws.columns = [
    { header: 'SKU', width: 18 },
    { header: 'Name', width: 60 },
    // The number filled in REPLACES the stock (it is the new total, not what came in):
    // header and note say so, since "Stock" alone read as "amount to add".
    { header: 'Stok Total', width: 12 },
  ];
  for (const r of rows) ws.addRow([r.sku, r.name, null]);
  ws.getRow(1).font = { bold: true };
  ws.getCell('C1').note = 'Isi stok TOTAL sekarang (bukan jumlah yang masuk). Contoh: stok 94, datang 41 -> isi 135. Kosongkan = tidak diubah.';
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="item-stok-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
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
// platform (2026-11-12): each List Barang counts its own marketplace's sales
// only ('shopee', or 'tiktok' = TikTok + Tokopedia), since stock and price are
// separate per marketplace.
function skuQtyInRange(startTs, endTs, platform = 'shopee') {
  const rows = db
    .prepare(`
      SELECT oi.sku, SUM(oi.qty) AS qty
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      WHERE o.order_sn NOT LIKE 'MOCK-%' AND o.created_at >= ? AND o.created_at < ?
        AND ${platform === 'tiktok' ? "o.platform != 'shopee'" : "COALESCE(o.platform, 'shopee') = 'shopee'"}
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
  // Bundles ARE listed here (the 2026-10-03 "leave them out" was reverted
  // 2026-10-07): each carries isBundle so the page can tag it as a bundle; what
  // is inside a bundle is edited in its expanded row (PUT /bundles/:sku/items).
  // Sorted by SKU in natural order (KEL-2 before KEL-10, not after it), the
  // way the client numbers its products (client-requested 2026-10-03).
  const skuOf = (i) => i.item_sku || `ITEM-${i.item_id}`;
  const items = db
    .prepare('SELECT * FROM shopee_items')
    .all()
    .sort((a, b) => skuOf(a).localeCompare(skuOf(b), undefined, { numeric: true, sensitivity: 'base' }));
  const models = db.prepare('SELECT * FROM shopee_item_models').all();
  const productBySku = new Map(db.prepare('SELECT sku, name, hpp, barcode, stock, price FROM products').all().map((p) => [p.sku, p]));

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

  // Bundle contents, with each component's name and barcode (a single-variant
  // listing is named by its SKU, same rule as the editor's component picker).
  const listingNameBySku = new Map();
  for (const item of items) {
    const ms = modelsByItem.get(item.item_id) || [];
    if (ms.length <= 1) listingNameBySku.set(ms[0]?.model_sku || item.item_sku || `ITEM-${item.item_id}`, item.name);
  }
  const contentsByBundle = new Map();
  for (const r of db.prepare('SELECT bundle_sku, component_sku, qty FROM bundle_items ORDER BY rowid').all()) {
    if (!contentsByBundle.has(r.bundle_sku)) contentsByBundle.set(r.bundle_sku, []);
    contentsByBundle.get(r.bundle_sku).push({
      sku: r.component_sku,
      qty: r.qty,
      name: listingNameBySku.get(r.component_sku) || productBySku.get(r.component_sku)?.name || null,
      barcode: productBySku.get(r.component_sku)?.barcode ?? null,
    });
  }

  // "HABIS" follows OUR stock (the Stok the client enters / uploads), never Shopee's
  // own number (client-requested 2026-10-12). A bundle is a product like any other
  // here: it has its own stock, and selling it takes down only that (see
  // confirmOrderPickedUp), so its parts do not matter. An unknown stock (never
  // entered) is not sold out.
  function isSoldOut(item, itemModels) {
    return itemModels.length > 0 && itemModels.every((v) => v.dashboardStock != null && v.dashboardStock <= 0);
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
      isBundle: isBundleSku(item.item_sku),
      bundleItems: contentsByBundle.get(item.item_sku) || [],
      trendPct,
      omsetIni: omsetIniTotal,
      omsetLalu: omsetLaluTotal,
      image: item.image_url,
      soldOut: isSoldOut(item, itemModels),
      variants: itemModels,
    };
  });

  res.json(catalog);
});

// Client-requested (2026-10-04): the stock-only view for a Packing Station
// admin (the 'packing' role sees List Barang with stock and nothing else --
// see adminSession.js's PACKING_ROLE_ALLOWED). Deliberately its own endpoint
// instead of a filtered /catalog: this response never contains HPP, Harga,
// barcode, profit or sales figures at all, so that login cannot read them
// however it asks. Same listing rules as /catalog (bundles included and
// flagged isBundle, natural SKU order, model-then-item image).
router.get('/stock-list', (req, res) => {
  const skuOf = (i) => i.item_sku || `ITEM-${i.item_id}`;
  const items = db
    .prepare('SELECT item_id, item_sku, name, item_status, image_url FROM shopee_items')
    .all()
    .sort((a, b) => skuOf(a).localeCompare(skuOf(b), undefined, { numeric: true, sensitivity: 'base' }));
  const stockBySku = new Map(db.prepare('SELECT sku, stock FROM products').all().map((p) => [p.sku, p.stock]));

  const modelsByItem = new Map();
  for (const m of db.prepare('SELECT item_id, model_id, model_sku, model_name, stock, image_url FROM shopee_item_models').all()) {
    if (!modelsByItem.has(m.item_id)) modelsByItem.set(m.item_id, []);
    modelsByItem.get(m.item_id).push(m);
  }

  res.json(
    items.map((item) => ({
      item_id: item.item_id,
      sku: skuOf(item),
      name: item.name,
      status: item.item_status,
      isBundle: isBundleSku(item.item_sku),
      image: item.image_url,
      variants: (modelsByItem.get(item.item_id) || []).map((m) => {
        const sku = m.model_sku || item.item_sku || `ITEM-${item.item_id}`;
        return {
          model_id: m.model_id,
          sku,
          name: m.model_name,
          image: m.image_url || item.image_url || null,
          shopeeStock: m.stock,
          dashboardStock: stockBySku.get(sku) ?? null,
        };
      }),
    }))
  );
});

// List Barang TikTok (2026-11-10, client-requested: a separate list per
// marketplace). TikTok's own catalog (src/tiktok/catalogSync.js), shaped like
// /stock-list so the same page shows it: products with their SKUs, TikTok's
// stock (marketplaceStock) and KELPER's own TikTok stock (dashboardStock).
// Harga (TikTok's price) and the shared HPP are included for a full admin only;
// the Packing Station admin role gets stock and nothing else, as on /stock-list.
router.get('/tiktok-stock-list', (req, res) => {
  const withPrices = req.adminRole !== 'packing';
  const rows = db.prepare(`
    SELECT c.*, ${EFFECTIVE_PRICE_SQL('c.')} AS sell_price, d.stock AS dashboard_stock, p.hpp
    FROM tiktok_catalog c
    LEFT JOIN tiktok_stock_dashboard d ON d.sku = c.seller_sku
    LEFT JOIN products p ON p.sku = c.seller_sku
    WHERE COALESCE(c.status, '') != 'DELETED'
  `).all();
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) {
      byProduct.set(r.product_id, {
        item_id: r.product_id,
        sku: r.seller_sku || `TT-${r.sku_id}`,
        name: r.product_name,
        // Same filter values as Shopee's list: NORMAL = on sale.
        status: r.status === 'ACTIVATE' ? 'NORMAL' : r.status || 'UNKNOWN',
        isBundle: false,
        image: r.image_url,
        variants: [],
      });
    }
    const sku = r.seller_sku || `TT-${r.sku_id}`;
    byProduct.get(r.product_id).variants.push({
      model_id: r.sku_id,
      sku,
      hasSellerSku: !!r.seller_sku,
      name: r.sku_name,
      image: r.image_url,
      marketplaceStock: r.tiktok_stock,
      dashboardStock: r.dashboard_stock ?? null,
      ...(withPrices ? { price: r.sell_price, hpp: r.hpp ?? null } : {}),
    });
  }
  res.json([...byProduct.values()].sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' })));
});

// List Barang TikTok for a full admin (2026-11-12, client: "same as List Barang
// Shopee"): the same shape as /catalog, from TikTok's catalog. Harga is TikTok's
// own price; Stok is KELPER's TikTok stock (tiktok_stock_dashboard); HPP, barcode
// and bundle contents are shared with Shopee (one products row per SKU); sales
// are TikTok + Tokopedia orders only. The Packing Station admin role never gets
// here (not in PACKING_ROLE_ALLOWED) and keeps /tiktok-stock-list.
router.get('/tiktok-catalog', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, ${EFFECTIVE_PRICE_SQL('c.')} AS sell_price, d.stock AS dashboard_stock
    FROM tiktok_catalog c
    LEFT JOIN tiktok_stock_dashboard d ON d.sku = c.seller_sku
    WHERE COALESCE(c.status, '') != 'DELETED'
  `).all();
  const productBySku = new Map(db.prepare('SELECT sku, name, hpp, barcode FROM products').all().map((p) => [p.sku, p]));

  const thisMonthStart = startOfMonthWIB(0);
  const lastMonthStart = startOfMonthWIB(1);
  const now = Math.floor(Date.now() / 1000);
  const qtyThisMonth = skuQtyInRange(thisMonthStart, now, 'tiktok');
  const qtyLastMonth = skuQtyInRange(lastMonthStart, thisMonthStart, 'tiktok');

  const contentsByBundle = new Map();
  for (const r of db.prepare('SELECT bundle_sku, component_sku, qty FROM bundle_items ORDER BY rowid').all()) {
    if (!contentsByBundle.has(r.bundle_sku)) contentsByBundle.set(r.bundle_sku, []);
    contentsByBundle.get(r.bundle_sku).push({
      sku: r.component_sku,
      qty: r.qty,
      name: productBySku.get(r.component_sku)?.name || null,
      barcode: productBySku.get(r.component_sku)?.barcode ?? null,
    });
  }

  const byProduct = new Map();
  for (const r of rows) {
    const sku = r.seller_sku || `TT-${r.sku_id}`;
    if (!byProduct.has(r.product_id)) {
      byProduct.set(r.product_id, {
        item_id: r.product_id,
        sku, // the product row shows its first SKU, like a Shopee item without a parent SKU
        name: r.product_name,
        status: r.status === 'ACTIVATE' ? 'NORMAL' : r.status || 'UNKNOWN',
        image: r.image_url,
        variants: [],
      });
    }
    const matched = r.seller_sku ? productBySku.get(r.seller_sku) : null;
    const hpp = matched?.hpp ?? null;
    // Harga = the price after an ongoing TikTok promotion (2026-11-12), like
    // Shopee's current_price; normalPrice is the price before it.
    const price = r.sell_price ?? null;
    const profit = hpp != null && price != null ? price - hpp : null;
    const profitPct = profit != null && price ? Math.round((profit / price) * 1000) / 10 : null;
    const qtyIni = qtyThisMonth.get(sku) || 0;
    const qtyLalu = qtyLastMonth.get(sku) || 0;
    byProduct.get(r.product_id).variants.push({
      model_id: r.sku_id,
      sku,
      hasSellerSku: !!r.seller_sku,
      name: r.sku_name,
      price,
      normalPrice: price != null && r.price != null && price < r.price ? r.price : null,
      stock: r.tiktok_stock,
      dashboardStock: r.dashboard_stock ?? null,
      image: r.image_url,
      hpp,
      barcode: matched?.barcode ?? null,
      profit,
      profitPct,
      qtyIni,
      qtyLalu,
      omsetIni: price != null ? qtyIni * price : null,
      omsetLalu: price != null ? qtyLalu * price : null,
    });
  }

  const catalog = [...byProduct.values()].map((p) => {
    const omsetIni = p.variants.reduce((t, v) => t + (v.omsetIni ?? 0), 0);
    const omsetLalu = p.variants.reduce((t, v) => t + (v.omsetLalu ?? 0), 0);
    const single = p.variants.length === 1 ? p.variants[0].sku : null;
    return {
      ...p,
      isBundle: !!single && isBundleSku(single),
      bundleItems: (single && contentsByBundle.get(single)) || [],
      trendPct: pctChange(omsetIni, omsetLalu),
      omsetIni,
      omsetLalu,
      soldOut: p.variants.length > 0 && p.variants.every((v) => v.dashboardStock != null && v.dashboardStock <= 0),
    };
  });
  res.json(catalog.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' })));
});

// The Refresh button in List Barang TikTok: the hourly TikTok catalog sync, now,
// for every connected TikTok shop.
router.post('/sync-tiktok', async (req, res) => {
  const { getTikTokOpts } = require('../tiktok/orderSync');
  const { syncTikTokCatalog } = require('../tiktok/catalogSync');
  const shops = db.prepare('SELECT shop_id FROM tiktok_shops').all();
  if (shops.length === 0) return res.status(400).json({ error: 'no_tiktok_shop', message: 'Belum ada toko TikTok yang terhubung.' });
  try {
    for (const { shop_id: shopId } of shops) {
      await syncTikTokCatalog(await getTikTokOpts(shopId), shopId, { force: true });
    }
    res.json({ ok: true, shops: shops.length });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: err.message });
  }
});

// Stock Opname (client-requested 2026-10-16): per SKU, over a WIB date range
// (?start=&end=, YYYY-MM-DD, inclusive): Stok Awal, Masuk, Keluar, Stok Akhir,
// from stock_log (see stockLog.js).
//  - Stok Akhir = today's stock minus every logged change after the range.
//  - Masuk = logged increases in the range; Keluar = logged decreases.
//  - Stok Awal = Akhir - Masuk + Keluar.
// Before stockLogStartedAt nothing was logged: for that part Keluar comes from
// sales history (picked-up orders) and Masuk is ASSUMED 0 (client-decided
// 2026-10-16) -- an Item Stok upload back then just overwrote the number, so
// what came in is unknowable. Any figure that leans on that assumption is
// flagged (estimate: true; the page marks it "estimasi"). Exact if no stock
// was uploaded or edited by hand in that time.
// ?platform=tiktok (2026-11-10): the TikTok stock (tiktok_stock_dashboard) and
// TikTok/Tokopedia sales instead; that log began when the TikTok stock was
// added, so it has no pre-log estimate. Default (shopee): unchanged, except that
// TikTok's own log rows and sales are left out.
router.get('/stock-opname', (req, res) => {
  const platform = stockPlatformOf(req);
  const isTikTok = platform === 'tiktok';
  const today = dateStringWIB(0);
  let start = req.query.start || shiftDateStringWIB(today, -1);
  let end = req.query.end || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'invalid_date', message: 'start/end must be YYYY-MM-DD' });
  }
  if (start > end) [start, end] = [end, start];
  const rangeStart = startOfDateWIB(start);
  const rangeEnd = startOfDateWIB(shiftDateStringWIB(end, 1));
  const logStart = Number(getSetting(isTikTok ? 'tiktokStockLogStartedAt' : 'stockLogStartedAt', '0'));
  const estimate = rangeStart < logStart; // the range reaches back before recording began

  const logged = new Map(
    db.prepare(`
      SELECT sku,
             SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) AS masuk,
             SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS keluar
      FROM stock_log WHERE created_at >= ? AND created_at < ? AND platform = ? GROUP BY sku
    `).all(Math.max(rangeStart, logStart), rangeEnd, platform).map((r) => [r.sku, r])
  );
  // Picked-up quantity per SKU in [from, to): what a pickup took off, for the
  // time before the log.
  const salesBetween = (from, to) => (from < to
    ? new Map(
        db.prepare(`
          SELECT oi.sku, SUM(oi.qty) AS qty
          FROM order_items oi
          JOIN orders o ON o.order_sn = oi.order_sn
          JOIN (SELECT order_sn, MAX(completed_at) AS completed_at FROM packing_sessions WHERE status = 'DONE' GROUP BY order_sn) ps
            ON ps.order_sn = o.order_sn
          WHERE o.order_sn NOT LIKE 'MOCK-%' AND ps.completed_at >= ? AND ps.completed_at < ?
            AND (o.platform = 'shopee') = ?
          GROUP BY oi.sku
        `).all(from, to, isTikTok ? 0 : 1).map((r) => [r.sku, r.qty])
      )
    : new Map());
  const salesBeforeLog = salesBetween(rangeStart, Math.min(rangeEnd, logStart));
  // Stock now, walked back to the end of the range: undo every change after it --
  // the logged ones, and (before the log) the sales, with nothing assumed to have come in.
  const changedAfter = new Map(
    db.prepare('SELECT sku, SUM(delta) AS delta FROM stock_log WHERE created_at >= ? AND platform = ? GROUP BY sku').all(Math.max(rangeEnd, logStart), platform).map((r) => [r.sku, r.delta])
  );
  const soldAfterBeforeLog = salesBetween(rangeEnd, logStart);

  // Names: our own product name, else Shopee's listing (+ variant) name.
  const shopeeName = new Map();
  for (const m of db.prepare(`
    SELECT COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku, i.name AS item_name, m.model_name
    FROM shopee_item_models m JOIN shopee_items i ON i.item_id = m.item_id
  `).all()) {
    shopeeName.set(m.sku, m.model_name && m.model_name !== m.item_name ? `${m.item_name} - ${m.model_name}` : m.item_name);
  }
  if (isTikTok) {
    for (const r of db.prepare('SELECT seller_sku, product_name, sku_name FROM tiktok_catalog WHERE seller_sku IS NOT NULL').all()) {
      shopeeName.set(r.seller_sku, r.sku_name ? `${r.product_name} - ${r.sku_name}` : r.product_name);
    }
  }
  const products = isTikTok
    ? new Map(db.prepare('SELECT t.sku, p.name, t.stock FROM tiktok_stock_dashboard t LEFT JOIN products p ON p.sku = t.sku').all().map((p) => [p.sku, p]))
    : new Map(db.prepare('SELECT sku, name, stock FROM products').all().map((p) => [p.sku, p]));

  // Every SKU with a stock on file, plus any that moved in the range.
  const skus = new Set([...products.values()].filter((p) => p.stock != null).map((p) => p.sku));
  for (const sku of logged.keys()) skus.add(sku);
  for (const sku of salesBeforeLog.keys()) skus.add(sku);
  for (const sku of soldAfterBeforeLog.keys()) skus.add(sku);

  const rows = [...skus]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((sku) => {
      const p = products.get(sku);
      const current = p?.stock ?? null;
      const log = logged.get(sku);
      const keluar = (log?.keluar ?? 0) + (salesBeforeLog.get(sku) ?? 0);
      const masuk = log?.masuk ?? 0;
      const akhir = current != null ? current - (changedAfter.get(sku) ?? 0) + (soldAfterBeforeLog.get(sku) ?? 0) : null;
      const awal = akhir != null ? akhir - masuk + keluar : null;
      return { sku, name: p?.name || shopeeName.get(sku) || null, awal, masuk, keluar, akhir };
    });

  res.json({ platform, start, end, logStartedAt: logStart || null, estimate, rows });
});

module.exports = router;
