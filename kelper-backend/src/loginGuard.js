const db = require('./db');

// Brute-force protection for /admin/login, keyed by client IP (see
// server.js's `trust proxy` setting — req.ip must reflect the real client,
// not Caddy's own address, or every visitor would share one lockout).
// After MAX_ATTEMPTS failures the IP is locked out, with the lockout
// doubling (capped at MAX_LOCKOUT_MS) for every further block of
// MAX_ATTEMPTS failures, so a sustained attack gets slower over time instead
// of just retrying every BASE_LOCKOUT_MS forever.
const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 30 * 60 * 1000;

function getState(ip) {
  return db.prepare('SELECT fail_count, locked_until FROM login_attempts WHERE ip = ?').get(ip) || { fail_count: 0, locked_until: 0 };
}

// Returns seconds remaining if locked, 0 if not.
function checkLocked(ip) {
  const remainingMs = getState(ip).locked_until - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function recordFailure(ip) {
  const state = getState(ip);
  const failCount = state.fail_count + 1;
  let lockedUntil = state.locked_until;
  if (failCount >= MAX_ATTEMPTS) {
    const lockoutTier = Math.floor((failCount - MAX_ATTEMPTS) / MAX_ATTEMPTS);
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** lockoutTier, MAX_LOCKOUT_MS);
    lockedUntil = Date.now() + lockoutMs;
  }
  db.prepare(`
    INSERT INTO login_attempts (ip, fail_count, locked_until) VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until
  `).run(ip, failCount, lockedUntil);
}

function recordSuccess(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

module.exports = { checkLocked, recordFailure, recordSuccess };
