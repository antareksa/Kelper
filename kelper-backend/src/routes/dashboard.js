const express = require('express');
const db = require('../db');
const { startOfDayWIB, dateStringWIB } = require('../wib');
const { getSetting, setSetting } = require('../settings');

const router = express.Router();

// Mock orders (debugMode's fabricated MOCK- test data) never represent real
// business activity — every query in this file excludes them so a leftover
// or in-progress debug session can't skew what's shown on a dashboard a
// business owner is actually reading numbers off of.
const REAL_ORDER_FILTER = "o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%'";

// order/get_order_detail (the endpoint that would normally carry real
// per-order sale price) has been confirmed broken for this shop, so orders
// that haven't shipped yet (no order_income row — see shopeeSync.js's
// fillMissingIncomeData) fall back to an ESTIMATE: current catalog price x
// qty sold, not the actual transaction price (so a since-changed price,
// voucher, or bundle discount isn't reflected for those). Once an order has
// shipped, its real escrow-based numbers (order_income) are used instead —
// see sumOrdersInRange below for the blend. Ads/affiliate/visitor metrics
// still have no data source at all (see the `blocked` list further down).
function buildSkuPriceMap(shopId) {
  const rows = db
    .prepare(`
      SELECT
        COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku,
        m.price AS price,
        p.hpp AS hpp
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      LEFT JOIN products p ON p.sku = COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id)
      WHERE i.shop_id = ?
    `)
    .all(shopId);
  return new Map(rows.map((r) => [r.sku, { price: r.price, hpp: r.hpp }]));
}

// Sums revenue/profit/fees for every real order created in [startTs, endTs)
// — blended per order: an order with a fetched order_income row (i.e. it
// has shipped, see fillMissingIncomeData) uses Shopee's real escrow numbers;
// one without it yet falls back to the catalog price x qty estimate. Fee
// fields (layanan/biayaPesanan) have no estimate equivalent — they're only
// ever real, so they undercount orders still in progress by design rather
// than guessing at a number Shopee hasn't charged yet.
function sumOrdersInRange(shopId, skuPrices, startTs, endTs) {
  const orders = db
    .prepare(`
      SELECT o.order_sn, oi.order_selling_price, oi.escrow_amount, oi.service_fee, oi.commission_fee, oi.seller_transaction_fee
      FROM orders o
      LEFT JOIN order_income oi ON oi.order_sn = o.order_sn
      WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?
    `)
    .all(shopId, startTs, endTs);
  if (orders.length === 0) return { orderCount: 0, omzet: 0, laba: 0, layanan: 0, biayaPesanan: 0 };

  const placeholders = orders.map(() => '?').join(',');
  const items = db
    .prepare(`SELECT order_sn, sku, qty FROM order_items WHERE order_sn IN (${placeholders})`)
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
  for (const order of orders) {
    const orderItems = itemsByOrder.get(order.order_sn) || [];
    if (order.escrow_amount != null) {
      let cogs = 0;
      for (const item of orderItems) {
        const info = skuPrices.get(item.sku);
        if (info?.hpp != null) cogs += info.hpp * item.qty;
      }
      omzet += order.order_selling_price ?? 0;
      laba += order.escrow_amount - cogs;
      layanan += (order.service_fee ?? 0) + (order.commission_fee ?? 0);
      biayaPesanan += order.seller_transaction_fee ?? 0;
    } else {
      for (const item of orderItems) {
        const info = skuPrices.get(item.sku);
        if (!info || info.price == null) continue;
        omzet += info.price * item.qty;
        if (info.hpp != null) laba += (info.price - info.hpp) * item.qty;
      }
    }
  }
  return { orderCount: orders.length, omzet, laba, layanan, biayaPesanan };
}

function pctChange(today, yesterday) {
  if (!yesterday) return null; // no basis for a % change against zero
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

router.get('/summary', (req, res) => {
  const { shop_id: shopId } = req.query;
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const skuPrices = buildSkuPriceMap(shopId);

  // Last 7 days (WIB), oldest first, for the sparklines + today/yesterday trend.
  const days = [];
  for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
    const start = startOfDayWIB(daysAgo);
    const end = startOfDayWIB(daysAgo - 1);
    days.push(sumOrdersInRange(shopId, skuPrices, start, end));
  }
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const marginPctToday = today.omzet ? Math.round((today.laba / today.omzet) * 1000) / 10 : null;
  const marginPctYesterday = yesterday.omzet ? Math.round((yesterday.laba / yesterday.omzet) * 1000) / 10 : null;

  // Intraday cumulative Omzet/Laba for today, bucketed by WIB hour elapsed so
  // far. Deliberately kept as the catalog-price estimate even for shipped
  // orders (unlike sumOrdersInRange above) — it's a per-hour shape/trend
  // visual, not a KPI number, and the UI already labels it "Estimasi".
  // Blending real vs. estimated math per hour bucket wasn't worth the extra
  // complexity for a chart nobody reads a single value off of.
  const todayStart = startOfDayWIB(0);
  const todayItems = db
    .prepare(`
      SELECT oi.sku, oi.qty, o.created_at
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ?
    `)
    .all(shopId, todayStart);
  const currentHour = Math.floor((Math.floor(Date.now() / 1000) - todayStart) / 3600);
  const hourlyOmzet = new Array(currentHour + 1).fill(0);
  const hourlyLaba = new Array(currentHour + 1).fill(0);
  for (const item of todayItems) {
    const info = skuPrices.get(item.sku);
    if (!info || info.price == null) continue;
    const hour = Math.min(currentHour, Math.floor((item.created_at - todayStart) / 3600));
    hourlyOmzet[hour] += info.price * item.qty;
    if (info.hpp != null) hourlyLaba[hour] += (info.price - info.hpp) * item.qty;
  }
  for (let h = 1; h < hourlyOmzet.length; h += 1) {
    hourlyOmzet[h] += hourlyOmzet[h - 1];
    hourlyLaba[h] += hourlyLaba[h - 1];
  }

  // Top products by estimated gross profit over the last 30 days (a single
  // day rarely has enough distinct SKUs sold for a meaningful ranking).
  const recentItems = db
    .prepare(`
      SELECT oi.sku, oi.product_name, oi.qty
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ?
    `)
    .all(shopId, startOfDayWIB(29));
  const bySku = new Map();
  for (const item of recentItems) {
    const info = skuPrices.get(item.sku);
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

  // Leaking products — real, catalog-only, no order data needed: any synced,
  // non-archived item whose current price doesn't cover its own HPP.
  const leaking = db
    .prepare(`
      SELECT
        COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku,
        COALESCE(m.model_name, i.name) AS name,
        m.price AS price,
        p.hpp AS hpp
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      LEFT JOIN products p ON p.sku = COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id)
      WHERE i.shop_id = ? AND i.item_status = 'NORMAL' AND p.hpp IS NOT NULL AND m.price IS NOT NULL AND m.price <= p.hpp
      ORDER BY (p.hpp - m.price) DESC
      LIMIT 5
    `)
    .all(shopId);

  // Affiliasi comes from a completely separate source (Brand Portal's
  // get_shop_affiliate_performance, fetched once daily — see
  // shopeeSync.js's fetchAffiliatePerformance) with its own 1-day reporting
  // lag, so it's never "today" data — always whatever the latest fetched
  // row is (normally yesterday). null when nothing's been fetched yet
  // (Brand Portal not connected, or the first fetch hasn't run) rather than
  // a fabricated 0.
  const affiliateRow = db
    .prepare('SELECT date, sales_confirmed, orders_confirmed, buyers_confirmed FROM affiliate_performance_daily WHERE shop_id = ? ORDER BY date DESC LIMIT 1')
    .get(shopId);

  // Same "latest fetched row, null if never fetched" pattern as Affiliasi —
  // see shopeeSync.js's fetchShopPerformance.
  const shopPerformanceRow = db
    .prepare('SELECT date, unique_visitors FROM shop_performance_daily WHERE shop_id = ? ORDER BY date DESC LIMIT 1')
    .get(shopId);

  // Iklan, unlike Affiliasi/Pengunjung, genuinely is "today" — see
  // shopeeSync.js's fetchAdsPerformance (refetched every few minutes, not
  // once daily).
  const adsRow = db
    .prepare('SELECT expense FROM ads_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, dateStringWIB(0));

  // Client-requested (2026-09-22): a configurable percentage added on top of
  // raw Shopee ad spend for display — see /dashboard/settings below.
  const adsTaxPercentage = Number(getSetting('adsTaxPercentage', '0'));

  res.json({
    today: {
      orderCount: today.orderCount,
      omzet: today.omzet,
      laba: today.laba,
      layanan: today.layanan,
      biayaPesanan: today.biayaPesanan,
      iklan: adsRow ? adsRow.expense * (1 + adsTaxPercentage / 100) : null,
      marginPct: marginPctToday,
    },
    affiliasi: affiliateRow
      ? {
          date: affiliateRow.date,
          salesConfirmed: affiliateRow.sales_confirmed,
          ordersConfirmed: affiliateRow.orders_confirmed,
          buyersConfirmed: affiliateRow.buyers_confirmed,
        }
      : null,
    pengunjung: shopPerformanceRow
      ? { date: shopPerformanceRow.date, uniqueVisitors: shopPerformanceRow.unique_visitors }
      : null,
    trend: {
      orderCountPct: pctChange(today.orderCount, yesterday.orderCount),
      omzetPct: pctChange(today.omzet, yesterday.omzet),
      labaPct: pctChange(today.laba, yesterday.laba),
      marginPctDelta: marginPctToday != null && marginPctYesterday != null ? Math.round((marginPctToday - marginPctYesterday) * 10) / 10 : null,
    },
    series: {
      orderCount: days.map((d) => d.orderCount),
      omzet: days.map((d) => d.omzet),
      laba: days.map((d) => d.laba),
    },
    todayHourly: { omzet: hourlyOmzet, laba: hourlyLaba },
    topProducts,
    leaking,
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
router.get('/settings', (req, res) => {
  res.json({ adsTaxPercentage: Number(getSetting('adsTaxPercentage', '0')) });
});

router.post('/settings', (req, res) => {
  const { adsTaxPercentage } = req.body || {};
  if (adsTaxPercentage != null) setSetting('adsTaxPercentage', Math.max(0, Number(adsTaxPercentage)));
  res.json({ adsTaxPercentage: Number(getSetting('adsTaxPercentage', '0')) });
});

module.exports = router;
