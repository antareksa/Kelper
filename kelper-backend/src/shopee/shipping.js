const {
  getShippingParameter,
  shipOrder,
  getTrackingNumber,
  createShippingDocument,
  getShippingDocumentResult,
} = require('./client');

// Auto-picks the shop's default pickup address and the recommended time slot,
// matching the doc's intent that operators don't manually choose logistics options.
function pickPickupOption(shippingParam) {
  const pickup = shippingParam.response?.pickup;
  if (!pickup || !pickup.address_list?.length) {
    throw new Error('No pickup address configured for this shop');
  }
  const address = pickup.address_list.find((a) => a.address_flag?.includes('default_address')) || pickup.address_list[0];
  const slot = address.time_slot_list.find((s) => s.flags?.includes('recommended')) || address.time_slot_list[0];
  if (!slot) throw new Error('No pickup time slot available for this order');
  return { address_id: address.address_id, pickup_time_id: slot.pickup_time_id };
}

// Books the real shipment on Shopee and generates the real label PDF.
// Returns the tracking number once the document is confirmed READY.
//
// Idempotent by design: if a previous attempt already called ship_order (e.g. a
// crash happened between booking and printing), get_shipping_parameter will
// reject with "not eligible for rescheduling" since the package already exists —
// that's treated as "already booked" and we skip straight to tracking/printing,
// rather than failing or trying to ship_order a second time.
async function bookShipment(accessToken, shopId, orderSn) {
  const shippingParam = await getShippingParameter(accessToken, shopId, orderSn);
  const alreadyBooked = shippingParam.error && /not eligible for rescheduling/i.test(shippingParam.message || '');

  if (shippingParam.error && !alreadyBooked) {
    throw new Error(`get_shipping_parameter failed: ${shippingParam.message || shippingParam.error}`);
  }

  if (!alreadyBooked) {
    const pickup = pickPickupOption(shippingParam);
    const shipResult = await shipOrder(accessToken, shopId, { order_sn: orderSn, pickup });
    if (shipResult.error) {
      throw new Error(`ship_order failed: ${shipResult.message || shipResult.error}`);
    }
  }

  // Shopee needs a moment after ship_order before the tracking number is
  // actually assigned — poll rather than assuming it's ready immediately.
  // Sandbox latency here is inconsistent (seen anywhere from ~2s to 30s+),
  // so this window is generous rather than tight.
  let trackingNumber = '';
  for (let attempt = 0; attempt < 20 && !trackingNumber; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
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

  // Sandbox has returned READY immediately so far; poll briefly in case a real
  // shop takes longer to render the document.
  let ready = false;
  for (let attempt = 0; attempt < 5 && !ready; attempt += 1) {
    const status = await getShippingDocumentResult(accessToken, shopId, orderSn, trackingNumber);
    const entry = status.response?.result_list?.[0];
    if (entry?.status === 'READY') {
      ready = true;
    } else if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!ready) throw new Error('Shipping document did not become ready in time');

  return trackingNumber;
}

module.exports = { bookShipment };
