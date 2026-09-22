const crypto = require('crypto');
const db = require('./db');
const { getValidAccessToken, getValidBrandAccessToken } = require('./shopee/tokenStore');
const { getOrderList, getOrderDetail, getPackageDetail, getChannelList, downloadShippingDocument, getEscrowDetail, getAllCpcAdsHourlyPerformance } = require('./shopee/client');
const { getShopAffiliatePerformance, getShopSalesPerformanceDetail } = require('./shopee/brandClient');
const { bookShipment, learnPackageNumber } = require('./shopee/shipping');
const { getConfig } = require('./config');
const { getSetting } = require('./settings');
const {
  getOrderDelaySeconds,
  getMaxConcurrentBookings,
  getMaxReadyToCheck,
  isWithinWorkHour,
} = require('./packingSettings');
const { dateStringWIB, dateStringDDMMYYYYWIB } = require('./wib');

function now() {
  return Math.floor(Date.now() / 1000);
}

const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (order_sn, shop_id, status, created_at)
  VALUES (?, ?, 'READY_TO_PACK', ?)
`);
const insertItem = db.prepare(`
  INSERT INTO order_items (order_sn, sku, product_name, qty)
  VALUES (?, ?, ?, ?)
`);

// Fetches the shop's logistics channels once per call and returns the set of
// channel ids whose name marks them as "Instant" delivery — used to give
// Instant orders top priority in NEXT_ORDER, per channel name rather than
// hardcoded sandbox ids (80053/80054) since those can differ per shop/region.
async function getInstantChannelIds(accessToken, shopId) {
  const result = await getChannelList(accessToken, shopId);
  const channels = result.response?.logistics_channel_list || [];
  return new Set(
    channels
      .filter((c) => /instant/i.test(c.logistics_channel_name || ''))
      .map((c) => c.logistics_channel_id)
  );
}

// Phase 1 — discover: pull new READY_TO_SHIP order numbers straight from
// get_order_list and insert them immediately. Deliberately does NOT wait on
// get_order_detail (item/SKU data) first — booking a shipment only needs the
// order_sn, so an order must never be blocked from shipping just because the
// detail call is slow, or (as seen against Shopee's sandbox) sometimes comes
// back empty for a while after an order is created. Item details are
// backfilled separately below, best-effort, retried every tick.
async function discoverNewOrders(accessToken, shopId) {
  console.log(`[server] checking for new orders (shop ${shopId})...`);
  const timeFrom = now() - 15 * 24 * 60 * 60; // Shopee caps create_time range at 15 days
  const listResult = await getOrderList(accessToken, shopId, {
    timeFrom,
    timeTo: now(),
    orderStatus: 'READY_TO_SHIP',
  });
  if (listResult.error) {
    console.error(`[server] get_order_list failed for shop ${shopId}: ${listResult.message || listResult.error}`);
    return;
  }

  // insertOrder is INSERT OR IGNORE — result.changes is 0 for an order we
  // already knew about, so this counts genuinely new orders only, not every
  // order_sn Shopee happens to return this tick (which is most of them,
  // every tick, since READY_TO_SHIP covers everything not yet shipped).
  let newCount = 0;
  for (const { order_sn: orderSn } of listResult.response.order_list || []) {
    const result = insertOrder.run(orderSn, Number(shopId), now());
    if (result.changes > 0) newCount += 1;
  }
  console.log(`[server] found ${newCount} new order(s) (shop ${shopId})`);

  await fillMissingOrderDetails(accessToken, shopId);
}

// Backfills item_list/buyer/logistics info for any local order that doesn't
// have items yet — whether it's brand new or an earlier attempt came back
// empty. Safe to retry indefinitely: an order is only ever selected here
// while it truly has zero order_items rows, so a later successful fetch
// can't double-insert. Never blocks booking/labeling, which only needs the
// order_sn and runs independently of whether this ever succeeds.
// order/get_order_detail has been confirmed (against Shopee support) to
// return an empty order_list for every order created in this shop over an
// extended window, while order/get_package_detail reliably returns the same
// item_list keyed by package_number instead. Orders that already have a
// package_number (learned as a side effect of booking — see shipping.js) use
// that path; anything without one yet falls back to get_order_detail, kept
// in case it starts working again.
function resolveProductName(itemId, modelId) {
  const item = db.prepare('SELECT name FROM shopee_items WHERE item_id = ?').get(itemId);
  if (!item) return null;
  const model = modelId
    ? db.prepare('SELECT model_name FROM shopee_item_models WHERE item_id = ? AND model_id = ?').get(itemId, modelId)
    : null;
  return model?.model_name && model.model_name !== item.name ? `${item.name} - ${model.model_name}` : item.name;
}

async function fillMissingOrderDetails(accessToken, shopId) {
  const missing = db
    .prepare(`
      SELECT order_sn, package_number, label_ready FROM orders
      WHERE shop_id = ? AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_items.order_sn = orders.order_sn)
    `)
    .all(shopId);
  if (missing.length === 0) return;

  // One-time backfill for orders that were already booked/labeled before
  // package_number started being captured — otherwise they'd be stuck
  // itemless forever, since bookAndLabelPendingOrders only ever books a
  // given order once (label_ready = 0 is what selects orders for it).
  for (const order of missing) {
    if (order.package_number || !order.label_ready) continue;
    const packageNumber = await learnPackageNumber(accessToken, shopId, order.order_sn).catch(() => null);
    if (packageNumber) {
      db.prepare('UPDATE orders SET package_number = ? WHERE order_sn = ?').run(packageNumber, order.order_sn);
      order.package_number = packageNumber;
    }
  }

  const withPackage = missing.filter((o) => o.package_number);
  const withoutPackage = missing.filter((o) => !o.package_number);

  if (withPackage.length > 0) {
    const pkgResult = await getPackageDetail(accessToken, shopId, withPackage.map((o) => o.package_number));
    if (pkgResult.error) {
      console.error(`[server] get_package_detail failed for shop ${shopId}: ${pkgResult.message || pkgResult.error}`);
    } else {
      const fillFromPackages = db.transaction((packages) => {
        for (const pkg of packages) {
          for (const item of pkg.item_list || []) {
            const sku = item.model_sku || item.item_sku || `ITEM-${item.item_id}`;
            const productName = resolveProductName(item.item_id, item.model_id) || sku;
            insertItem.run(pkg.order_sn, sku, productName, item.model_quantity);
          }
        }
      });
      fillFromPackages(pkgResult.response.package_list || []);
    }
  }

  if (withoutPackage.length === 0) return;

  const orderSns = withoutPackage.map((o) => o.order_sn);
  const detailResult = await getOrderDetail(accessToken, shopId, orderSns, 'item_list,buyer_username,order_status,package_list');
  if (detailResult.error) {
    console.error(`[server] get_order_detail failed for shop ${shopId}: ${detailResult.message || detailResult.error}`);
    return;
  }

  const returned = detailResult.response.order_list || [];
  if (returned.length < orderSns.length) {
    const stillMissing = orderSns.filter((sn) => !returned.some((o) => o.order_sn === sn));
    console.warn(`[server] get_order_detail returned nothing for ${stillMissing.length}/${orderSns.length} order(s) — will retry next tick: ${stillMissing.join(', ')}`);
  }

  const instantChannelIds = await getInstantChannelIds(accessToken, shopId).catch(() => new Set());

  const fillMany = db.transaction((orders) => {
    for (const order of orders) {
      for (const item of order.item_list || []) {
        const sku = item.model_sku || item.item_sku || `ITEM-${item.item_id}`;
        const productName = item.model_name ? `${item.item_name} - ${item.model_name}` : item.item_name;
        insertItem.run(order.order_sn, sku, productName, item.model_quantity_purchased);
      }

      const pkg = order.package_list?.[0];
      const channelId = pkg?.logistics_channel_id ?? null;
      db.prepare(`
        UPDATE orders SET buyer_name = ?, logistics_channel_id = ?, shipping_carrier = ?, is_instant = ?
        WHERE order_sn = ?
      `).run(order.buyer_username || null, channelId, pkg?.shipping_carrier || null, instantChannelIds.has(channelId) ? 1 : 0, order.order_sn);
    }
  });
  fillMany(returned);
}

// Runs `fn` over `items` with at most `limit` in flight at once (0/falsy =
// no cap, i.e. all at once — the original unbounded behavior). A simple
// worker-pool rather than chunking into batches of `limit`: chunking would
// leave idle slots whenever one item in a batch finishes faster than its
// batch-mates, since the whole batch has to finish before the next one
// starts. Mirrors Promise.allSettled's contract (never rejects; each result
// is fulfilled/rejected) so callers don't need two different result shapes
// depending on whether a limit is set.
async function mapWithConcurrency(items, limit, fn) {
  if (!limit || limit >= items.length) return Promise.allSettled(items.map(fn));

  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

const countReadyToCheck = db.prepare(`
  SELECT COUNT(*) as c FROM orders o
  WHERE o.shop_id = ? AND o.status = 'READY_TO_PACK' AND o.label_ready = 1
    AND NOT EXISTS (
      SELECT 1 FROM packing_sessions ps
      WHERE ps.order_sn = o.order_sn AND ps.status IN ('IN_PROGRESS', 'RESUMING', 'AWAITING_LABEL_SCAN', 'READY_FOR_PICKUP')
    )
`);

// Shared by both booking paths below: books the real shipment with Shopee
// (respects config.shipping.useMassShip) and downloads the label once,
// storing both locally. Idempotent and safe to retry — an order that fails
// here simply stays label_ready = 0 and gets picked up again next tick.
async function bookOneOrder(accessToken, shopId, orderSn) {
  try {
    const { trackingNumber, packageNumber } = await bookShipment(accessToken, shopId, orderSn);
    const docResult = await downloadShippingDocument(accessToken, shopId, orderSn, trackingNumber);
    if (!docResult.pdf) {
      throw new Error(`download_shipping_document failed: ${docResult.message || docResult.error || 'no pdf returned'}`);
    }

    db.prepare('UPDATE orders SET tracking_no = ?, label_pdf = ?, label_ready = 1, package_number = COALESCE(?, package_number) WHERE order_sn = ?')
      .run(trackingNumber, docResult.pdf, packageNumber, orderSn);
    console.log(`[server] bucket: ${orderSn} -> Ready to Check (booked, tracking ${trackingNumber})`);
  } catch (err) {
    console.error(`[server] booking/labeling failed for order ${orderSn}: ${err.message}`);
  }
}

// Phase 2 — book & label: for any local order still missing a label, book
// it now. This is what lets Packing Station never call Shopee at pack-time —
// it just reads what's already stored (or, per the client-requested
// 2026-09-22 work-hour redesign, packs first using a temp barcode and gets
// the real label later — see finalizeCompletedOrder/bookDeferredOrders).
//
// Gating, applied before any Shopee call:
//   - workHourStartHour/workHourEndHour: Shopee bookings only happen inside
//     this WIB window (default 08:00-16:00) — outside it, this is a no-op
//     entirely, and orders simply wait unlabeled (still claimable/packable —
//     see routes/packing.js's next-order).
//   - orderDelayMinutes: an order created less than this many minutes ago is
//     left alone entirely (shown as "Waiting List" — see routes/packing.js)
//     so the buyer has a real window to cancel before a shipment is committed.
//   - maxReadyToCheck: if the "Ready to Check" pool is already at/over this
//     cap, only book enough of the oldest eligible orders to fill the
//     remaining slots — the rest stay unlabeled until a station clears some
//     of the backlog, rather than piling up more printed labels than
//     stations can realistically work through.
async function bookAndLabelPendingOrders(accessToken, shopId) {
  if (!isWithinWorkHour()) return;

  const cutoff = now() - getOrderDelaySeconds();
  let pending = db
    .prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' AND label_ready = 0 AND created_at <= ? ORDER BY created_at ASC")
    .all(shopId, cutoff);

  const maxReadyToCheck = getMaxReadyToCheck();
  if (maxReadyToCheck > 0) {
    const slots = Math.max(0, maxReadyToCheck - countReadyToCheck.get(shopId).c);
    pending = pending.slice(0, slots);
  }
  if (pending.length === 0) return;

  // Concurrent, not sequential — confirmed via real production timing logs
  // that a single order's wait for Shopee to assign a tracking number
  // averages ~30s and can run close to a minute (see
  // pollTrackingAndDocument's trackingPoll). Awaiting one order fully
  // before starting the next meant order B never even began booking until
  // order A's entire wait finished — the same shape of problem as
  // discoverOnly being blocked by booking, just one level deeper. Safe to
  // parallelize: each iteration only ever reads/writes its own order_sn's
  // row. maxConcurrentBookings caps how many run at once (0 = unbounded).
  await mapWithConcurrency(pending, getMaxConcurrentBookings(), ({ order_sn: orderSn }) => bookOneOrder(accessToken, shopId, orderSn));
}

// Client-requested (2026-09-22): orders that were already fully packed (all
// items scanned) before ever getting a real Shopee label — either discovered
// outside work hour, or set aside as a leftover the previous day — sit as
// packing_sessions.status = 'DEFERRED_READY' with only a temp barcode
// (BESOK-XXXX, see PackingStation.jsx's printBesokLabel) stuck on the box.
// Once work hour opens, sweep these and book them for real: orders.status
// stays 'DEFERRED' and the session stays 'DEFERRED_READY' — this only fills
// in tracking_no/label_pdf/label_ready so next-order's leftover pool and
// resume-besok (both gated on label_ready = 1) find it ready to hand to a
// station for the temp-barcode-scan -> real-label-print -> confirm-scan flow.
async function bookDeferredOrders(accessToken, shopId) {
  if (!isWithinWorkHour()) return;

  const pending = db
    .prepare(`
      SELECT o.order_sn AS order_sn
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.shop_id = ? AND o.label_ready = 0
      ORDER BY ps.last_activity_at ASC
    `)
    .all(shopId);
  if (pending.length === 0) return;

  await mapWithConcurrency(pending, getMaxConcurrentBookings(), ({ order_sn: orderSn }) => bookOneOrder(accessToken, shopId, orderSn));
}

// Client-requested (2026-09-22): an order the buyer cancels (whether during
// the delay window above or any time before a station claims it) must
// disappear from Waiting List/Processing/Ready to Check on its own, not sit
// there looking actionable. The Push Mechanism (webhook.js) reacts fast when
// Shopee actually sends order_status_push, but Shopee's own guidance is that
// push can be delayed, duplicated, or dropped — so this periodic recheck is
// the safety net, run every enrichment tick against everything not yet
// claimed by a station. Reuses the same order_status field finalizeLeftover
// (routes/packing.js) already trusts for cancellation detection on resumed
// leftovers — just applied continuously instead of only at next-day resume.
const CANCELLATION_CHECK_BATCH_SIZE = 50; // Shopee's own cap on order_sn_list length
async function detectCancelledOrders(accessToken, shopId) {
  const unclaimed = db
    .prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' AND order_sn NOT LIKE 'MOCK-%'")
    .all(shopId)
    .map((o) => o.order_sn);
  if (unclaimed.length === 0) return;

  for (let i = 0; i < unclaimed.length; i += CANCELLATION_CHECK_BATCH_SIZE) {
    const batch = unclaimed.slice(i, i + CANCELLATION_CHECK_BATCH_SIZE);
    const detail = await getOrderDetail(accessToken, shopId, batch, 'order_status');
    if (detail.error) {
      console.error(`[server] get_order_detail (cancellation check) failed for shop ${shopId}: ${detail.message || detail.error}`);
      continue;
    }
    for (const order of detail.response?.order_list || []) {
      if (order.order_status === 'CANCELLED') {
        db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_sn = ?").run(order.order_sn);
        console.log(`[server] order ${order.order_sn} was cancelled by the buyer — removed from queue (shop ${shopId})`);
      }
    }
  }
}

const insertIncome = db.prepare(`
  INSERT OR REPLACE INTO order_income
    (order_sn, order_selling_price, escrow_amount, service_fee, commission_fee, seller_transaction_fee, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Phase 3 — real financials: once an order has actually shipped (label
// printed and pickup-confirmed), fetch what Shopee will really pay out for
// it via the escrow API and store it, so the Dashboard can show real Omzet/
// Laba/Layanan/Biaya Pesanan for that order instead of a catalog-price
// guess. Fetched exactly once per order (see order_income's own comment in
// db.js for why) — an order stuck on READY_TO_PACK/AWAITING_LABEL_SCAN
// never reaches this query, so it isn't retried into existence early.
async function fillMissingIncomeData(accessToken, shopId) {
  const pending = db
    .prepare(`
      SELECT order_sn FROM orders
      WHERE shop_id = ? AND status = 'READY_FOR_PICKUP' AND order_sn NOT LIKE 'MOCK-%'
        AND NOT EXISTS (SELECT 1 FROM order_income WHERE order_income.order_sn = orders.order_sn)
    `)
    .all(shopId);

  for (const { order_sn: orderSn } of pending) {
    const result = await getEscrowDetail(accessToken, shopId, orderSn).catch((err) => ({ error: 'network', message: err.message }));
    if (result.error) {
      // Not fatal — escrow data can simply not exist yet this soon after
      // shipping; leaving no order_income row means it's retried next tick.
      console.warn(`[server] get_escrow_detail failed for order ${orderSn} (shop ${shopId}): ${result.message || result.error} — will retry next tick`);
      continue;
    }

    const income = result.response?.order_income;
    if (!income) continue;
    insertIncome.run(
      orderSn,
      income.order_selling_price ?? null,
      income.escrow_amount ?? null,
      income.service_fee ?? null,
      income.commission_fee ?? null,
      income.seller_transaction_fee ?? null,
      now()
    );
  }
}

// Debug mode (config.json's debugMode) — fabricates orders through the same
// discover-then-book split as the real flow, without ever calling Shopee, so
// the whole pipeline (Processing -> Ready to Check -> ...) can be exercised
// and demoed on demand. Booking is deliberately deferred to the *next* tick
// rather than done immediately: booking pending orders runs first, then a
// new one is discovered, so a freshly-created mock order visibly sits in
// Processing for one full poll interval before becoming Ready to Check,
// instead of the two states collapsing into the same instant.
const MOCK_ITEMS = [
  { sku: 'MOCK-SKU-1', product_name: 'Mock Product A', qty: 2 },
  { sku: 'MOCK-SKU-2', product_name: 'Mock Product B', qty: 1 },
];

// Prefers real synced Shopee products (List Barang) when available, so
// testing the scanner means scanning an actual product's real printed
// barcode — not a fake SKU nobody has a label for. Items with a known
// barcode (imported via the HPP Excel) sort first; falls back to the static
// MOCK_ITEMS only if nothing has been synced yet.
function pickDebugOrderItems(shopId) {
  const rows = db
    .prepare(`
      SELECT
        COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id) AS sku,
        CASE WHEN m.model_name IS NOT NULL AND m.model_name != i.name
             THEN i.name || ' - ' || m.model_name
             ELSE i.name END AS product_name,
        p.barcode AS barcode
      FROM shopee_item_models m
      JOIN shopee_items i ON i.item_id = m.item_id
      LEFT JOIN products p ON p.sku = COALESCE(m.model_sku, i.item_sku, 'ITEM-' || i.item_id)
      WHERE i.shop_id = ? AND i.item_status = 'NORMAL'
      ORDER BY (p.barcode IS NOT NULL) DESC
    `)
    .all(shopId);

  if (rows.length === 0) return MOCK_ITEMS;
  return rows.slice(0, 3).map((r) => ({ sku: r.sku, product_name: r.product_name, qty: 1 }));
}

// Matches the default thermal label size (100mm x 120mm) used by the
// station's Test Print feature, converted to PDF points (1mm = 72/25.4pt).
const MM_TO_PT = 72 / 25.4;
const LABEL_WIDTH_PT = Math.round(100 * MM_TO_PT);
const LABEL_HEIGHT_PT = Math.round(120 * MM_TO_PT);

// Same Code 39 table used for the operator-badge and hardware-check barcodes
// on the frontend (see Barcode.jsx) — duplicated here rather than shared
// since this side draws PDF rectangles directly instead of SVG.
const CODE39_PATTERNS = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
  'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000',
  'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
  'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110',
  'S': '001000110', 'T': '000010110', 'U': '110000001', 'V': '011000001',
  'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
};

// Draws a Code 39 barcode as filled PDF rectangles, scaled so it always fits
// exactly within `width` pt regardless of value length — every Code 39
// character is 6 narrow + 3 wide elements plus a 1-narrow inter-character
// gap, i.e. 14.5 narrow-widths per character (wide = 2.5x narrow).
function code39PdfOps(value, { x, y, width, height }) {
  const full = `*${value.toUpperCase()}*`;
  const narrow = width / (full.length * 14.5);
  const wide = narrow * 2.5;

  let cursorX = x;
  const ops = [];
  for (const char of full) {
    const pattern = CODE39_PATTERNS[char];
    if (!pattern) continue; // unsupported character — skip rather than break the whole barcode
    for (let i = 0; i < pattern.length; i += 1) {
      const w = pattern[i] === '1' ? wide : narrow;
      if (i % 2 === 0) ops.push(`${cursorX.toFixed(2)} ${y} ${w.toFixed(2)} ${height} re f`);
      cursorX += w;
    }
    cursorX += narrow;
  }
  return ops.join('\n');
}

// Builds a tiny valid PDF from scratch (no external deps) so debug-mode
// "labels" flow through the same print/reprint/download paths as a real
// Shopee label. Barcode encodes the order id, not the tracking number — a
// real Shopee label's scannable barcode is the order id ("No. Pesanan"), and
// /packing/confirm-pickup checks against order_sn accordingly.
function buildMockPdf(orderSn, trackingNo) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 ${LABEL_WIDTH_PT} ${LABEL_HEIGHT_PT}] >>`,
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // filled in below (needs the stream length)
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const margin = 20;
  const barcodeHeight = 60;
  const barcodeY = LABEL_HEIGHT_PT - 110;
  const barcodeOps = code39PdfOps(orderSn, { x: margin, y: barcodeY, width: LABEL_WIDTH_PT - margin * 2, height: barcodeHeight });

  const stream = [
    `BT /F1 14 Tf ${margin} ${LABEL_HEIGHT_PT - 40} Td (MOCK LABEL) Tj ET`,
    barcodeOps,
    `BT /F1 11 Tf ${margin} ${barcodeY - 16} Td (${orderSn}) Tj ET`,
    `BT /F1 9 Tf ${margin} ${barcodeY - 32} Td (Tracking: ${trackingNo}) Tj ET`,
  ].join('\n');
  objects[3] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((content, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${content}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(body, 'latin1');
}

// "Discover" — a bare order row, exactly like discoverNewOrders inserts for
// a real one: status READY_TO_PACK, label_ready 0, nothing else. Shows up in
// the Processing list immediately.
function createDebugOrder(shopId) {
  const orderSn = `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  db.prepare(`
    INSERT INTO orders (order_sn, shop_id, status, buyer_name, created_at)
    VALUES (?, ?, 'READY_TO_PACK', 'Debug Buyer', ?)
  `).run(orderSn, shopId, now());
  return orderSn;
}

// "Book & label" — the debug-mode equivalent of bookAndLabelPendingOrders +
// fillMissingOrderDetails combined into one step, since there's no real
// Shopee call to separately retry here.
function bookDebugOrder(orderSn, shopId) {
  const trackingNo = `MOCKTRACK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const labelPdf = buildMockPdf(orderSn, trackingNo);
  db.prepare('UPDATE orders SET tracking_no = ?, label_pdf = ?, label_ready = 1 WHERE order_sn = ?')
    .run(trackingNo, labelPdf, orderSn);
  for (const item of pickDebugOrderItems(shopId)) {
    db.prepare('INSERT INTO order_items (order_sn, sku, product_name, qty) VALUES (?, ?, ?, ?)')
      .run(orderSn, item.sku, item.product_name, item.qty);
  }
}

function runDebugTick(shopId) {
  const pending = db
    .prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' AND label_ready = 0 AND order_sn LIKE 'MOCK-%'")
    .all(shopId);
  for (const { order_sn: orderSn } of pending) {
    bookDebugOrder(orderSn, shopId);
    console.log(`[server] DEBUG MODE — booked mock order ${orderSn} (shop ${shopId})`);
  }

  const orderSn = createDebugOrder(shopId);
  console.log(`[server] DEBUG MODE — discovered mock order ${orderSn} (shop ${shopId})`);
}

// Cleans up mock orders left behind by a previous debugMode session —
// switching debugMode off mid-test otherwise leaves them sitting in
// 'READY_TO_PACK' (booked or not), and nothing downstream tells them apart
// from a genuine Shopee order:
//   - still label_ready = 0: bookAndLabelPendingOrders/fillMissingOrderDetails
//     would call the real Shopee API with a fake order_sn like
//     MOCK-A1B2C3D4, which fails every tick forever (both functions
//     deliberately leave a failure at label_ready = 0 to retry next time).
//   - already label_ready = 1: Packing Station's /next-order picks its
//     "fresh" orders with a plain `status = 'READY_TO_PACK' AND label_ready
//     = 1` query — it has no debugMode awareness at all, so a fully-booked
//     mock order sits right there in the real pool and gets handed to an
//     operator exactly like a real one.
// Any order still 'READY_TO_PACK' is by definition unclaimed — /next-order
// flips it to 'LOCKED' the moment a station takes it — so it's always safe
// to delete regardless of label_ready.
function purgeStaleMockOrders(shopId) {
  const stale = db
    .prepare("SELECT order_sn FROM orders WHERE shop_id = ? AND status = 'READY_TO_PACK' AND order_sn LIKE 'MOCK-%'")
    .all(shopId);
  if (stale.length === 0) return;

  const purge = db.transaction((orderSns) => {
    for (const orderSn of orderSns) {
      db.prepare('DELETE FROM order_items WHERE order_sn = ?').run(orderSn);
      db.prepare('DELETE FROM orders WHERE order_sn = ?').run(orderSn);
    }
  });
  purge(stale.map((o) => o.order_sn));
  console.log(`[server] purged ${stale.length} stale mock order(s) left over from debug mode (shop ${shopId})`);
}

// Order fetching defaults to OFF — an admin explicitly starts it from the
// Order Lists screen once they're ready, rather than it silently running
// the moment a server boots. Gates both the timer-driven loop below AND the
// manual /orders/sync endpoint (Packing Station's own periodic call included)
// since they share this one function — a "pause" that only stopped one of
// the two callers wouldn't actually stop fetching.
function isSyncEnabled() {
  return getSetting('syncEnabled', 'false') === 'true';
}

// Fast half of the sync: discovers new orders and backfills their item
// details. Deliberately excludes booking (see bookAndEnrichOnly below) —
// ship_order can block for up to ~60s per order waiting on Shopee's own
// tracking-number assignment (see shipping.js's trackingPoll), and since
// the old code awaited booking in the same loop as discovery, a single slow
// booking delayed noticing every OTHER brand new order behind it by that
// same ~60s, even though pollIntervalMs said 5s. Confirmed directly against
// production logs: a 46s gap between two "found new order(s)" lines with a
// booking sitting in between them.
async function discoverOnly(shopId) {
  if (!isSyncEnabled()) return;

  if (getConfig().debugMode) {
    return runDebugTick(shopId);
  }

  purgeStaleMockOrders(shopId);
  const accessToken = await getValidAccessToken(shopId);
  await discoverNewOrders(accessToken, shopId);
}

// Slow half: booking/labeling plus real-financial enrichment (escrow). Runs
// on its own independent schedule (see startShopeeSync) so it can never
// delay discoverOnly above from picking up the next new order.
async function bookAndEnrichOnly(shopId) {
  if (!isSyncEnabled() || getConfig().debugMode) return;

  const accessToken = await getValidAccessToken(shopId);
  // Kill switch for the auto ship_order/label step — config.json's
  // sync.autoBookShipping, editable without a restart.
  if (getConfig().sync.autoBookShipping) {
    await bookAndLabelPendingOrders(accessToken, shopId);
    await bookDeferredOrders(accessToken, shopId);
  }
  await detectCancelledOrders(accessToken, shopId);
  await fillMissingIncomeData(accessToken, shopId);
}

// Full sync in one call, used by the manual /orders/sync trigger and the
// Shopee Push Mechanism webhook — both want a single on-demand "do
// everything now", unlike the background loop below which deliberately
// splits discovery and booking onto independent schedules.
async function syncAndLabelOrders(shopId) {
  await discoverOnly(shopId);
  await bookAndEnrichOnly(shopId);
}

const insertAffiliatePerformance = db.prepare(`
  INSERT OR REPLACE INTO affiliate_performance_daily
    (shop_id, date, sales_confirmed, orders_confirmed, buyers_confirmed, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Fetches YESTERDAY's Affiliasi summary once per shop per day — Shopee's own
// data has a 1-day reporting lag (today's figures error with "end_date is
// not ready"), so there's nothing to gain from checking more often than
// once a day, and once fetched a past day's numbers don't change. Runs
// independently of the main order-sync's isSyncEnabled pause toggle — this
// has nothing to do with order fetching, and pausing one shouldn't silently
// pause the other.
async function fetchAffiliatePerformance(shopId) {
  const yesterday = dateStringWIB(1);
  const already = db
    .prepare('SELECT 1 FROM affiliate_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, yesterday);
  if (already) return;

  const accessToken = await getValidBrandAccessToken(shopId);
  const result = await getShopAffiliatePerformance(accessToken, shopId, {
    startDate: yesterday,
    endDate: yesterday,
    timezone: 'GMT+7',
    granularity: 'day',
  });
  if (result.error) {
    console.error(`[server] get_shop_affiliate_performance failed for shop ${shopId}: ${result.message || result.error}`);
    return;
  }

  // An empty summary means Shopee has nothing to report (no affiliate
  // orders that day) — genuinely zero, not "not fetched yet". Storing a
  // zeroed row either way is what lets the Dashboard tell "connected, zero
  // activity" apart from "never fetched" (no row at all).
  const summary = result.response?.summary?.[0] || { sales_confirmed: 0, orders_confirmed: 0, buyers_confirmed: 0 };
  insertAffiliatePerformance.run(shopId, yesterday, summary.sales_confirmed ?? 0, summary.orders_confirmed ?? 0, summary.buyers_confirmed ?? 0, now());
}

const insertShopPerformance = db.prepare(`
  INSERT OR REPLACE INTO shop_performance_daily (shop_id, date, unique_visitors, fetched_at)
  VALUES (?, ?, ?, ?)
`);

// Fetches YESTERDAY's Pengunjung (unique_visitors) once per shop per day —
// same 1-day reporting lag and once-daily reasoning as fetchAffiliatePerformance
// above, just a different Brand Portal endpoint.
async function fetchShopPerformance(shopId) {
  const yesterday = dateStringWIB(1);
  const already = db
    .prepare('SELECT 1 FROM shop_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, yesterday);
  if (already) return;

  const accessToken = await getValidBrandAccessToken(shopId);
  const result = await getShopSalesPerformanceDetail(accessToken, shopId, {
    startDate: yesterday,
    endDate: yesterday,
    timezone: 'GMT+7',
    granularity: 'day',
  });
  if (result.error) {
    console.error(`[server] get_shop_sales_performance_detail failed for shop ${shopId}: ${result.message || result.error}`);
    return;
  }

  const summary = result.response?.summary?.[0] || { unique_visitors: 0 };
  insertShopPerformance.run(shopId, yesterday, summary.unique_visitors ?? 0, now());
}

const ADS_REFETCH_INTERVAL_SECONDS = 5 * 60;
const insertAdsPerformance = db.prepare(`
  INSERT OR REPLACE INTO ads_performance_daily (shop_id, date, expense, fetched_at)
  VALUES (?, ?, ?, ?)
`);

// Fetches TODAY's Iklan (ad expenditure) — unlike the two Brand Portal
// fetches above, this one covers today and is refetched periodically
// through the day (every ADS_REFETCH_INTERVAL_SECONDS) since ad spend
// keeps accruing, not once-and-done. Uses the main app's own token (Ads
// Performance is a "Seller In House System" permission, not Brand Portal),
// via the hourly endpoint since the daily one rejects start_date ==
// end_date (today).
async function fetchAdsPerformance(shopId) {
  const today = dateStringWIB(0);
  const existing = db
    .prepare('SELECT fetched_at FROM ads_performance_daily WHERE shop_id = ? AND date = ?')
    .get(shopId, today);
  if (existing && now() - existing.fetched_at < ADS_REFETCH_INTERVAL_SECONDS) return;

  const accessToken = await getValidAccessToken(shopId);
  const result = await getAllCpcAdsHourlyPerformance(accessToken, shopId, dateStringDDMMYYYYWIB(0));
  if (result.error) {
    console.error(`[server] get_all_cpc_ads_hourly_performance failed for shop ${shopId}: ${result.message || result.error}`);
    return;
  }

  const totalExpense = (result.response || []).reduce((sum, hour) => sum + (hour.expense || 0), 0);
  insertAdsPerformance.run(shopId, today, totalExpense, now());
}

// Runs inside the Dashboard Station's server process (see server.js) — the
// background loop that keeps local order/shipment data in sync with Shopee,
// independent of whatever the Dashboard or any Packing Station happens to
// be doing at the time.
//
// Two INDEPENDENT self-rescheduling loops, not one — discovery must never
// wait behind booking. Each loop only schedules its own next run after its
// own work finishes, so a slow iteration only ever delays itself, never the
// other loop.
function startShopeeSync() {
  async function discoveryLoop() {
    const shops = db.prepare('SELECT shop_id FROM shopee_tokens').all();
    for (const { shop_id: shopId } of shops) {
      try {
        await discoverOnly(shopId);
      } catch (err) {
        console.error(`[server] discovery tick failed for shop ${shopId}: ${err.message}`);
      }
    }
    setTimeout(discoveryLoop, getConfig().sync.pollIntervalMs);
  }

  async function enrichmentLoop() {
    const shops = db.prepare('SELECT shop_id FROM shopee_tokens').all();
    for (const { shop_id: shopId } of shops) {
      try {
        await bookAndEnrichOnly(shopId);
      } catch (err) {
        console.error(`[server] booking/enrichment tick failed for shop ${shopId}: ${err.message}`);
      }
    }

    const brandShops = db.prepare('SELECT shop_id FROM shopee_brand_tokens').all();
    for (const { shop_id: shopId } of brandShops) {
      try {
        await fetchAffiliatePerformance(shopId);
      } catch (err) {
        console.error(`[server] Affiliasi fetch failed for shop ${shopId}: ${err.message}`);
      }
      try {
        await fetchShopPerformance(shopId);
      } catch (err) {
        console.error(`[server] Pengunjung fetch failed for shop ${shopId}: ${err.message}`);
      }
    }

    // Ads spend uses the main app's own token, independent of the order-sync
    // pause toggle and of whether Brand Portal is connected at all.
    for (const { shop_id: shopId } of shops) {
      try {
        await fetchAdsPerformance(shopId);
      } catch (err) {
        console.error(`[server] Iklan fetch failed for shop ${shopId}: ${err.message}`);
      }
    }

    setTimeout(enrichmentLoop, getConfig().sync.pollIntervalMs);
  }

  discoveryLoop();
  enrichmentLoop();
}

module.exports = { syncAndLabelOrders, startShopeeSync };
