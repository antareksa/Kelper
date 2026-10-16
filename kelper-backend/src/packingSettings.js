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
  // Client-requested (2026-10-16): a separate, independently configurable
  // delay for INSTANT orders only. Some instant-type couriers (e.g. SPX
  // Instant Prioritas) auto-arrange the real-world pickup with Shopee the
  // moment the order is placed — see shopee/shipping.js's "already
  // auto-arranged by courier" handling — so holding them to the same
  // cancellation-window delay as normal orders can mean the courier shows
  // up before KELPER has even booked/labeled the order internally. Defaults
  // to the same value as orderDelayMinutes so behavior doesn't change until
  // this is explicitly lowered.
  instantOrderDelayMinutes: 60,
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
  // Client-requested (2026-09-25): how long an order can sit unclaimed in
  // "Ready to Check" before the Order Lists panel flags it with the "stuck"
  // tag — see routes/packing.js's /order-lists tag computation.
  readyToCheckStuckSeconds: 300,
  // Client-requested (2026-10-12): expeditions whose orders go up in priority
  // (after instant orders, before the "fewer items" rule -- see priorityOrder.js).
  // Free text, comma separated; an order matches an entry when its shipping
  // carrier CONTAINS it (case-insensitive, so "SPX" covers "SPX Express" and
  // "SPX Hemat"). Earlier in the list = higher priority. Empty = no expedition
  // priority. The client has not named the expeditions yet.
  priorityCarriers: '',
};

function getOrderDelayMinutes() {
  const v = Number(getSetting('orderDelayMinutes', String(DEFAULTS.orderDelayMinutes)));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.orderDelayMinutes;
}

function getInstantOrderDelayMinutes() {
  const v = Number(getSetting('instantOrderDelayMinutes', String(DEFAULTS.instantOrderDelayMinutes)));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.instantOrderDelayMinutes;
}

function getOrderDelaySeconds(isInstant) {
  return (isInstant ? getInstantOrderDelayMinutes() : getOrderDelayMinutes()) * 60;
}

function getMaxConcurrentBookings() {
  const v = Number(getSetting('maxConcurrentBookings', String(DEFAULTS.maxConcurrentBookings)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getMaxReadyToCheck() {
  const v = Number(getSetting('maxReadyToCheck', String(DEFAULTS.maxReadyToCheck)));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getPriorityCarriersText() {
  return String(getSetting('priorityCarriers', DEFAULTS.priorityCarriers) || '');
}

// Lowercased, trimmed entries, in the order the client wrote them.
function getPriorityCarriers() {
  return getPriorityCarriersText().split(/[,;\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
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

function getReadyToCheckStuckSeconds() {
  const v = Number(getSetting('readyToCheckStuckSeconds', String(DEFAULTS.readyToCheckStuckSeconds)));
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS.readyToCheckStuckSeconds;
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
    instantOrderDelayMinutes: getInstantOrderDelayMinutes(),
    maxConcurrentBookings: getMaxConcurrentBookings(),
    maxReadyToCheck: getMaxReadyToCheck(),
    workHourStartHour: getWorkHourStartHour(),
    workHourEndHour: getWorkHourEndHour(),
    workHourEnabled: getWorkHourEnabled(),
    readyToCheckStuckSeconds: getReadyToCheckStuckSeconds(),
    priorityCarriers: getPriorityCarriersText(),
  };
}

function setPackingSettings({ orderDelayMinutes, instantOrderDelayMinutes, maxConcurrentBookings, maxReadyToCheck, workHourStartHour, workHourEndHour, workHourEnabled, readyToCheckStuckSeconds, priorityCarriers }) {
  if (orderDelayMinutes != null) setSetting('orderDelayMinutes', Math.max(0, Number(orderDelayMinutes)));
  if (instantOrderDelayMinutes != null) setSetting('instantOrderDelayMinutes', Math.max(0, Number(instantOrderDelayMinutes)));
  if (maxConcurrentBookings != null) setSetting('maxConcurrentBookings', Math.max(0, Number(maxConcurrentBookings)));
  if (maxReadyToCheck != null) setSetting('maxReadyToCheck', Math.max(0, Number(maxReadyToCheck)));
  if (workHourStartHour != null) setSetting('workHourStartHour', Math.min(23, Math.max(0, Number(workHourStartHour))));
  if (workHourEndHour != null) setSetting('workHourEndHour', Math.min(23, Math.max(0, Number(workHourEndHour))));
  if (workHourEnabled != null) setSetting('workHourEnabled', workHourEnabled ? 'true' : 'false');
  if (readyToCheckStuckSeconds != null) setSetting('readyToCheckStuckSeconds', Math.max(1, Number(readyToCheckStuckSeconds)));
  if (typeof priorityCarriers === 'string') setSetting('priorityCarriers', priorityCarriers.trim().slice(0, 300));
  return getPackingSettings();
}

module.exports = {
  getOrderDelayMinutes,
  getInstantOrderDelayMinutes,
  getOrderDelaySeconds,
  getMaxConcurrentBookings,
  getMaxReadyToCheck,
  getWorkHourStartHour,
  getWorkHourEndHour,
  getWorkHourEnabled,
  getReadyToCheckStuckSeconds,
  getPriorityCarriers,
  isWithinWorkHour,
  getPackingSettings,
  setPackingSettings,
};
