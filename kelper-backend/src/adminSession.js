const crypto = require('crypto');
const db = require('./db');

// Real admin sessions, issued by /admin/login and checked by requireAdminAuth
// below — see db.js's admin_sessions migration comment for why this exists.
// A 32-byte random token, not a JWT — there's nothing that needs to be
// encoded IN the token (no claims), just an unguessable key into the
// admin_sessions table, so a plain random value is simpler and just as safe.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a normal "log in once a day" admin session

function now() {
  return Date.now();
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = now();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, createdAt, createdAt + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

// Also sweeps expired sessions on every check, rather than a separate timer —
// this table is small and only ever touched at login-time request volume,
// so there's no need for a dedicated cleanup job.
function isValidSession(token) {
  if (!token) return false;
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now());
  const row = db.prepare('SELECT 1 FROM admin_sessions WHERE token = ?').get(token);
  return !!row;
}

// Applied per-route (not router-wide) in packing.js/operators.js, since both
// of those routers mix real admin endpoints with the Packing Station kiosk's
// own operational endpoints — the kiosk has no login step at all (just an
// operator scanning their badge), so it can never carry this token. Router-
// wide is used for dashboard.js/products.js/orders.js/shop.js instead, which
// are admin-only end to end.
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Admin login required.' });
  }
  next();
}

module.exports = { createSession, destroySession, isValidSession, requireAdminAuth };
