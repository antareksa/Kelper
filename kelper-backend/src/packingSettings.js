const { getSetting, setSetting } = require('./settings');
const { getWIBHour } = require('./wib');

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
  // leaving the rest unlabeled until a station consumes some. 0 = unlimited.
  maxReadyToCheck: 0,
  // Work hour (WIB): Shopee bookings only happen in this window — both for
  // brand-new orders and for the next-morning sweep of orders that were
  // already packed the previous day using just a temp barcode (see
  // shopeeSync.js's bookDeferredOrders). Outside this window, an order can
  // still be physically packed, it just won't have a real label until the
  // window reopens.
  workHourStartHour: 8,
  workHourEndHour: 16,
  // Kill switch for the work-hour restriction itself — lets an admin turn
  // work-hour enforcement off entirely (bookings happen any time, like
  // before this feature existed) to check the rest of the flow without
  // waiting for the clock. Stored as 'true'/'false' via settings.js, same
  // pattern as orders.js's syncEnabled.
  workHourEnabled: true,
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

function getWorkHourStartHour() {
  const v = Number(getSetting('workHourStartHour', String(DEFAULTS.workHourStartHour)));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : DEFAULTS.workHourStartHour;
}

function getWorkHourEndHour() {
  const v = Number(getSetting('workHourEndHour', String(DEFAULTS.workHourEndHour)));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : DEFAULTS.workHourEndHour;
}

function getWorkHourEnabled() {
  return getSetting('workHourEnabled', String(DEFAULTS.workHourEnabled)) === 'true';
}

// Explicit WIB, not the server's own system clock — a work hour meant for
// "08:00-16:00 in Jakarta" must stay 08:00-16:00 Jakarta time regardless of
// what timezone the machine running this happens to be set to. Disabling
// workHourEnabled bypasses the window entirely (always true) — booking
// behaves exactly like before this feature existed, for checking the rest
// of the flow without waiting for the clock.
function isWithinWorkHour() {
  if (!getWorkHourEnabled()) return true;
  const hour = getWIBHour();
  return hour >= getWorkHourStartHour() && hour < getWorkHourEndHour();
}

function getPackingSettings() {
  return {
    orderDelayMinutes: getOrderDelayMinutes(),
    maxConcurrentBookings: getMaxConcurrentBookings(),
    maxReadyToCheck: getMaxReadyToCheck(),
    workHourStartHour: getWorkHourStartHour(),
    workHourEndHour: getWorkHourEndHour(),
    workHourEnabled: getWorkHourEnabled(),
  };
}

function setPackingSettings({ orderDelayMinutes, maxConcurrentBookings, maxReadyToCheck, workHourStartHour, workHourEndHour, workHourEnabled }) {
  if (orderDelayMinutes != null) setSetting('orderDelayMinutes', Math.max(0, Number(orderDelayMinutes)));
  if (maxConcurrentBookings != null) setSetting('maxConcurrentBookings', Math.max(0, Number(maxConcurrentBookings)));
  if (maxReadyToCheck != null) setSetting('maxReadyToCheck', Math.max(0, Number(maxReadyToCheck)));
  if (workHourStartHour != null) setSetting('workHourStartHour', Math.min(23, Math.max(0, Number(workHourStartHour))));
  if (workHourEndHour != null) setSetting('workHourEndHour', Math.min(23, Math.max(0, Number(workHourEndHour))));
  if (workHourEnabled != null) setSetting('workHourEnabled', workHourEnabled ? 'true' : 'false');
  return getPackingSettings();
}

module.exports = {
  getOrderDelayMinutes,
  getOrderDelaySeconds,
  getMaxConcurrentBookings,
  getMaxReadyToCheck,
  getWorkHourStartHour,
  getWorkHourEndHour,
  getWorkHourEnabled,
  isWithinWorkHour,
  getPackingSettings,
  setPackingSettings,
};
