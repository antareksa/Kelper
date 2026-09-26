// Indonesia doesn't observe daylight saving time, so WIB (Western Indonesia
// Time) is always a fixed UTC+7 — safe to compute with a plain offset
// instead of needing a timezone database/library. Explicit on purpose: the
// machine this process runs on might not be set to WIB at all (e.g. a cloud
// host defaulting to UTC), and the packing cutoff / daily-count logic must
// mean the same wall-clock time in Jakarta no matter where it's hosted.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function nowInWIB() {
  return new Date(Date.now() + WIB_OFFSET_MS);
}

// Current hour of the day in WIB (0-23), independent of the server's own
// system timezone.
function getWIBHour() {
  return nowInWIB().getUTCHours();
}

// Unix seconds for 00:00 WIB, `daysAgo` days back (0 = today).
function startOfDayWIB(daysAgo = 0) {
  const wib = nowInWIB();
  const midnightUtcMs = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate() - daysAgo);
  return Math.floor((midnightUtcMs - WIB_OFFSET_MS) / 1000);
}

function startOfTodayWIB() {
  return startOfDayWIB(0);
}

// Unix seconds for the 1st of the month at 00:00 WIB, `monthsAgo` months
// back (0 = this month) — used for "Bulan Ini"/"Bulan Lalu" comparisons
// (see routes/products.js's catalog Qty/Omset Ini/Lalu columns).
function startOfMonthWIB(monthsAgo = 0) {
  const wib = nowInWIB();
  const midnightUtcMs = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth() - monthsAgo, 1);
  return Math.floor((midnightUtcMs - WIB_OFFSET_MS) / 1000);
}

// YYYY-MM-DD for `daysAgo` days back, WIB wall-clock date — the format
// Shopee's date-range APIs (e.g. get_shop_affiliate_performance) expect.
function dateStringWIB(daysAgo = 0) {
  const wib = nowInWIB();
  const d = new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
}

// DD-MM-YYYY for `daysAgo` days back, WIB wall-clock date — the format
// Shopee's Ads Performance APIs (get_all_cpc_ads_hourly/daily_performance)
// expect, unlike the YYYY-MM-DD the Brand Portal APIs use.
function dateStringDDMMYYYYWIB(daysAgo = 0) {
  const [year, month, day] = dateStringWIB(daysAgo).split('-');
  return `${day}-${month}-${year}`;
}

module.exports = { getWIBHour, startOfTodayWIB, startOfDayWIB, startOfMonthWIB, dateStringWIB, dateStringDDMMYYYYWIB };
