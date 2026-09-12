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
  let trackingNumber = '';
  for (let attempt = 0; attempt < trackAttempts && !trackingNumber; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, trackDelay));
    const trackingResult = await getTrackingNumber(accessToken, shopId, orderSn);
    if (trackingResult.error) {
      throw new Error(`get_tracking_number failed: ${trackingResult.message || trackingResult.error}`);
    }
    trackingNumber = trackingResult.response.tracking_number;
  }
  if (!trackingNumber) throw new Error('Tracking number was not assigned in time');

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

// Single-order path: get_shipping_parameter -> ship_order.
//
// Idempotent by design: if a previous attempt already called ship_order (e.g. a
// crash happened between booking and printing), get_shipping_parameter will
// reject with "not eligible for rescheduling" since the package already exists —
// that's treated as "already booked" and we skip straight to tracking/printing,
// rather than failing or trying to ship_order a second time.
async function bookShipmentSingle(accessToken, shopId, orderSn, cfg) {
  const shippingParam = await getShippingParameter(accessToken, shopId, orderSn);
  const alreadyBooked = shippingParam.error && /not eligible for rescheduling/i.test(shippingParam.message || '');

  if (shippingParam.error && !alreadyBooked) {
    throw new Error(`get_shipping_parameter failed: ${shippingParam.message || shippingParam.error}`);
  }

  if (!alreadyBooked) {
    const pickup = pickPickupOption(shippingParam.response?.pickup);
    const shipResult = await shipOrder(accessToken, shopId, { order_sn: orderSn, pickup });
    if (shipResult.error) {
      throw new Error(`ship_order failed: ${shipResult.message || shipResult.error}`);
    }
  }

  return pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
}

// Mass-shipping path: get_mass_shipping_parameter -> mass_ship_order.
// Confirmed against the sandbox to genuinely book a real shipment — kept
// behind config.shipping.useMassShip since it's an alternative to the
// single-order path above, not a replacement, until it's exercised more.
// Still triggered at the same pack-time point as the single-order path (not
// at sync time) — mass_ship_order lets one call cover multiple packages, but
// here it's only ever called with this one order's package.
async function bookShipmentMass(accessToken, shopId, orderSn, cfg) {
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

  return pollTrackingAndDocument(accessToken, shopId, orderSn, cfg);
}

// Books the real shipment on Shopee and generates the real label PDF.
// Returns the tracking number once the document is confirmed READY.
// Which underlying API pair is used (single ship_order vs mass_ship_order) is
// controlled by config.json's shipping.useMassShip — editable with a plain
// text editor, no restart needed.
async function bookShipment(accessToken, shopId, orderSn) {
  const cfg = getConfig().shipping;
  return cfg.useMassShip
    ? bookShipmentMass(accessToken, shopId, orderSn, cfg)
    : bookShipmentSingle(accessToken, shopId, orderSn, cfg);
}

module.exports = { bookShipment };
