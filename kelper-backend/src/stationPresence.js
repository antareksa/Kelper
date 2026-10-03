const db = require('./db');
const { releaseStationSessions } = require('./sessionRelease');

const now = () => Math.floor(Date.now() / 1000);

// A station that has not been heard from for this long is considered gone
// (PC switched off, app closed, network lost for good). The page sends a
// heartbeat every 30s; browsers throttle background pages to about once a
// minute, so three minutes leaves room for a missed beat or two without
// logging out a station that is still there.
const STATION_DEAD_AFTER_SECONDS = 180;
const SWEEP_INTERVAL_MS = 30000;

const touch = db.prepare('UPDATE station_sessions SET last_seen_at = ? WHERE station_id = ?');

// True when the station is checked in (and was marked alive), false when it
// has no live session — e.g. the sweep already checked it out, which the page
// uses to log its operator out instead of carrying on as if nothing happened.
function touchStation(stationId) {
  if (!stationId) return false;
  return touch.run(now(), stationId).changes > 0;
}

// The one place a station is checked out — LOGOUT, the idle auto-logout and
// the dead-station sweep all end up here, so they cannot drift apart. `at` is
// when the shift really ended (for a dead station: its last sign of life, not
// the moment the sweep noticed). Hands back whatever the station was still
// scanning (see sessionRelease.js), removes it from the Active Station view
// and closes its open absensi shift.
function checkOutStation(stationId, at = now()) {
  db.prepare('DELETE FROM station_sessions WHERE station_id = ?').run(stationId);
  const released = releaseStationSessions(stationId);
  // "open" (checked_out_at IS NULL) rather than matched by operator name: a
  // station only ever has one operator checked in at a time.
  db.prepare(`
    UPDATE attendance_log SET checked_out_at = MAX(?, checked_in_at)
    WHERE id = (SELECT id FROM attendance_log WHERE station_id = ? AND checked_out_at IS NULL ORDER BY checked_in_at DESC LIMIT 1)
  `).run(at, stationId);
  return released;
}

// Checks out every station that went silent. Orders at the label-scan step
// stay with their station on purpose (the label is already printed on a
// package) — same rule as pause/logout.
function sweepDeadStations() {
  const cutoff = now() - STATION_DEAD_AFTER_SECONDS;
  const dead = db
    .prepare('SELECT station_id, COALESCE(last_seen_at, checked_in_at) AS seen FROM station_sessions WHERE COALESCE(last_seen_at, checked_in_at) < ?')
    .all(cutoff);
  for (const s of dead) {
    checkOutStation(s.station_id, s.seen);
    console.log(`[server] station ${s.station_id} went silent (${now() - s.seen}s) — checked out`);
  }
  return dead.map((s) => s.station_id);
}

let sweepTimer = null;
function startPresenceSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepDeadStations, SWEEP_INTERVAL_MS);
  sweepTimer.unref(); // never keeps a script or test process alive
}

module.exports = { touchStation, checkOutStation, sweepDeadStations, startPresenceSweep, STATION_DEAD_AFTER_SECONDS };
