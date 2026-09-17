const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db');
const { getValidAccessToken } = require('../shopee/tokenStore');
const { getItemList, getItemBaseInfo, getModelList } = require('../shopee/client');

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

// Client's cost-tracking sheet has a fixed column order: Nama | SKU | Modal |
// Barcode. "Modal" is HPP (cost price). Row 1 is always the header.
router.post('/import-hpp', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required', message: 'No file was uploaded.' });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'invalid_file', message: 'Could not read this as an Excel (.xlsx) file.' });
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return res.status(400).json({ error: 'empty_file', message: 'The file has no sheets.' });

  const now = Math.floor(Date.now() / 1000);
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

  res.json({ ok: true, imported, skippedRows });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT sku, name, hpp, barcode, updated_at FROM products ORDER BY name').all();
  res.json(rows);
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

// Joins the Shopee catalog cache with the client's own HPP import (by SKU) —
// two separate sources of truth, joined at read time rather than merged into
// one table, since either can exist without the other. hpp/profit are null
// (never 0) when there's no matching HPP entry, per the tech doc's rule that
// unknown cost must never be silently treated as zero cost.
router.get('/catalog', (req, res) => {
  const items = db.prepare('SELECT * FROM shopee_items ORDER BY name').all();
  const models = db.prepare('SELECT * FROM shopee_item_models').all();
  const productBySku = new Map(db.prepare('SELECT sku, hpp, barcode FROM products').all().map((p) => [p.sku, p]));

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
      const profit = hpp != null && m.price != null ? m.price - hpp : null;
      const profitPct = profit != null && m.price ? Math.round((profit / m.price) * 1000) / 10 : null;
      return {
        model_id: m.model_id,
        sku,
        name: m.model_name,
        price: m.price,
        stock: m.stock,
        status: m.model_status,
        image: m.image_url || item.image_url || null,
        hpp,
        barcode,
        profit,
        profitPct,
      };
    });

    return {
      item_id: item.item_id,
      sku: item.item_sku || `ITEM-${item.item_id}`,
      name: item.name,
      status: item.item_status,
      minPurchase: item.min_purchase_limit,
      image: item.image_url,
      soldOut: itemModels.length > 0 && itemModels.every((m) => (m.stock ?? 0) <= 0),
      variants: itemModels,
    };
  });

  res.json(catalog);
});

module.exports = router;
