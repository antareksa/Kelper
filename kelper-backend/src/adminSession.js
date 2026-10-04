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

// role: 'admin' (the whole dashboard, the default -- also what every caller
// that predates roles gets) or 'packing' (Packing Station admin, see
// PACKING_ROLE_ALLOWED below). username only labels whose session this is.
function createSession(role = 'admin', username = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const createdAt = now();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at, role, username) VALUES (?, ?, ?, ?, ?)')
    .run(token, createdAt, createdAt + SESSION_TTL_MS, role, username);
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
  return getSession(token) !== null;
}

// { role, username } for a live session, null otherwise.
function getSession(token) {
  if (!token) return null;
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now());
  const row = db.prepare('SELECT role, username FROM admin_sessions WHERE token = ?').get(token);
  return row || null;
}

// What a 'packing' (Packing Station admin) login may call -- [method, path
// pattern] pairs matched against the full request path. Everything else is
// refused with 403, so hiding menu items in the page is only a convenience:
// this is what actually keeps that account out of the rest of the dashboard
// (Dashboard figures, List Barang, List Bundle, Shopee settings, the
// fetching on/off switch). Packing Station Dashboard = every /packing/ and
// /operators/ admin route plus the operator-performance report; Order =
// order search and the read-only queue/sync status.
const PACKING_ROLE_ALLOWED = [
  [null, /^\/packing\//],
  [null, /^\/operators\//],
  ['GET', /^\/orders\/(search|sync-status|queue-counts)$/],
  ['GET', /^\/reports\/operator-performance$/],
  ['GET', /^\/shop\/info$/],
  ['GET', /^\/admin\/me$/],
];

function roleMayCall(role, method, fullPath) {
  if (role !== 'packing') return true; // 'admin' (and any older session): unrestricted, as before
  return PACKING_ROLE_ALLOWED.some(([m, re]) => (m === null || m === method) && re.test(fullPath));
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
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'unauthorized', message: 'Admin login required.' });
  }
  // baseUrl + path = the full path whether this runs as router-level
  // middleware (app.use('/shop', requireAdminAuth, ...)) or per route.
  if (!roleMayCall(session.role, req.method, (req.baseUrl || '') + req.path)) {
    return res.status(403).json({ error: 'forbidden', message: 'Akun ini tidak punya akses ke fitur ini.' });
  }
  req.adminRole = session.role;
  req.adminUsername = session.username;
  next();
}

module.exports = { createSession, destroySession, isValidSession, getSession, requireAdminAuth };
