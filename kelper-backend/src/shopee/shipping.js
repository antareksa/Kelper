const {
  getOrderDetail,
  getShippingParameter,
  getMassShippingParameter,
  shipOrder,
  massShipOrder,
  getTrackingNumber,
  createShippingDocument,
  getShippingDocumentParameter,
  getShippingDocumentResult,
} = require('./client');
const { getConfig } = require('../config');

// Client-reported (2026-09-27): different couriers' labels were coming out
// in different layouts/sizes because create_shipping_document was never
// told which template to use, so Shopee fell back to each courier's own
// default. Forcing thermal everywhere (when the courier actually offers it —
// see resolveShippingDocumentType below) matches the Packing Stations'
// actual printers and makes every label consistent regardless of courier.
const PREFERRED_SHIPPING_DOCUMENT_TYPE = 'THERMAL_AIR_WAYBILL';

// Best-effort: if this call itself fails or the order isn't in the result
// (fail_error), returns undefined so create_shipping_document falls back to
// its old behavior (courier's own default) rather than blocking booking.
async function resolveShippingDocumentType(accessToken, shopId, orderSn, trackingNumber) {
  const param = await getShippingDocumentParameter(accessToken, shopId, orderSn, trackingNumber);
  const result = param.response?.result_list?.[0];
  if (param.error || !result || result.fail_error) return undefined;

  const chosen = result.selectable_shipping_document_type?.includes(PREFERRED_SHIPPING_DOCUMENT_TYPE)
    ? PREFERRED_SHIPPING_DOCUMENT_TYPE
    : result.suggest_shipping_document_type;
  console.log(`[server] ${orderSn}: shipping_document_type -> ${chosen} (selectable: ${result.selectable_shipping_document_type?.join(', ') || 'none'})`);
  return chosen;
}

// Auto-picks the shop's default pickup address and the recommended time slot,
// matching the doc's intent that operators don't manually choose logistics options.
function pickPickupOption(pickup) {
  if (!pickup || !pickup.address_list?.length) {
    throw new Error('No pickup address configured for this shop');
  }
  const address = pickup.address_list.find((a) => a.address_flag?.includes('default_address')) || pickup.address_list[0];
  const slot = address.time_slot_list.find((s) => s.flags?.includes('recommended')) || address.time_slot_list[0];
  if (!slot) throw new Error('No pickup time slot available for this order');
  return { address_id: address.address_id, pickup_time_id: slot.pickup_time_id };
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

  // Temporarily reverted (2026-09-27): testing whether forcing
  // shipping_document_type is itself what's preventing JIT/auto-arranged
  // orders' documents from ever becoming READY (see
  // logistics.can_not_print_jit_order in Shopee's create_shipping_document
  // docs) — omitting it lets Shopee fall back to each courier's own
  // suggested type again, same as before this whole investigation started.
  // const documentType = await resolveShippingDocumentType(accessToken, shopId, orderSn, trackingNumber);
  const docResult = await createShippingDocument(accessToken, shopId, orderSn, trackingNumber);
  if (docResult.error) {
    throw new Error(`create_shipping_document failed: ${docResult.message || docResult.error}`);
  }

  const { maxAttempts: docAttempts, delayMs: docDelay } = cfg.documentPoll;
  let ready = false;
  for (let attempt = 0; attempt < docAttempts && !ready; attempt += 1) {
    const status = await getShippingDocumentResult(accessToken, shopId, orderSn, trackingNumber);
    const entry = status.response?.result_list?.[0];
    if (entry?.status === 'READY') {
      ready = true;
    } else if (attempt < docAttempts - 1) {
      await new Promise((r) => setTimeout(r, docDelay));
    }
  }
  if (!ready) throw new Error('Shipping document did not become ready in time');

  return trackingNumber;
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

  if (!alreadyBookedMatch) {
    const pickup = pickPickupOption(shippingParam.response?.pickup);
    const shipResult = await shipOrder(accessToken, shopId, { order_sn: orderSn, pickup });

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

  const trackingNumber = await pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
  return { trackingNumber, packageNumber };
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
  if (massParam.response?.pickup?.address_list?.length) {
    body.pickup = pickPickupOption(massParam.response.pickup);
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

  const trackingNumber = await pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
  return { trackingNumber, packageNumber };
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
// Returns { trackingNumber, packageNumber } once the document is confirmed
// READY — packageNumber is what shopeeSync.js uses to fetch item details
// via get_package_detail, working around order/get_order_detail's failure on
// new orders.
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
