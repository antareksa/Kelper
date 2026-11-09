const db = require('../db');
const { isConfigured, apiRequest } = require('./client');
const { getValidAccessToken } = require('./tokenStore');
const { getSetting, setSetting } = require('../settings');
const { flagOrderAsException } = require('../shopeeSync');
const { bookTikTokOrders, detectLatePickups } = require('./booking');
const { fillTikTokIncome } = require('./income');

// TikTok Shop / Tokopedia order import (2026-11-07) and booking loop
// (2026-11-10), see docs/FEATURE-tiktok-integration.md. This file only reads
// from TikTok; booking and labels are in booking.js.
//
// Orders are stored under TIKTOK_SHOP_ID with orders.platform 'tiktok' or
// 'tokopedia'. Every Shopee-calling loop (booking, cancel checks, income,
// shopeeSync.js) filters on the real Shopee shop_id, so it never touches them.
// The Packing Station's own queries include them through `platform != 'shopee'`
// (routes/packing.js), which is what makes it one shared queue. The real TikTok
// ids don't fit in shop_id anyway: they exceed JS's safe integer range.
// Several TikTok shops can be connected: orders.marketplace_shop_id says which
// one an order belongs to, and booking uses that shop's cipher.
const TIKTOK_SHOP_ID = -1;

// The TikTok side of the Order Lists fetch switch (2026-11-10), separate from
// Shopee's 'syncEnabled'. Off by default like Shopee's. While off, no NEW
// TikTok order is imported and nothing is booked; orders already in KELPER
// keep getting status updates, so a cancellation is still noticed.
const SYNC_SETTING = 'tiktokSyncEnabled';
const isTikTokSyncEnabled = () => getSetting(SYNC_SETTING, 'false') === 'true';
function setTikTokSyncEnabled(enabled) {
  setSetting(SYNC_SETTING, enabled ? 'true' : 'false');
  // Unlocking re-reads the last 15 days, so orders that arrived while locked
  // come in now -- the same as Shopee, whose discovery always lists every
  // READY_TO_SHIP order of the last 15 days.
  if (enabled) db.prepare("DELETE FROM settings WHERE key LIKE 'tiktokOrdersSyncedAt:%'").run();
}

const POLL_INTERVAL_MS = 30 * 1000;
const BOOKING_INTERVAL_MS = 15 * 1000;
const FIRST_SYNC_LOOKBACK_SECONDS = 15 * 24 * 60 * 60;
// Re-reads a little of the previous window, so an order updated while the last
// tick was running can't fall between two ticks.
const OVERLAP_SECONDS = 5 * 60;
const SEARCH_PAGE_SIZE = '100';
const DETAIL_BATCH_SIZE = 50; // GET /order/202507/orders takes at most 50 ids
const INSTANT_PRIORITY_LEVEL = 100; // fulfillment_priority_level: 100 = Instant

// Waiting to ship: ON_HOLD can't be booked yet but a new order must still show.
const OPEN_STATUSES = ['ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION'];
const SHIPPED_STATUSES = ['IN_TRANSIT', 'DELIVERED', 'COMPLETED'];
// Local status for an order that left without KELPER (shipped from Seller
// Center): drops out of every bucket and, unlike DONE, out of the Dashboard.
const SHIPPED_EXTERNAL = 'SHIPPED_EXTERNAL';

function now() {
  return Math.floor(Date.now() / 1000);
}

// TikTok returns one line per unit, with no quantity field: 3 x the same SKU is
// 3 lines. An empty seller_sku is possible (seen on a sandbox order), and order
// _items.sku can't be empty, so those fall back the way Shopee's ITEM-<id> does.
function groupLineItems(lineItems) {
  const bySku = new Map();
  for (const line of lineItems || []) {
    if (line.display_status === 'CANCELLED') continue; // one line cancelled, the rest still ship
    const sku = line.seller_sku || `ITEM-${line.sku_id}`;
    const entry = bySku.get(sku);
    if (entry) {
      entry.qty += 1;
    } else {
      // "Default" is TikTok's name for a product with no variants.
      const hasVariant = line.sku_name && line.sku_name !== 'Default';
      bySku.set(sku, { sku, productName: hasVariant ? `${line.product_name} - ${line.sku_name}` : line.product_name, qty: 1, imageUrl: line.sku_image || null });
    }
  }
  return [...bySku.values()];
}

function orderFlags(order) {
  const flags = [];
  if ((order.line_items || []).some((line) => !line.seller_sku)) flags.push('no_sku');
  if ((order.packages || []).length > 1 || order.status === 'PARTIALLY_SHIPPING') flags.push('multi_package');
  if (order.is_buyer_request_cancel) flags.push('buyer_cancel');
  return flags.join(',') || null;
}

const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (order_sn, shop_id, status, created_at, platform)
  VALUES (?, ?, 'ON_HOLD', ?, ?)
`);
const updateOrder = db.prepare(`
  UPDATE orders SET status = ?, buyer_name = COALESCE(?, buyer_name), shipping_carrier = COALESCE(?, shipping_carrier),
    is_instant = ?, marketplace_status = ?, marketplace_flags = ?, platform = ?, package_number = COALESCE(?, package_number)
  WHERE order_sn = ?
`);
const deleteItems = db.prepare('DELETE FROM order_items WHERE order_sn = ?');
const insertItem = db.prepare(`
  INSERT INTO order_items (order_sn, sku, product_name, qty, image_url, price_snapshot)
  VALUES (?, ?, ?, ?, ?, (SELECT price FROM products WHERE sku = ?))
`);

// Local statuses an imported order can still change from. ON_HOLD is TikTok's
// own cancel window: kept as its own local status (2026-11-10) so every
// READY_TO_PACK query (claiming, booking, the buckets) skips it untouched, and
// it shows in the Waiting List until TikTok releases it.
const ACTIVE_LOCAL = ['ON_HOLD', 'READY_TO_PACK', 'LOCKED', 'DEFERRED'];

// Why an order can't go through the Packing Station normally, or null.
function masalahReason(flags) {
  const list = (flags || '').split(',');
  if (list.includes('no_sku')) return 'TikTok: ada produk tanpa Seller SKU, tidak bisa discan';
  if (list.includes('multi_package')) return 'TikTok: order dipecah/digabung jadi beberapa paket';
  return null;
}

const saveOrder = db.transaction((order, tiktokShopId = null) => {
  const existing = db.prepare('SELECT status, label_ready FROM orders WHERE order_sn = ?').get(order.id);
  // Never imported before and already past the point KELPER could ship it.
  if (!existing && !OPEN_STATUSES.includes(order.status)) return;
  // Fetching locked: no new orders (see SYNC_SETTING above).
  if (!existing && !isTikTokSyncEnabled()) return;
  // Finished here (DONE, CANCELLED, SHIPPED_EXTERNAL): a later update changes nothing.
  if (existing && !ACTIVE_LOCAL.includes(existing.status)) return;
  // "Dilayani Tokopedia" and the like: TikTok ships these itself.
  if (order.fulfillment_type !== 'FULFILLMENT_BY_SELLER') return;

  const platform = order.commerce_platform === 'TOKOPEDIA' ? 'tokopedia' : 'tiktok';
  insertOrder.run(order.id, TIKTOK_SHOP_ID, order.create_time || now(), platform);
  if (tiktokShopId) db.prepare('UPDATE orders SET marketplace_shop_id = ? WHERE order_sn = ?').run(String(tiktokShopId), order.id);
  const current = existing?.status || 'ON_HOLD';
  const session = db.prepare('SELECT id FROM packing_sessions WHERE order_sn = ?').get(order.id);
  const untouched = !session && !existing?.label_ready; // KELPER hasn't claimed or booked it

  let status = current;
  if (order.status === 'CANCELLED') {
    // Same as Shopee's detectCancelledOrders: unclaimed just drops out; once a
    // station has it, it goes to Batal & Masalah.
    status = 'CANCELLED';
    if (session) {
      db.prepare("UPDATE packing_sessions SET status = 'EXCEPTION', needs_resolve = 1 WHERE id = ?").run(session.id);
      db.prepare('UPDATE orders SET cancel_needs_resolve = 1 WHERE order_sn = ?').run(order.id);
    }
    console.log(`[server] TikTok order ${order.id} was cancelled${session ? ' while already claimed' : ''} — removed from queue`);
  } else if (order.status === 'ON_HOLD') {
    if (untouched) status = 'ON_HOLD';
  } else if (OPEN_STATUSES.includes(order.status)) {
    if (current === 'ON_HOLD') status = 'READY_TO_PACK';
  } else if (SHIPPED_STATUSES.includes(order.status)) {
    // Shipped without KELPER (from Seller Center). One KELPER booked is left
    // to the Shipping Mode pickup scan, exactly like Shopee.
    if (untouched) status = SHIPPED_EXTERNAL;
  }

  // fulfillment_priority_level is absent while ON_HOLD, so this has to be
  // re-read on every update instead of being decided once at import.
  const isInstant = order.fulfillment_priority_level === INSTANT_PRIORITY_LEVEL ? 1 : 0;
  const flags = orderFlags(order);
  updateOrder.run(status, order.recipient_address?.name || null, order.shipping_provider || null, isInstant,
    order.status, flags, platform, order.packages?.length === 1 ? order.packages[0].id : null, order.id);

  // Items only while nobody is scanning them yet.
  if (!session && ['ON_HOLD', 'READY_TO_PACK'].includes(status)) {
    deleteItems.run(order.id);
    for (const item of groupLineItems(order.line_items)) {
      insertItem.run(order.id, item.sku, item.productName, item.qty, item.imageUrl, item.sku);
    }
  }

  // Can't be packed normally: straight to Batal & Masalah once TikTok releases
  // it, the same place a Shopee order goes when its booking keeps failing.
  const reason = masalahReason(flags);
  if (reason && status === 'READY_TO_PACK' && !session) flagOrderAsException(order.id, reason, 'Auto (TikTok)');
});

async function fetchChangedOrderIds(opts, updatedSince) {
  const ids = [];
  let pageToken = '';
  do {
    const query = { page_size: SEARCH_PAGE_SIZE };
    if (pageToken) query.page_token = pageToken;
    const page = await apiRequest('POST', '/order/202309/orders/search', { ...opts, query, body: { update_time_ge: updatedSince } });
    ids.push(...(page?.orders || []).map((o) => o.id));
    pageToken = page?.next_page_token || '';
  } while (pageToken);
  return ids;
}

async function syncShop(accessToken, shop) {
  const opts = { accessToken, shopCipher: shop.cipher };
  const cursorKey = `tiktokOrdersSyncedAt:${shop.shop_id}`;
  const startedAt = now();
  const updatedSince = Number(getSetting(cursorKey, startedAt - FIRST_SYNC_LOOKBACK_SECONDS + OVERLAP_SECONDS)) - OVERLAP_SECONDS;

  const ids = await fetchChangedOrderIds(opts, updatedSince);
  for (let i = 0; i < ids.length; i += DETAIL_BATCH_SIZE) {
    const batch = ids.slice(i, i + DETAIL_BATCH_SIZE);
    const detail = await apiRequest('GET', '/order/202507/orders', { ...opts, query: { ids: batch.join(',') } });
    for (const order of detail?.orders || []) saveOrder(order, shop.shop_id);
  }
  // Only after everything saved, so a failed tick retries the same window.
  setSetting(cursorKey, startedAt);
  if (ids.length > 0) console.log(`[server] TikTok: synced ${ids.length} changed order(s) (shop ${shop.shop_id})`);
}

// Request options for one connected TikTok shop (the first one when no id is
// given, or the id is unknown), or null when none is connected.
async function getTikTokOpts(tiktokShopId = null) {
  const shop = (tiktokShopId && db.prepare('SELECT cipher FROM tiktok_shops WHERE shop_id = ?').get(String(tiktokShopId)))
    || db.prepare('SELECT cipher FROM tiktok_shops LIMIT 1').get();
  return shop ? { accessToken: await getValidAccessToken(), shopCipher: shop.cipher } : null;
}

async function syncTikTokOrders() {
  const shops = db.prepare('SELECT shop_id, cipher FROM tiktok_shops').all();
  if (shops.length === 0) return;
  const accessToken = await getValidAccessToken();
  for (const shop of shops) {
    await syncShop(accessToken, shop);
  }
}

// Does nothing on an install without TikTok keys, i.e. the live app.
// Two loops, like shopeeSync.js: booking waits on TikTok for each label (up to
// ~40 s), and must never hold up noticing new or cancelled orders.
function startTikTokSync() {
  if (!isConfigured()) return;
  // An order imported before ON_HOLD got its own local status (2026-11-10).
  // And one imported before marketplace_shop_id existed: there was only one shop.
  const firstShop = db.prepare('SELECT shop_id FROM tiktok_shops LIMIT 1').get();
  if (firstShop) db.prepare("UPDATE orders SET marketplace_shop_id = ? WHERE platform != 'shopee' AND marketplace_shop_id IS NULL").run(String(firstShop.shop_id));
  db.prepare("UPDATE orders SET status = 'ON_HOLD' WHERE platform != 'shopee' AND status = 'READY_TO_PACK' AND marketplace_status = 'ON_HOLD' AND label_ready = 0 AND NOT EXISTS (SELECT 1 FROM packing_sessions ps WHERE ps.order_sn = orders.order_sn)").run();

  async function syncLoop() {
    try {
      await syncTikTokOrders();
    } catch (err) {
      console.error(`[server] TikTok order sync failed: ${err.tiktokCode ?? ''} ${err.message}`);
    }
    setTimeout(syncLoop, POLL_INTERVAL_MS);
  }
  async function bookingLoop() {
    try {
      detectLatePickups(); // local only, runs even while fetching is locked
      const shops = db.prepare('SELECT shop_id, cipher FROM tiktok_shops').all();
      if (shops.length > 0) {
        const accessToken = await getValidAccessToken();
        for (const shop of shops) {
          const opts = { accessToken, shopCipher: shop.cipher };
          if (isTikTokSyncEnabled()) await bookTikTokOrders(opts, shop.shop_id);
          await fillTikTokIncome(opts, shop.shop_id); // read-only, so also while locked
        }
      }
    } catch (err) {
      console.error(`[server] TikTok booking tick failed: ${err.tiktokCode ?? ''} ${err.message}`);
    }
    setTimeout(bookingLoop, BOOKING_INTERVAL_MS);
  }
  syncLoop();
  bookingLoop();
}

module.exports = { TIKTOK_SHOP_ID, SHIPPED_EXTERNAL, startTikTokSync, syncTikTokOrders, saveOrder, groupLineItems, getTikTokOpts, isTikTokSyncEnabled, setTikTokSyncEnabled };
