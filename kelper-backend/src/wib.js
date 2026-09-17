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

module.exports = { getWIBHour, startOfTodayWIB, startOfDayWIB };
