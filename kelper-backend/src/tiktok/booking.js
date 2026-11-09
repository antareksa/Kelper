const db = require('../db');
const { apiRequest } = require('./client');
const { getConfig } = require('../config');
const { getOrderDelaySeconds, isWithinWorkHour, getMaxReadyToCheck, getMaxConcurrentBookings } = require('../packingSettings');
const { priorityOrderBy } = require('../priorityOrder');
const { markBookingInFlight, flagOrderAsException, countReadyToCheck, mapWithConcurrency } = require('../shopeeSync');

// TikTok Shop / Tokopedia booking and label (2026-11-10, step 2 of the TikTok
// integration). The TikTok side of shopeeSync.js's bookAndLabelPendingOrders /
// bookDeferredOrders / bookOneOrder: same gating (work hour, order delay, the
// shared "Maks Siap Dicek" cap, no packing session yet), same failure counting
// and Masalah fallback, and it fills the same orders columns (tracking_no,
// label_pdf, label_ready, is_dropoff ...), so from here on the Packing Station
// treats the order exactly like a Shopee one.
//
// TikTok works per PACKAGE: order -> packages[0].id -> ship -> shipping_documents.
// Orders with more than one package never get here (orderSync.js sends them to
// Masalah).

const LABEL_TRIES = 8;
const LABEL_WAIT_MS = 5000; // the sandbox label was ready ~10 s after `ship`

function now() {
  return Math.floor(Date.now() / 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hhmmWIB(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
}

async function fetchOrder(opts, orderSn) {
  const detail = await apiRequest('GET', '/order/202507/orders', { ...opts, query: { ids: orderSn } });
  const order = detail?.orders?.[0];
  if (!order) throw new Error('order not found on TikTok');
  return order;
}

// Pickup when the courier offers it, drop-off ("Antar ke gerai") otherwise --
// the same rule as Shopee. The package-level handover_time_slots endpoint
// answers 105005 for this app; the order-level one works.
async function chooseHandover(opts, order) {
  const lineIds = (order.line_items || []).map((l) => l.id).join(',');
  const slots = await apiRequest('GET', `/fulfillment/202309/orders/${order.id}/handover_time_slots`, {
    ...opts,
    query: lineIds ? { order_line_item_ids: lineIds } : {},
  });
  if (slots?.can_pickup || !slots?.can_drop_off) {
    const slot = (slots?.pickup_slots || []).find((s) => s.avaliable !== false); // sic, TikTok's spelling
    return {
      body: { handover_method: 'PICKUP', ...(slot ? { pickup_slot: { start_time: slot.start_time, end_time: slot.end_time } } : {}) },
      pickupTimeLabel: slot ? `${hhmmWIB(slot.start_time)} - ${hhmmWIB(slot.end_time)}` : null,
    };
  }
  return { body: { handover_method: 'DROP_OFF' }, pickupTimeLabel: null };
}

async function downloadLabel(opts, packageId) {
  let lastError = null;
  for (let attempt = 1; attempt <= LABEL_TRIES; attempt += 1) {
    try {
      const doc = await apiRequest('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, {
        ...opts,
        query: { document_type: 'SHIPPING_LABEL', document_size: 'A6' },
      });
      if (!doc?.doc_url) throw new Error('no doc_url yet');
      // The URL is only valid for 24 hours, so the PDF itself is what's kept.
      const res = await fetch(doc.doc_url);
      if (!res.ok) throw new Error(`label download HTTP ${res.status}`);
      const pdf = Buffer.from(await res.arrayBuffer());
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('label download is not a PDF');
      return { pdf, trackingNumber: doc.tracking_number || null };
    } catch (err) {
      lastError = err;
      if (attempt < LABEL_TRIES) await sleep(LABEL_WAIT_MS);
    }
  }
  throw new Error(`shipping_documents failed: ${lastError?.tiktokCode ?? ''} ${lastError?.message}`.trim());
}

// Books (unless TikTok already has it booked) and downloads the label.
async function bookShipment(opts, orderSn) {
  const order = await fetchOrder(opts, orderSn);
  if (!['AWAITING_SHIPMENT', 'AWAITING_COLLECTION'].includes(order.status)) {
    throw new Error(`TikTok status is ${order.status}, not bookable`);
  }
  if ((order.packages || []).length !== 1) throw new Error(`order has ${(order.packages || []).length} packages`);
  const packageId = order.packages[0].id;

  let pickupTimeLabel = null;
  // AWAITING_COLLECTION = already booked (by an earlier try whose label step
  // failed, or in Seller Center): only the label is still needed.
  if (order.status === 'AWAITING_SHIPMENT') {
    const handover = await chooseHandover(opts, order);
    pickupTimeLabel = handover.pickupTimeLabel;
    await apiRequest('POST', `/fulfillment/202309/packages/${packageId}/ship`, { ...opts, body: handover.body });
  }

  const { pdf, trackingNumber } = await downloadLabel(opts, packageId);
  // What TikTok actually arranged: in the sandbox a DROP_OFF request came back
  // as PICKUP, so the method is read back rather than trusted from the request.
  const pkg = await apiRequest('GET', `/fulfillment/202309/packages/${packageId}`, opts);
  const resi = trackingNumber || pkg?.tracking_number;
  if (!resi) throw new Error('booked but TikTok returned no tracking number yet');
  return {
    trackingNumber: resi,
    pdf,
    packageId,
    isDropoff: pkg?.handover_method ? (pkg.handover_method === 'DROP_OFF' ? 1 : 0) : null,
    pickupTimeLabel,
    carrier: pkg?.shipping_provider_name || order.shipping_provider || null,
  };
}

const saveBooking = db.prepare(`
  UPDATE orders SET tracking_no = ?, label_pdf = ?, label_ready = 1, label_ready_at = ?, package_number = ?,
    pickup_time_label = COALESCE(?, pickup_time_label), is_dropoff = COALESCE(?, is_dropoff),
    shipping_carrier = COALESCE(?, shipping_carrier),
    booking_fail_count = 0, booking_first_failed_at = NULL, booking_last_error = NULL
  WHERE order_sn = ?
`);

async function bookOneOrder(opts, orderSn) {
  markBookingInFlight(orderSn, true);
  try {
    const b = await bookShipment(opts, orderSn);
    saveBooking.run(b.trackingNumber, b.pdf, now(), b.packageId, b.pickupTimeLabel, b.isDropoff, b.carrier, orderSn);
    console.log(`[server] TikTok bucket: ${orderSn} -> Ready to Check (booked${b.isDropoff ? ' for DROP-OFF' : ''}, tracking ${b.trackingNumber})`);
  } catch (err) {
    const message = `${err.tiktokCode ? `${err.tiktokCode} ` : ''}${err.message}`;
    const prior = db.prepare('SELECT booking_fail_count, booking_first_failed_at FROM orders WHERE order_sn = ?').get(orderSn);
    const failCount = (prior?.booking_fail_count ?? 0) + 1;
    const firstFailedAt = prior?.booking_first_failed_at ?? now();
    db.prepare('UPDATE orders SET booking_fail_count = ?, booking_first_failed_at = ?, booking_last_error = ? WHERE order_sn = ?')
      .run(failCount, firstFailedAt, message, orderSn);
    console.error(`[server] TikTok booking/labeling failed for order ${orderSn} (attempt ${failCount}): ${message}`);

    const { maxBookingFailures, minBookingFailureMinutes } = getConfig().shipping;
    if (maxBookingFailures > 0 && failCount >= maxBookingFailures && now() - firstFailedAt >= minBookingFailureMinutes * 60) {
      flagOrderAsException(orderSn, message);
    }
  } finally {
    markBookingInFlight(orderSn, false);
  }
}

// Fresh orders: the same eligibility as bookAndLabelPendingOrders. Orders still
// ON_HOLD at TikTok have local status 'ON_HOLD' (see orderSync.js), so the
// READY_TO_PACK filter already keeps them out.
async function bookPendingOrders(opts) {
  const normalOpen = isWithinWorkHour(false);
  const instantOpen = isWithinWorkHour(true);
  if (!normalOpen && !instantOpen) return;

  const normalCutoff = now() - getOrderDelaySeconds(false);
  const instantCutoff = now() - getOrderDelaySeconds(true);
  const ob = priorityOrderBy('o');
  let pending = db
    .prepare(`
      SELECT o.order_sn FROM orders o
      WHERE o.platform != 'shopee' AND o.status = 'READY_TO_PACK' AND o.label_ready = 0
        AND (o.delay_skip_at IS NOT NULL OR o.created_at <= CASE WHEN COALESCE(o.is_instant, 0) = 1 THEN ? ELSE ? END)
        AND CASE WHEN COALESCE(o.is_instant, 0) = 1 THEN ? ELSE ? END = 1
        AND NOT EXISTS (SELECT 1 FROM packing_sessions ps WHERE ps.order_sn = o.order_sn)
      ${ob.sql}
    `)
    .all(instantCutoff, normalCutoff, instantOpen ? 1 : 0, normalOpen ? 1 : 0, ...ob.params);

  const maxReadyToCheck = getMaxReadyToCheck();
  if (maxReadyToCheck > 0) {
    // shop_id 0 matches no Shopee shop; the count's platform clause covers TikTok.
    // Shopee's own count (shopeeSync.js) includes TikTok orders the same way.
    const shopeeShop = db.prepare('SELECT shop_id FROM shopee_tokens LIMIT 1').get()?.shop_id ?? 0;
    pending = pending.slice(0, Math.max(0, maxReadyToCheck - countReadyToCheck.get(shopeeShop).c));
  }
  if (pending.length === 0) return;
  await mapWithConcurrency(pending, getMaxConcurrentBookings(), ({ order_sn: orderSn }) => bookOneOrder(opts, orderSn));
}

// Pack Besok boxes (packed with only a temp barcode) waiting for their real
// label, the same as bookDeferredOrders.
async function bookDeferredOrders(opts) {
  if (!isWithinWorkHour()) return;
  const pending = db
    .prepare(`
      SELECT o.order_sn FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE ps.status = 'DEFERRED_READY' AND o.platform != 'shopee' AND o.label_ready = 0
      ORDER BY o.is_instant DESC, ps.last_activity_at ASC
    `)
    .all();
  if (pending.length === 0) return;
  await mapWithConcurrency(pending, getMaxConcurrentBookings(), ({ order_sn: orderSn }) => bookOneOrder(opts, orderSn));
}

async function bookTikTokOrders(opts) {
  // The same kill switch as Shopee's auto booking.
  if (!getConfig().sync.autoBookShipping) return;
  await bookPendingOrders(opts);
  await bookDeferredOrders(opts);
}

// Live status check for a Pack Besok box about to get its resi printed, the
// TikTok side of the Shopee get_order_detail recheck in routes/packing.js.
async function fetchTikTokOrderStatus(opts, orderSn) {
  return (await fetchOrder(opts, orderSn)).status;
}

module.exports = { bookTikTokOrders, bookShipment, fetchTikTokOrderStatus };
