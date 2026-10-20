const express = require('express');
const db = require('../db');
const { dateStringWIB, startOfDateWIB, shiftDateStringWIB } = require('../wib');
const { getSetting, setSetting } = require('../settings');

const router = express.Router();

// Mock orders (debugMode's fabricated MOCK- test data) never represent real
// business activity — every query in this file excludes them so a leftover
// or in-progress debug session can't skew what's shown on a dashboard a
// business owner is actually reading numbers off of.
const REAL_ORDER_FILTER = "o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%'";

// Client-requested (2026-09-27): Total Order/Omzet/Laba Kotor/Margin now
// attribute an order to the day it was scanned DONE in Packing Station's
// Shipping Mode (packing_sessions.completed_at — see packing.js's
// confirmOrderPickedUp, used by both /confirm-pickup and the bulk "Force
// All Pickup" action) — "our data" — instead of the day Shopee created the
// order (orders.created_at) — "Shopee data". The old Shopee-based query is
// kept below rather than deleted so this can be reverted by flipping this
// one constant back to 'shopee' and redeploying, no other code changes
// needed. Pengunjung/Affiliasi/Iklan are untouched by this — they have no
// packing-scan equivalent and still come straight from Shopee.
const DASHBOARD_DATA_SOURCE = 'internal'; // 'internal' | 'shopee'

// Client-requested (2026-09-27): Omzet/Laba Kotor now always use the
// catalog price (shopee_item_models.price, the shop's own listed selling
// price) x qty for every order — trusted as "our own" number — instead of
// blending in Shopee's real escrow settlement (order_income) once an order
// ships. The escrow-blended calculation is kept below (see sumOrdersInRange)
// rather than deleted, so this is revertible by flipping this one constant
// back to 'shopee_blend' and redeploying. Layanan/Biaya Pesanan are
// untouched by this — they have no catalog equivalent and stay real-escrow-
// only, same as before.
const OMZET_PRICE_SOURCE = 'catalog'; // 'catalog' | 'shopee_blend'

// Biaya Layanan Promo XTRA as % of the selling price (2026-10-16): Shopee only
// gives it summed with Gratis Ongkir XTRA, see sumOrdersInRange. 4.5 matches
// the client's Rincian Penghasilan (3.428 on 76.180). Editable in Settings.
const DEFAULT_PROMO_XTRA_PCT = 4.5;

// order/get_order_detail (the endpoint that would normally carry real
// per-order sale price) has been confirmed broken for this shop, so the old
// 'shopee_blend' OMZET_PRICE_SOURCE falls back to an ESTIMATE for orders
// that haven't shipped yet (no order_income row — see shopeeSync.js's
// fillMissingIncomeData): current catalog price x qty sold, not the actual
// transaction price (so a since-changed price, voucher, or bundle discount
// isn't reflected for those). Ads/affiliate/visitor metrics still have no
// data source at all (see the `blocked` list further down).
//
// Client-requested (2026-10-15): products.price follows Shopee again — every
// catalog sync copies each SKU's Shopee price into it (see catalogSync.js), and
// it can no longer be set by hand. The text below is the 2026-09-28 history.
//
// Client-requested (2026-09-28): price comes ONLY from products.price now
// — the client's own manually-entered/editable price (see List Barang and
// routes/products.js's /:sku/price), never shopee_item_models.price. No
// Shopee table involved here at all any more; not shop-scoped either,
// since products isn't (same as hpp/stock).
function buildSkuPriceMap() {
  const rows = db.prepare('SELECT sku, price, hpp FROM products').all();
  return new Map(rows.map((r) => [r.sku, { price: r.price, hpp: r.hpp }]));
}

// Client-requested (2026-09-28): an order_item snapshots its price/hpp at
// the moment it was scanned DONE in Shipping Mode (see packing.js's
// confirmOrderPickedUp) — that snapshot wins whenever it exists, so a
// later edit to a SKU's price in List Barang can never rewrite an
// already-counted order's numbers. Only falls back to the live
// products.price/hpp lookup (skuPrices) for an item that was never
// snapshotted — pre-feature history, or DASHBOARD_DATA_SOURCE === 'shopee'
// orders that were never scanned in Shipping Mode at all.
function priceInfoForItem(item, skuPrices) {
  // The price is frozen when the order arrives, the HPP only at the pickup scan, so
  // an order not scanned yet has a price snapshot but no HPP one: use today's HPP.
  if (item.price_snapshot != null) return { price: item.price_snapshot, hpp: item.hpp_snapshot ?? skuPrices.get(item.sku)?.hpp ?? null };
  return skuPrices.get(item.sku);
}

// Client-requested (2026-09-28): flags SKUs whose CURRENT products.price/
// hpp differs from what's frozen (price_snapshot/hpp_snapshot) on that
// SKU's most recently scanned order — i.e. "you've changed this since it
// last sold". Only included when there's an actual difference; a SKU
// that's never been touched since its last sale doesn't appear at all.
// SQLite's single-max-aggregate rule (a documented feature, not a fluke)
// makes oi.price_snapshot/oi.hpp_snapshot come from the same row as
// MAX(ps.completed_at) within each sku group, so this needs no subquery
// to find "the latest order's snapshot" per SKU.
function findPriceDiffs(shopId) {
  const lastSold = db
    .prepare(`
      SELECT oi.sku, oi.product_name, oi.price_snapshot, oi.hpp_snapshot, MAX(ps.completed_at) AS last_sold_at
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      JOIN (
        SELECT order_sn, MAX(completed_at) AS completed_at
        FROM packing_sessions
        WHERE status = 'DONE'
        GROUP BY order_sn
      ) ps ON ps.order_sn = o.order_sn
      WHERE ${REAL_ORDER_FILTER} AND oi.price_snapshot IS NOT NULL
      GROUP BY oi.sku
    `)
    .all(shopId);

  const productBySku = new Map(db.prepare('SELECT sku, price, hpp FROM products').all().map((p) => [p.sku, p]));

  return lastSold
    .map((row) => {
      const current = productBySku.get(row.sku);
      const currentPrice = current?.price ?? null;
      const currentHpp = current?.hpp ?? null;
      const priceChanged = currentPrice !== row.price_snapshot;
      const hppChanged = currentHpp !== row.hpp_snapshot;
      if (!priceChanged && !hppChanged) return null;
      return {
        sku: row.sku,
        name: row.product_name,
        lastSoldAt: row.last_sold_at,
        currentPrice,
        snapshotPrice: row.price_snapshot,
        priceDiff: priceChanged && currentPrice != null ? currentPrice - row.price_snapshot : null,
        currentHpp,
        snapshotHpp: row.hpp_snapshot,
        hppDiff: hppChanged && currentHpp != null ? currentHpp - row.hpp_snapshot : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lastSoldAt - a.lastSoldAt);
}

// Sums revenue/profit/fees for every real order attributed to [startTs,
// endTs). Omzet/Laba Kotor follow OMZET_PRICE_SOURCE — 'catalog' (current
// default) always uses catalog price x qty; 'shopee_blend' (the original
// behavior) uses Shopee's real escrow numbers once an order has shipped,
// falling back to the catalog estimate until then. Layanan/Biaya Pesanan
// are unaffected by that toggle — they have no catalog equivalent, so they
// stay real-escrow-only either way, undercounting orders still in progress
// by design rather than guessing at a number Shopee hasn't charged yet.
//
// Which orders fall in range, and by which date, depends on
// DASHBOARD_DATA_SOURCE: 'internal' counts an order on the day it was
// scanned DONE in Shipping Mode (only orders that have actually completed
// that scan show up at all); 'shopee' (the original behavior) counts it on
// the day Shopee created the order, regardless of packing/shipping progress.
function sumOrdersInRange(shopId, skuPrices, startTs, endTs) {
  const orders = DASHBOARD_DATA_SOURCE === 'internal'
    ? db
        .prepare(`
          SELECT o.order_sn, oi.order_selling_price, oi.escrow_amount, oi.service_fee, oi.commission_fee, oi.seller_transaction_fee,
                 oi.seller_order_processing_fee, oi.withholding_tax
          FROM orders o
          JOIN (
            SELECT order_sn, MAX(completed_at) AS completed_at
            FROM packing_sessions
            WHERE status = 'DONE'
            GROUP BY order_sn
          ) ps ON ps.order_sn = o.order_sn
          LEFT JOIN order_income oi ON oi.order_sn = o.order_sn
          WHERE ${REAL_ORDER_FILTER} AND ps.completed_at >= ? AND ps.completed_at < ?
        `)
        .all(shopId, startTs, endTs)
    : db
        .prepare(`
          SELECT o.order_sn, oi.order_selling_price, oi.escrow_amount, oi.service_fee, oi.commission_fee, oi.seller_transaction_fee,
                 oi.seller_order_processing_fee, oi.withholding_tax
          FROM orders o
          LEFT JOIN order_income oi ON oi.order_sn = o.order_sn
          WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?
        `)
        .all(shopId, startTs, endTs);
  if (orders.length === 0) return { orderCount: 0, omzet: 0, laba: 0, layanan: 0, biayaPesanan: 0 };

  const placeholders = orders.map(() => '?').join(',');
  const items = db
    .prepare(`SELECT order_sn, sku, qty, price_snapshot, hpp_snapshot FROM order_items WHERE order_sn IN (${placeholders})`)
    .all(...orders.map((o) => o.order_sn));
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!itemsByOrder.has(item.order_sn)) itemsByOrder.set(item.order_sn, []);
    itemsByOrder.get(item.order_sn).push(item);
  }

  let omzet = 0;
  let laba = 0;
  let layanan = 0;
  let biayaPesanan = 0;
  const promoXtraPct = Number(getSetting('promoXtraPercentage', String(DEFAULT_PROMO_XTRA_PCT)));
  for (const order of orders) {
    const orderItems = itemsByOrder.get(order.order_sn) || [];
    const useEscrowForOmzet = OMZET_PRICE_SOURCE === 'shopee_blend' && order.escrow_amount != null;

    if (useEscrowForOmzet) {
      let cogs = 0;
      for (const item of orderItems) {
        const info = priceInfoForItem(item, skuPrices);
        if (info?.hpp != null) cogs += info.hpp * item.qty;
      }
      omzet += order.order_selling_price ?? 0;
      laba += order.escrow_amount - cogs;
    } else {
      for (const item of orderItems) {
        const info = priceInfoForItem(item, skuPrices);
        if (!info || info.price == null) continue;
        omzet += info.price * item.qty;
        if (info.hpp != null) laba += (info.price - info.hpp) * item.qty;
      }
    }

    // Layanan/Biaya Pesanan: always real-escrow-only, independent of
    // OMZET_PRICE_SOURCE — there's no catalog-price equivalent for a fee.
    // Client-requested grouping (2026-10-16): Layanan = Biaya Layanan Promo
    // XTRA only; Biaya Pesanan = every other fee (Administrasi, Proses
    // Pesanan, Pembayaran, Gratis Ongkir XTRA, PPh 22); Biaya Promosi (the
    // ads top-up) is left out, it is already in Iklan. Shopee's service_fee
    // holds Gratis Ongkir XTRA + Promo XTRA as ONE number, so the Promo XTRA
    // part is estimated as promoXtraPercentage of the selling price (capped
    // at service_fee) and the rest of service_fee goes to Biaya Pesanan --
    // the two together still add up to Shopee's exact fees.
    if (order.escrow_amount != null) {
      const serviceFee = order.service_fee ?? 0;
      const promoXtra = Math.min(serviceFee, Math.round((order.order_selling_price ?? 0) * promoXtraPct / 100));
      layanan += promoXtra;
      biayaPesanan += (order.commission_fee ?? 0)
        + (order.seller_order_processing_fee ?? 0)
        + (order.seller_transaction_fee ?? 0)
        + (order.withholding_tax ?? 0)
        + (serviceFee - promoXtra);
    }
  }
  return { orderCount: orders.length, omzet, laba, layanan, biayaPesanan };
}

function pctChange(today, yesterday) {
  if (!yesterday) return null; // no basis for a % change against zero
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

// Page views of one WIB day, from the item_views readings (see db.js). Per item: the day's
// views = the next day's first reading (or, for a day still running, the latest reading)
// minus the day's first reading. A counter that went DOWN is ignored for that item, not
// subtracted. null when no item has a usable pair of readings (nothing recorded yet).
function pageViewsFor(shopId, date) {
  const rows = db.prepare('SELECT item_id, views_start, views_latest FROM item_views WHERE shop_id = ? AND date = ?').all(shopId, date);
  if (rows.length === 0) return null;
  const nextStart = new Map(
    db.prepare('SELECT item_id, views_start FROM item_views WHERE shop_id = ? AND date = ?').all(shopId, shiftDateStringWIB(date, 1)).map((r) => [r.item_id, r.views_start])
  );
  let total = 0;
  let counted = 0;
  for (const r of rows) {
    const end = nextStart.has(r.item_id) ? nextStart.get(r.item_id) : r.views_latest;
    const delta = end - r.views_start;
    if (delta >= 0) { total += delta; counted += 1; }
  }
  return counted === 0 ? null : { date, pageViews: total };
}

// Max length of a Dashboard date range, in days. One SQL pass per day for the series.
const MAX_RANGE_DAYS = 366;

// Every YYYY-MM-DD from start to end, inclusive.
function datesInRange(start, end) {
  const dates = [];
  for (let d = start; d <= end; d = shiftDateStringWIB(d, 1)) dates.push(d);
  return dates;
}

// Client-requested (2026-10-16): the Dashboard shows a date RANGE (?start=&end=, both
// YYYY-MM-DD WIB, inclusive). ?date= alone still means that one day. Every figure is the
// total over the range; the trend compares with the period of the same length right
// before it.
router.get('/summary', (req, res) => {
  const { shop_id: shopId, date } = req.query;
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const todayDateStr = dateStringWIB(0);
  let startDate = req.query.start || date || todayDateStr;
  let endDate = req.query.end || date || startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'invalid_date', message: 'start/end must be YYYY-MM-DD' });
  }
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
  const rangeDates = datesInRange(startDate, endDate);
  if (rangeDates.length > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: 'range_too_long', message: `a range can be at most ${MAX_RANGE_DAYS} days` });
  }
  const dayCount = rangeDates.length;
  // The range reaches today: its figures are still growing (live view, partial Page View).
  const isToday = endDate >= todayDateStr;

  const skuPrices = buildSkuPriceMap();
  const rangeStart = startOfDateWIB(startDate);
  const rangeEnd = startOfDateWIB(shiftDateStringWIB(endDate, 1));
  const today = sumOrdersInRange(shopId, skuPrices, rangeStart, rangeEnd);
  const yesterday = sumOrdersInRange(shopId, skuPrices, startOfDateWIB(shiftDateStringWIB(startDate, -dayCount)), rangeStart);

  // Sparklines: one point per day of the range, at least the 7 days ending on its last
  // day (a one-day range would otherwise be a single dot).
  const seriesDates = dayCount >= 7 ? rangeDates : datesInRange(shiftDateStringWIB(endDate, -6), endDate);
  const days = seriesDates.map((d) => sumOrdersInRange(shopId, skuPrices, startOfDateWIB(d), startOfDateWIB(shiftDateStringWIB(d, 1))));

  // Whether the selected range has real orders. On its own this no longer decides whether
  // the page shows anything: see hasData in the response below.
  const hasOrders = today.orderCount > 0;

  // Omzet/Laba chart, catalog-price estimate (the UI labels it "Estimasi"): for a one-day
  // range the running total per WIB hour (today: up to the current hour); for a longer
  // range each day's own total, one point per day.
  const rangeItems = DASHBOARD_DATA_SOURCE === 'internal'
    ? db
        .prepare(`
          SELECT oi.sku, oi.product_name, oi.qty, oi.price_snapshot, oi.hpp_snapshot, ps.completed_at AS ts
          FROM order_items oi
          JOIN orders o ON o.order_sn = oi.order_sn
          JOIN (
            SELECT order_sn, MAX(completed_at) AS completed_at
            FROM packing_sessions
            WHERE status = 'DONE'
            GROUP BY order_sn
          ) ps ON ps.order_sn = o.order_sn
          WHERE ${REAL_ORDER_FILTER} AND ps.completed_at >= ? AND ps.completed_at < ?
        `)
        .all(shopId, rangeStart, rangeEnd)
    : db
        .prepare(`
          SELECT oi.sku, oi.product_name, oi.qty, oi.price_snapshot, oi.hpp_snapshot, o.created_at AS ts
          FROM order_items oi
          JOIN orders o ON o.order_sn = oi.order_sn
          WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?
        `)
        .all(shopId, rangeStart, rangeEnd);
  const chartUnit = dayCount === 1 ? 'hour' : 'day';
  const lastHour = endDate === todayDateStr ? Math.min(23, Math.floor((Math.floor(Date.now() / 1000) - rangeStart) / 3600)) : 23;
  const buckets = chartUnit === 'hour' ? lastHour + 1 : dayCount;
  const chartOmzet = new Array(buckets).fill(0);
  const chartLaba = new Array(buckets).fill(0);
  for (const item of rangeItems) {
    const info = priceInfoForItem(item, skuPrices);
    if (!info || info.price == null) continue;
    const bucket = chartUnit === 'hour'
      ? Math.min(lastHour, Math.floor((item.ts - rangeStart) / 3600))
      : Math.min(dayCount - 1, Math.floor((item.ts - rangeStart) / 86400)); // WIB has no DST: every day is 86400 s
    chartOmzet[bucket] += info.price * item.qty;
    if (info.hpp != null) chartLaba[bucket] += (info.price - info.hpp) * item.qty;
  }
  if (chartUnit === 'hour') {
    for (let h = 1; h < chartOmzet.length; h += 1) {
      chartOmzet[h] += chartOmzet[h - 1];
      chartLaba[h] += chartLaba[h - 1];
    }
  }

  // Top products by estimated gross profit over the selected range (was: always the
  // last 30 days, before the range picker).
  const bySku = new Map();
  for (const item of rangeItems) {
    const info = priceInfoForItem(item, skuPrices);
    if (!info || info.price == null) continue;
    const entry = bySku.get(item.sku) || { sku: item.sku, name: item.product_name, qty: 0, profit: null, revenue: 0 };
    entry.qty += item.qty;
    entry.revenue += info.price * item.qty;
    if (info.hpp != null) entry.profit = (entry.profit ?? 0) + (info.price - info.hpp) * item.qty;
    bySku.set(item.sku, entry);
  }
  const topProducts = [...bySku.values()]
    .sort((a, b) => (b.profit ?? b.revenue) - (a.profit ?? a.revenue))
    .slice(0, 5);

  // Leaking products — any NORMAL (live, non-archived) listing whose
  // client-entered price doesn't cover its own HPP. item_status still comes
  // from Shopee (shopee_items) — that's genuinely Shopee's own concept of
  // "is this actually a live listing", not a number "our data" could stand
  // in for — but the price/HPP comparison itself is products.price vs
  // products.hpp only, same as buildSkuPriceMap above, not
  // shopee_item_models.price.
  const leaking = db
    .prepare(`
      SELECT
        COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku,
        COALESCE(m.model_name, i.name) AS name,
        p.price AS price,
        p.hpp AS hpp
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      LEFT JOIN products p ON p.sku = COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id)
      WHERE i.shop_id = ? AND i.item_status = 'NORMAL' AND p.hpp IS NOT NULL AND p.price IS NOT NULL AND p.price <= p.hpp
      ORDER BY (p.hpp - p.price) DESC
      LIMIT 5
    `)
    .all(shopId);

  // Most/least dashboard-stock products — the client's own manually-entered
  // stock (products.stock), deliberately not Shopee's live stock: the two
  // are allowed to disagree (see db.js migration comment). Only SKUs that
  // actually have a value are ranked; an unset stock is unknown, not zero,
  // so it must never show up as "least stock" by default.
  const stockRankBase = `
    FROM shopee_item_models m
    JOIN shopee_items i ON i.item_id = m.item_id
    JOIN products p ON p.sku = COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id)
    WHERE i.shop_id = ? AND i.item_status = 'NORMAL' AND p.stock IS NOT NULL
  `;
  const stockRankSelect = `
    SELECT COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku,
      COALESCE(m.model_name, i.name) AS name,
      p.stock AS stock
    ${stockRankBase}
  `;
  const mostStock = db.prepare(`${stockRankSelect} ORDER BY p.stock DESC LIMIT 5`).all(shopId);
  const leastStock = db.prepare(`${stockRankSelect} ORDER BY p.stock ASC LIMIT 5`).all(shopId);

  // Affiliasi comes from a completely separate source (Shopee's AMS
  // get_affiliate_performance, one row per day -- see shopeeSync.js's
  // fetchAffiliatePerformance) with a 1-day reporting lag, so today never has
  // a row. Summed over the range's days that have one; null when none has
  // (AMS not connected, not fetched yet, or a date older than this feature)
  // rather than a fabricated 0. Commission is null when no row has it (rows
  // fetched before that column existed).
  const placeholders = rangeDates.map(() => '?').join(',');
  const affiliateRows = db
    .prepare(`SELECT sales_confirmed, orders_confirmed, buyers_confirmed, commission FROM affiliate_performance_daily WHERE shop_id = ? AND date IN (${placeholders})`)
    .all(shopId, ...rangeDates);
  const sumOf = (rows, key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
  const commissionRows = affiliateRows.filter((r) => r.commission != null);
  const affiliasiCommission = commissionRows.length ? sumOf(commissionRows, 'commission') : null;

  // Page View (replaced Pengunjung, 2026-10-13): from per-item readings of Shopee's view
  // counter, see pageViewsFor; the range's total is the sum of its days that have
  // readings. null before any reading.
  const pageViewDays = rangeDates.map((d) => pageViewsFor(shopId, d)).filter(Boolean);
  const pageViews = pageViewDays.length ? { pageViews: pageViewDays.reduce((t, d) => t + d.pageViews, 0), partial: isToday } : null;

  // Iklan, unlike Affiliasi, does have "today" (refetched every few minutes, see
  // shopeeSync.js's fetchAdsPerformance). Summed over the range's days with a row.
  const adsRows = db
    .prepare(`SELECT expense FROM ads_performance_daily WHERE shop_id = ? AND date IN (${placeholders})`)
    .all(shopId, ...rangeDates);

  // Client-requested (2026-09-22): a configurable percentage added on top of
  // raw Shopee ad spend for display — see /dashboard/settings below.
  const adsTaxPercentage = Number(getSetting('adsTaxPercentage', '0'));
  const iklan = adsRows.length ? sumOf(adsRows, 'expense') * (1 + adsTaxPercentage / 100) : null;
  // Client-requested (2026-10-16): Laba Kotor minus every real cost this
  // Dashboard tracks. Iklan/Affiliasi commission can be null (not fetched
  // yet for this date, or a date before the commission column existed) --
  // treated as 0 here rather than blocking the whole figure, same tradeoff
  // CostBreakdown already makes for its total. Layanan/Biaya Pesanan are
  // never null once there are real orders (see sumOrdersInRange).
  const labaBersih = today.laba - today.layanan - today.biayaPesanan - (iklan ?? 0) - (affiliasiCommission ?? 0);

  // Persentase Profit, client-requested (2026-10-20): (Omzet - Laba Bersih) / Omzet,
  // i.e. the share of Omzet that went to HPP + every cost above. The previous
  // period's Laba Bersih is built the same way for the trend.
  const prevDates = datesInRange(shiftDateStringWIB(startDate, -dayCount), shiftDateStringWIB(startDate, -1));
  const prevPlaceholders = prevDates.map(() => '?').join(',');
  const prevAdsRows = db
    .prepare(`SELECT expense FROM ads_performance_daily WHERE shop_id = ? AND date IN (${prevPlaceholders})`)
    .all(shopId, ...prevDates);
  const prevIklan = sumOf(prevAdsRows, 'expense') * (1 + adsTaxPercentage / 100);
  const prevCommission = sumOf(
    db.prepare(`SELECT commission FROM affiliate_performance_daily WHERE shop_id = ? AND date IN (${prevPlaceholders})`).all(shopId, ...prevDates),
    'commission'
  );
  const prevLabaBersih = yesterday.laba - yesterday.layanan - yesterday.biayaPesanan - prevIklan - prevCommission;
  const profitPct = (omzet, bersih) => (omzet ? Math.round(((omzet - bersih) / omzet) * 1000) / 10 : null);
  const marginPctToday = profitPct(today.omzet, labaBersih);
  const marginPctYesterday = profitPct(yesterday.omzet, prevLabaBersih);

  res.json({
    date: endDate, // the range's last day (kept for older callers)
    start: startDate,
    end: endDate,
    dayCount,
    isToday,
    // The page shows the day when it has real orders OR an Affiliasi / Iklan / Page View figure was
    // recorded for it (changed 2026-10-13). Before, a day with no completed orders hid
    // everything, so an Affiliasi or ad-spend figure that existed for it was never shown.
    // Only a day with nothing of any kind still says "Data tidak tersedia".
    hasData: hasOrders || affiliateRows.length > 0 || adsRows.length > 0 || !!pageViews,
    today: {
      orderCount: today.orderCount,
      omzet: today.omzet,
      laba: today.laba,
      layanan: today.layanan,
      biayaPesanan: today.biayaPesanan,
      iklan,
      labaBersih,
      marginPct: marginPctToday,
    },
    affiliasi: affiliateRows.length
      ? {
          daysWithData: affiliateRows.length,
          salesConfirmed: sumOf(affiliateRows, 'sales_confirmed'),
          ordersConfirmed: sumOf(affiliateRows, 'orders_confirmed'),
          buyersConfirmed: sumOf(affiliateRows, 'buyers_confirmed'),
          commission: affiliasiCommission,
        }
      : null,
    pageViews,
    trend: {
      orderCountPct: pctChange(today.orderCount, yesterday.orderCount),
      omzetPct: pctChange(today.omzet, yesterday.omzet),
      labaPct: pctChange(today.laba, yesterday.laba),
      marginPctDelta: marginPctToday != null && marginPctYesterday != null ? Math.round((marginPctToday - marginPctYesterday) * 10) / 10 : null,
    },
    series: {
      dates: seriesDates,
      orderCount: days.map((d) => d.orderCount),
      omzet: days.map((d) => d.omzet),
      laba: days.map((d) => d.laba),
    },
    chart: { unit: chartUnit, omzet: chartOmzet, laba: chartLaba },
    topProducts,
    leaking,
    mostStock,
    leastStock,
    priceDiffs: findPriceDiffs(shopId),
    // Every metric this Dashboard shows now has a real data source
    // (escrow, Ads Performance, Brand Portal) — kept as an empty array
    // rather than removed, since the frontend still checks it per metric.
    blocked: [],
  });
});

// Dashboard configuration (client-requested 2026-09-22) — currently just Ads
// tax percentage, stored in the same `settings` key/value table Packing
// Station's settings use (see settings.js), so an admin's edit persists
// across deploys instead of being reverted by the next git pull.
// promoXtraPercentage (2026-10-16): see sumOrdersInRange's Layanan split.
function dashboardSettings() {
  return {
    adsTaxPercentage: Number(getSetting('adsTaxPercentage', '0')),
    promoXtraPercentage: Number(getSetting('promoXtraPercentage', String(DEFAULT_PROMO_XTRA_PCT))),
  };
}

router.get('/settings', (req, res) => {
  res.json(dashboardSettings());
});

router.post('/settings', (req, res) => {
  const { adsTaxPercentage, promoXtraPercentage } = req.body || {};
  if (adsTaxPercentage != null) setSetting('adsTaxPercentage', Math.max(0, Number(adsTaxPercentage)));
  if (promoXtraPercentage != null) setSetting('promoXtraPercentage', Math.max(0, Number(promoXtraPercentage)));
  res.json(dashboardSettings());
});

module.exports = router;
