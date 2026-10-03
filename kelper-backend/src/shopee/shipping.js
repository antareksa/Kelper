const {
  getOrderDetail,
  getShippingParameter,
  getMassShippingParameter,
  shipOrder,
  massShipOrder,
  getTrackingNumber,
  createShippingDocument,
  getShippingDocumentResult,
} = require('./client');
const { getConfig } = require('../config');

// Client-reported (2026-09-27): different couriers' labels were coming out
// in different layouts/sizes because create_shipping_document was never told
// which template to use, so Shopee fell back to each courier's own default.
// Forcing thermal everywhere makes every label consistent regardless of
// courier — but requesting it directly fails outright for some couriers
// (confirmed for SPX Instant/SPX Instant Prioritas) with
// logistics.shipping_document_should_print_first ("please create shipping
// document first"). get_shipping_document_parameter's own
// selectable_shipping_document_type list can't be trusted to predict this —
// it claimed THERMAL_AIR_WAYBILL was selectable for that exact channel and
// was wrong. Confirmed empirically instead: creating NORMAL_AIR_WAYBILL
// first (cheap, ~2s) unblocks THERMAL_AIR_WAYBILL right after, for every
// courier tried — so bootstrap with NORMAL first, always, then request the
// real preferred type on top of it.
const BOOTSTRAP_SHIPPING_DOCUMENT_TYPE = 'NORMAL_AIR_WAYBILL';
const PREFERRED_SHIPPING_DOCUMENT_TYPE = 'THERMAL_AIR_WAYBILL';

// Requests one shipping_document_type and waits for it to become READY.
// Bails out immediately on a fail_error entry instead of burning the whole
// poll window — a rejection like shipping_document_should_print_first is
// permanent, not transient, confirmed by it appearing identically on every
// one of 15 checks in testing.
async function createAndAwaitDocument(accessToken, shopId, orderSn, trackingNumber, type, cfg) {
  const createResult = await createShippingDocument(accessToken, shopId, orderSn, trackingNumber, type);
  if (createResult.error) {
    return { ok: false, error: `create_shipping_document(${type}) failed: ${createResult.message || createResult.error}` };
  }

  const { maxAttempts, delayMs } = cfg.documentPoll;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    const status = await getShippingDocumentResult(accessToken, shopId, orderSn, trackingNumber);
    const entry = status.response?.result_list?.[0];
    if (entry?.status === 'READY') return { ok: true };
    if (entry?.fail_error) return { ok: false, error: `${entry.fail_error}: ${entry.fail_message}` };
  }
  return { ok: false, error: `shipping_document_type=${type} did not become ready in time` };
}

// Auto-picks the shop's default pickup address and the recommended time slot,
// matching the doc's intent that operators don't manually choose logistics options.
// pickupLabel (slot.time_text, e.g. "Now" or "16:00 - 17:00") is for our own
// bookkeeping only (see orders.pickup_time_label) -- callers must strip it
// before sending this to ship_order/mass_ship_order, which only expect
// address_id and pickup_time_id. Deliberately NOT slot.date: confirmed
// empirically that every slot in a day shares the identical `date` value
// regardless of its actual hour, so it's a per-day anchor, not the slot's
// real time -- time_text is the only field that's actually accurate.
function pickPickupOption(pickup) {
  if (!pickup || !pickup.address_list?.length) {
    throw new Error('No pickup address configured for this shop');
  }
  const address = pickup.address_list.find((a) => a.address_flag?.includes('default_address')) || pickup.address_list[0];
  const slot = address.time_slot_list.find((s) => s.flags?.includes('recommended')) || address.time_slot_list[0];
  if (!slot) throw new Error('No pickup time slot available for this order');
  return { address_id: address.address_id, pickup_time_id: slot.pickup_time_id, pickupLabel: slot.time_text };
}

// Client-reported (2026-10-03), confirmed against two real SiCepat REG orders
// on the live shop: for some couriers Shopee offers NO pickup at all
// ({info_needed:{dropoff:[]}, dropoff:{branch_list:[]}}, no `pickup` key) --
// the seller takes the parcel to the courier's counter instead of waiting for
// a pickup. The shop does have a pickup address; that courier simply doesn't
// do pickup, so this was previously misreported as "no pickup address".
//
// info_needed.dropoff lists what ship_order's `dropoff` object must carry.
// Empty (as seen) means `dropoff: {}`. branch_id can be satisfied from the
// listed branches; anything else (sender_real_name, tracking_no) needs a value
// KELPER doesn't have, so it fails loudly with the field name instead of
// guessing -- that lands the order in Masalah with a readable reason.
function pickDropoffOption(response) {
  const dropoff = {};
  for (const field of response?.info_needed?.dropoff || []) {
    if (field === 'branch_id') {
      const branch = response.dropoff?.branch_list?.[0];
      if (!branch) throw new Error('Drop-off needs a branch but Shopee listed none for this order');
      dropoff.branch_id = branch.branch_id;
    } else {
      throw new Error(`Drop-off needs "${field}", which KELPER cannot supply yet`);
    }
  }
  return dropoff;
}

// Pickup stays the first choice whenever Shopee offers it; drop-off is only
// used when pickup isn't available. pickupLabel is null for drop-off (there is
// no scheduled courier window).
function pickShippingMethod(response) {
  if (response?.pickup?.address_list?.length) {
    const { pickupLabel, ...pickup } = pickPickupOption(response.pickup);
    return { isDropoff: false, pickup, pickupLabel };
  }
  if (response?.dropoff !== undefined || response?.info_needed?.dropoff !== undefined) {
    return { isDropoff: true, dropoff: pickDropoffOption(response), pickupLabel: null };
  }
  throw new Error('Shopee offers neither pickup nor drop-off for this order');
}

// Shared by both booking paths below: once ship_order/mass_ship_order has
// booked the shipment, Shopee needs a moment before the tracking number and
// the label document are actually ready — poll rather than assuming either is
// ready immediately. Poll counts/delays are config-driven (config.json) so
// they can be tuned without a code change if sandbox/production latency differs.
async function pollTrackingAndDocument(accessToken, shopId, orderSn, cfg) {
  const { maxAttempts: trackAttempts, delayMs: trackDelay } = cfg.trackingPoll;
  const pollStartedAt = Date.now();
  let trackingNumber = '';
  let attemptsUsed = 0;
  for (let attempt = 0; attempt < trackAttempts && !trackingNumber; attempt += 1) {
    attemptsUsed = attempt + 1;
    if (attempt > 0) await new Promise((r) => setTimeout(r, trackDelay));
    const trackingResult = await getTrackingNumber(accessToken, shopId, orderSn);
    if (trackingResult.error) {
      throw new Error(`get_tracking_number failed: ${trackingResult.message || trackingResult.error}`);
    }
    trackingNumber = trackingResult.response.tracking_number;
  }
  if (!trackingNumber) throw new Error('Tracking number was not assigned in time');
  // Temporary observability: how long Shopee actually takes to assign a
  // tracking number after booking, in practice — nothing logged this
  // before, so there was no way to answer "what's the average" without
  // guessing. Remove once we've gathered enough real samples.
  console.log(`[server] tracking number assigned for ${orderSn} after ${Date.now() - pollStartedAt}ms (${attemptsUsed} attempt(s))`);

  const bootstrap = await createAndAwaitDocument(accessToken, shopId, orderSn, trackingNumber, BOOTSTRAP_SHIPPING_DOCUMENT_TYPE, cfg);
  if (!bootstrap.ok) {
    throw new Error(`Shipping document bootstrap (${BOOTSTRAP_SHIPPING_DOCUMENT_TYPE}) failed: ${bootstrap.error}`);
  }

  const preferred = await createAndAwaitDocument(accessToken, shopId, orderSn, trackingNumber, PREFERRED_SHIPPING_DOCUMENT_TYPE, cfg);
  let documentType = BOOTSTRAP_SHIPPING_DOCUMENT_TYPE;
  if (preferred.ok) {
    documentType = PREFERRED_SHIPPING_DOCUMENT_TYPE;
  } else {
    // Bootstrap already succeeded, so there's a real, usable document
    // (just not the preferred layout) — falling back to it beats throwing
    // away a working booking over a cosmetic preference.
    console.warn(`[server] ${orderSn}: ${PREFERRED_SHIPPING_DOCUMENT_TYPE} failed after successful ${BOOTSTRAP_SHIPPING_DOCUMENT_TYPE} bootstrap (${preferred.error}) — falling back to ${BOOTSTRAP_SHIPPING_DOCUMENT_TYPE}`);
  }

  return { trackingNumber, documentType };
}

// "Package <number> not eligible for rescheduling" is what get_shipping_parameter
// says once a package already exists for an order — that message is the only
// place Shopee's API actually hands us the package_number (ship_order's own
// success response never includes it, confirmed against the sandbox). Used
// both to detect "already booked" and to harvest the number itself, which
// get_package_detail then uses as a working substitute for the item_list
// that order/get_order_detail has been failing to return for new orders.
const PACKAGE_NUMBER_PATTERN = /Package (\S+) not eligible for rescheduling/i;

// ship_order itself can also report "already booked", worded differently
// from get_shipping_parameter's message above — seen in practice from a race
// between the server's own retry and a concurrent manual booking attempt
// on the same order. Without recognizing this, that order would throw here
// forever: get_shipping_parameter would keep succeeding (nothing pending to
// reject), ship_order would keep hitting this same rejection, and label_ready
// would never become true.
const ALREADY_SHIPPED_PATTERN = /already\s*(been\s*)?shipped/i;

// Client-reported (2026-09-27), confirmed against a real SPX Instant Prioritas
// order: some couriers get their logistics request auto-created by Shopee
// itself (order_status already PROCESSED, package_list already populated)
// before we ever call ship_order — no seller-scheduled pickup involved, unlike
// normal couriers. ship_order rejects this with a THIRD wording that's neither
// of the two patterns above, and critically get_shipping_parameter does NOT
// flag it as already-booked either (it keeps returning fresh pickup slots),
// so without this check the order retried ship_order forever and never
// progressed to tracking/label.
const NOT_READY_TO_SHIP_PATTERN = /not ready to ship/i;

// Confirms via get_order_detail whether a package already exists for this
// order (the ground truth ship_order itself won't hand us directly) — used
// as a fallback once ship_order rejects, not called on every attempt, since
// the vast majority of orders don't need this extra round trip.
async function findExistingPackageNumber(accessToken, shopId, orderSn) {
  const detail = await getOrderDetail(accessToken, shopId, [orderSn], 'package_list');
  return detail.response?.order_list?.[0]?.package_list?.[0]?.package_number ?? null;
}

// Single-order path: get_shipping_parameter -> ship_order.
//
// Idempotent by design: if a previous attempt already called ship_order (e.g. a
// crash happened between booking and printing), get_shipping_parameter will
// reject with "not eligible for rescheduling" since the package already exists —
// that's treated as "already booked" and we skip straight to tracking/printing,
// rather than failing or trying to ship_order a second time.
async function bookShipmentSingle(accessToken, shopId, orderSn, cfg) {
  const shippingParam = await getShippingParameter(accessToken, shopId, orderSn);
  const alreadyBookedMatch = shippingParam.error ? shippingParam.message?.match(PACKAGE_NUMBER_PATTERN) : null;

  if (shippingParam.error && !alreadyBookedMatch) {
    throw new Error(`get_shipping_parameter failed: ${shippingParam.message || shippingParam.error}`);
  }

  let packageNumber = alreadyBookedMatch?.[1] ?? null;
  let pickupTimeLabel = null;
  // null = not decided by this call (the package already existed, e.g. it was
  // arranged in Seller Center), so whatever is already stored is left alone.
  let isDropoff = null;

  if (!alreadyBookedMatch) {
    // pickupLabel can genuinely be undefined -- confirmed against a real
    // order that Shopee sometimes omits time_text entirely from a slot
    // (just date/pickup_time_id/flags, no label). Stored as plain NULL
    // (better-sqlite3 binds undefined as NULL), which the dashboard already
    // shows as "—" — not a bug, just an occasional gap in Shopee's own data.
    const method = pickShippingMethod(shippingParam.response);
    pickupTimeLabel = method.pickupLabel;
    isDropoff = method.isDropoff;
    const shipResult = await shipOrder(accessToken, shopId, {
      order_sn: orderSn,
      ...(method.isDropoff ? { dropoff: method.dropoff } : { pickup: method.pickup }),
    });

    if (shipResult.error) {
      const alreadyShipped = ALREADY_SHIPPED_PATTERN.test(shipResult.message || '');
      const notReadyToShip = NOT_READY_TO_SHIP_PATTERN.test(shipResult.message || '');

      if (notReadyToShip) {
        const existing = await findExistingPackageNumber(accessToken, shopId, orderSn);
        if (!existing) throw new Error(`ship_order failed: ${shipResult.message || shipResult.error}`);
        packageNumber = existing;
        console.log(`[server] ${orderSn}: package ${existing} already auto-arranged by courier — skipping ship_order`);
      } else if (!alreadyShipped) {
        throw new Error(`ship_order failed: ${shipResult.message || shipResult.error}`);
      }
    }

    if (!packageNumber) {
      // Deliberately re-trigger the "already booked" error we just handled
      // above (or that ship_order just reported directly), purely to read the
      // package_number out of its message.
      const recheck = await getShippingParameter(accessToken, shopId, orderSn);
      packageNumber = recheck.message?.match(PACKAGE_NUMBER_PATTERN)?.[1] ?? null;
    }
  }

  const { trackingNumber, documentType } = await pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
  return { trackingNumber, packageNumber, documentType, pickupTimeLabel, isDropoff };
}

// Mass-shipping path: get_mass_shipping_parameter -> mass_ship_order.
// Confirmed against the sandbox to genuinely book a real shipment — kept
// behind config.shipping.useMassShip since it's an alternative to the
// single-order path above, not a replacement, until it's exercised more.
// Still triggered at the same pack-time point as the single-order path (not
// at sync time) — mass_ship_order lets one call cover multiple packages, but
// here it's only ever called with this one order's package.
async function bookShipmentMass(accessToken, shopId, orderSn, cfg) {
  // NOTE: still depends on get_order_detail for package_list, unlike the
  // single-order path above — inherits the same "empty for new orders" issue
  // seen against Shopee's sandbox if that endpoint is still broken when this
  // path is re-enabled.
  const detail = await getOrderDetail(accessToken, shopId, [orderSn], 'package_list');
  const packageNumber = detail.response?.order_list?.[0]?.package_list?.[0]?.package_number;
  if (!packageNumber) throw new Error('Could not resolve package_number for mass shipping');

  const massParam = await getMassShippingParameter(accessToken, shopId, [packageNumber]);
  if (massParam.error) {
    throw new Error(`get_mass_shipping_parameter failed: ${massParam.message || massParam.error}`);
  }

  const body = { package_list: [{ package_number: packageNumber }] };
  let pickupTimeLabel = null;
  let isDropoff = null;
  if (massParam.response?.pickup?.address_list?.length || massParam.response?.dropoff !== undefined) {
    const method = pickShippingMethod(massParam.response);
    pickupTimeLabel = method.pickupLabel;
    isDropoff = method.isDropoff;
    if (method.isDropoff) body.dropoff = method.dropoff;
    else body.pickup = method.pickup;
  }

  const massResult = await massShipOrder(accessToken, shopId, body);
  const failEntry = massResult.response?.fail_list?.find((f) => f.package_number === packageNumber);
  const alreadyBooked = failEntry && /already.*shipped/i.test(failEntry.fail_reason || '');

  if (massResult.error && !alreadyBooked) {
    throw new Error(`mass_ship_order failed: ${massResult.message || massResult.error}`);
  }
  if (failEntry && !alreadyBooked) {
    throw new Error(`mass_ship_order failed for package: ${failEntry.fail_reason}`);
  }

  const { trackingNumber, documentType } = await pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
  return { trackingNumber, packageNumber, documentType, pickupTimeLabel, isDropoff };
}

// One-time backfill for orders that were already booked/labeled before
// package_number started being captured at booking time — same "deliberately
// re-trigger the already-booked error" trick as inside bookShipmentSingle,
// exposed standalone so shopeeSync.js can retroactively learn the number
// for orders it otherwise has no way to ever get one for.
async function learnPackageNumber(accessToken, shopId, orderSn) {
  const shippingParam = await getShippingParameter(accessToken, shopId, orderSn);
  return shippingParam.message?.match(PACKAGE_NUMBER_PATTERN)?.[1] ?? null;
}

// Books the real shipment on Shopee and generates the real label PDF.
// Returns { trackingNumber, packageNumber, documentType, pickupTimeLabel,
// isDropoff } once a document is confirmed READY (isDropoff: true when the
// courier offered no pickup and the order was booked for drop-off at the
// courier's counter, false for a normal pickup, null when this call didn't
// choose -- the package already existed) — packageNumber is what shopeeSync.js
// uses to fetch item details via get_package_detail, working around
// order/get_order_detail's failure on new orders. documentType is whichever
// type actually succeeded (PREFERRED_SHIPPING_DOCUMENT_TYPE, or the
// BOOTSTRAP one as a fallback — see pollTrackingAndDocument) and must be
// passed to download_shipping_document so it fetches that same document.
// pickupTimeLabel (Shopee's own text label, e.g. "Now" or "16:00 - 17:00",
// or null if no fresh pickup slot was selected this call — e.g. the package
// already existed) is the courier's scheduled pickup window, for
// orders.pickup_time_label.
// Which underlying API pair is used (single ship_order vs mass_ship_order) is
// controlled by config.json's shipping.useMassShip — editable with a plain
// text editor, no restart needed.
async function bookShipment(accessToken, shopId, orderSn) {
  const cfg = getConfig().shipping;
  return cfg.useMassShip
    ? bookShipmentMass(accessToken, shopId, orderSn, cfg)
    : bookShipmentSingle(accessToken, shopId, orderSn, cfg);
}

module.exports = { bookShipment, learnPackageNumber };
