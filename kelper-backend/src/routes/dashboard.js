const express = require('express');
const db = require('../db');
const { startOfDayWIB, dateStringWIB, startOfDateWIB, shiftDateStringWIB } = require('../wib');
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

// Sums revenue/profit/fees for every real order attributed to [startTs,
// endTs) — blended per order: an order with a fetched order_income row (i.e.
// it has shipped, see fillMissingIncomeData) uses Shopee's real escrow
// numbers; one without it yet falls back to the catalog price x qty
// estimate. Fee fields (layanan/biayaPesanan) have no estimate equivalent —
// they're only ever real, so they undercount orders still in progress by
// design rather than guessing at a number Shopee hasn't charged yet.
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
          SELECT o.order_sn, oi.order_selling_price, oi.escrow_amount, oi.service_fee, oi.commission_fee, oi.seller_transaction_fee
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
  const { shop_id: shopId, date } = req.query;
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const todayDateStr = dateStringWIB(0);
  const selectedDate = date || todayDateStr;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    return res.status(400).json({ error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
  }
  const isToday = selectedDate === todayDateStr;

  const skuPrices = buildSkuPriceMap(shopId);

  // 7 days (WIB) ending on the selected date, oldest first, for the
  // sparklines + selected-day/day-before trend. Defaults to today when no
  // date is picked, same range as before the date picker existed.
  const days = [];
  for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
    const dateStr = shiftDateStringWIB(selectedDate, -daysAgo);
    const start = startOfDateWIB(dateStr);
    const end = startOfDateWIB(shiftDateStringWIB(dateStr, 1));
    days.push(sumOrdersInRange(shopId, skuPrices, start, end));
  }
  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  const marginPctToday = today.omzet ? Math.round((today.laba / today.omzet) * 1000) / 10 : null;
  const marginPctYesterday = yesterday.omzet ? Math.round((yesterday.laba / yesterday.omzet) * 1000) / 10 : null;

  // The selected day has no real orders at all — nothing to show for it
  // (a date before the shop had any activity, or one still in the future).
  // A genuinely quiet real day would also hit this, but there's no separate
  // "we checked and there were zero" marker to tell the two apart.
  const hasData = today.orderCount > 0;

  // Intraday cumulative Omzet/Laba for the selected day, bucketed by WIB
  // hour. For today, only up to the current hour (live, keeps updating as
  // the day goes); for a past day, the full 24 hours. Deliberately kept as
  // the catalog-price estimate even for shipped orders (unlike
  // sumOrdersInRange above) — it's a per-hour shape/trend visual, not a KPI
  // number, and the UI already labels it "Estimasi". Blending real vs.
  // estimated math per hour bucket wasn't worth the extra complexity for a
  // chart nobody reads a single value off of.
  const dayStart = startOfDateWIB(selectedDate);
  const dayEnd = startOfDateWIB(shiftDateStringWIB(selectedDate, 1));
  const dayItems = DASHBOARD_DATA_SOURCE === 'internal'
    ? db
        .prepare(`
          SELECT oi.sku, oi.qty, ps.completed_at AS ts
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
        .all(shopId, dayStart, dayEnd)
    : db
        .prepare(`
          SELECT oi.sku, oi.qty, o.created_at AS ts
          FROM order_items oi
          JOIN orders o ON o.order_sn = oi.order_sn
          WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?
        `)
        .all(shopId, dayStart, dayEnd);
  const lastHour = isToday ? Math.min(23, Math.floor((Math.floor(Date.now() / 1000) - dayStart) / 3600)) : 23;
  const hourlyOmzet = new Array(lastHour + 1).fill(0);
  const hourlyLaba = new Array(lastHour + 1).fill(0);
  for (const item of dayItems) {
    const info = skuPrices.get(item.sku);
    if (!info || info.price == null) continue;
    const hour = Math.min(lastHour, Math.floor((item.ts - dayStart) / 3600));
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

  // Affiliasi comes from a completely separate source (Brand Portal's
  // get_shop_affiliate_performance, fetched once daily — see
  // shopeeSync.js's fetchAffiliatePerformance) with its own 1-day reporting
  // lag, so it's never available for "today" itself. Looked up by the exact
  // selected date (not "latest fetched") now that the date picker can move
  // away from today — null when nothing was fetched for that date (Brand
  // Portal not connected, the fetch hadn't run yet, or a date old enough to
  // predate this feature) rather than a fabricated 0.
  const affiliateRow = db
    .prepare('SELECT date, sales_confirmed, orders_confirmed, buyers_confirmed FROM affiliate_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, selectedDate);

  // Same "exact date, null if never fetched" pattern as Affiliasi — see
  // shopeeSync.js's fetchShopPerformance.
  const shopPerformanceRow = db
    .prepare('SELECT date, unique_visitors FROM shop_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, selectedDate);

  // Iklan, unlike Affiliasi/Pengunjung, genuinely is "today" when today is
  // selected — see shopeeSync.js's fetchAdsPerformance (refetched every few
  // minutes, not once daily). For a past date it's whatever was last
  // recorded under that date before the day rolled over.
  const adsRow = db
    .prepare('SELECT expense FROM ads_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, selectedDate);

  // Client-requested (2026-09-22): a configurable percentage added on top of
  // raw Shopee ad spend for display — see /dashboard/settings below.
  const adsTaxPercentage = Number(getSetting('adsTaxPercentage', '0'));

  res.json({
    date: selectedDate,
    isToday,
    hasData,
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
    mostStock,
    leastStock,
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
