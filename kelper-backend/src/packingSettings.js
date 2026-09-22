const { getSetting, setSetting } = require('./settings');

// Client-requested (2026-09-22) Packing Station configuration, editable from
// the Order Lists screen. Shared between shopeeSync.js (which enforces them
// during discovery/booking) and routes/packing.js (which both serves them to
// the settings form and reads them again to bucket the order lists) so the
// defaults/keys can't drift between the two call sites.
const DEFAULTS = {
  // Minutes an order sits in "Waiting List" before it's eligible for
  // booking/shipping — gives the buyer a window to cancel before Shopee
  // commits to a shipment. Shopee's own standard cancellation window is 1
  // hour, hence the default.
  orderDelayMinutes: 60,
  // Caps how many orders bookAndLabelPendingOrders will book with Shopee at
  // the same time. 0 = unlimited (book every pending order concurrently, the
  // original behavior).
  maxConcurrentBookings: 0,
  // Caps how many orders may sit in "Ready to Check" (booked/labeled but not
  // yet claimed by a station) at once — booking pauses once this is hit,
  // leaving the rest in Processing until a station consumes some. 0 =
  // unlimited.
  maxReadyToCheck: 0,
};

function getOrderDelayMinutes() {
  const v = Number(getSetting('orderDelayMinutes', String(DEFAULTS.orderDelayMinutes)));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.orderDelayMinutes;
}

function getOrderDelaySeconds() {
  return getOrderDelayMinutes() * 60;
}

function getMaxConcurrentBookings() {
  const v = Number(getSetting('maxConcurrentBookings', String(DEFAULTS.maxConcurrentBookings)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getMaxReadyToCheck() {
  const v = Number(getSetting('maxReadyToCheck', String(DEFAULTS.maxReadyToCheck)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getPackingSettings() {
  return {
    orderDelayMinutes: getOrderDelayMinutes(),
    maxConcurrentBookings: getMaxConcurrentBookings(),
    maxReadyToCheck: getMaxReadyToCheck(),
  };
}

function setPackingSettings({ orderDelayMinutes, maxConcurrentBookings, maxReadyToCheck }) {
  if (orderDelayMinutes != null) setSetting('orderDelayMinutes', Math.max(0, Number(orderDelayMinutes)));
  if (maxConcurrentBookings != null) setSetting('maxConcurrentBookings', Math.max(0, Number(maxConcurrentBookings)));
  if (maxReadyToCheck != null) setSetting('maxReadyToCheck', Math.max(0, Number(maxReadyToCheck)));
  return getPackingSettings();
}

module.exports = {
  getOrderDelayMinutes,
  getOrderDelaySeconds,
  getMaxConcurrentBookings,
  getMaxReadyToCheck,
  getPackingSettings,
  setPackingSettings,
};
