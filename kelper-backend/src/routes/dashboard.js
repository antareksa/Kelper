const express = require('express');
const db = require('../db');
const { startOfDayWIB } = require('../wib');

const router = express.Router();

// Mock orders (debugMode's fabricated MOCK- test data) never represent real
// business activity — every query in this file excludes them so a leftover
// or in-progress debug session can't skew what's shown on a dashboard a
// business owner is actually reading numbers off of.
const REAL_ORDER_FILTER = "o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%'";

// There is no real per-order sale price anywhere in this system —
// order/get_order_detail (the only Shopee endpoint that would carry it) has
// been confirmed broken for this shop, and nothing else captures it. Omzet/
// Laba below are therefore an ESTIMATE: current catalog price x qty sold,
// not the actual transaction price (so a since-changed price, voucher, or
// bundle discount isn't reflected). Laba is gross margin (price - HPP), not
// a true net profit — no ads/fee/affiliate deduction exists yet (see
// buildBlockedMetrics below). Callers must surface this as an estimate, not
// a fact.
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

// Sums estimated revenue/profit for every order_item belonging to a real
// order created in [startTs, endTs) — an item whose SKU isn't in the synced
// catalog (never synced, or a leftover mock SKU) contributes nothing, per
// the "never assume zero cost/price" rule already used in products.js.
function sumOrdersInRange(shopId, skuPrices, startTs, endTs) {
  const items = db
    .prepare(`
      SELECT oi.sku, oi.qty
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?
    `)
    .all(shopId, startTs, endTs);

  const orderCount = db
    .prepare(`SELECT COUNT(*) c FROM orders o WHERE ${REAL_ORDER_FILTER} AND o.created_at >= ? AND o.created_at < ?`)
    .get(shopId, startTs, endTs).c;

  let omzet = 0;
  let laba = 0;
  for (const item of items) {
    const info = skuPrices.get(item.sku);
    if (!info || info.price == null) continue;
    omzet += info.price * item.qty;
    if (info.hpp != null) laba += (info.price - info.hpp) * item.qty;
  }
  return { orderCount, omzet, laba };
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
  // far — real data, not a placeholder curve.
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

  res.json({
    today: {
      orderCount: today.orderCount,
      omzet: today.omzet,
      laba: today.laba,
      marginPct: marginPctToday,
    },
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
    // Nothing currently integrates Shopee's ads/finance/analytics APIs — no
    // amount of local query work can fill these in, so the frontend shows an
    // explicit "not connected" state instead of a fabricated number.
    blocked: ['ads', 'layanan', 'affiliasi', 'biayaPesanan', 'pengunjung'],
  });
});

module.exports = router;
