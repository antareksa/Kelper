const crypto = require('crypto');
const db = require('./db');

// scrypt (Node's own crypto module) instead of bcrypt -- avoids adding a
// second native/compiled dependency alongside better-sqlite3, and is a
// well-established choice for this without needing a new package at all.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  // Length check first -- timingSafeEqual throws (rather than returning
  // false) if the two buffers aren't the same length.
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// 'admin' = the whole dashboard; 'packing' = Packing Station Dashboard + Order
// menus only (enforced server-side, see adminSession.js).
const ROLES = ['admin', 'packing'];

function findAdmin(username) {
  return db.prepare('SELECT id, username, password_hash, role FROM admin_users WHERE username = ?').get(username);
}

function createAdmin(username, password, role = 'admin') {
  if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}" -- use one of: ${ROLES.join(', ')}.`);
  db.prepare('INSERT INTO admin_users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), role, Math.floor(Date.now() / 1000));
}

// Changes an existing account's role. Sessions already issued keep the role
// they were created with until they expire or the person logs in again, so an
// account being demoted is also signed out of every open session.
function setAdminRole(username, role) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}" -- use one of: ${ROLES.join(', ')}.`);
  const changed = db.prepare('UPDATE admin_users SET role = ? WHERE username = ?').run(role, username).changes > 0;
  if (changed) db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(username);
  return changed;
}

// Also ends the account's open sessions -- before this, a removed admin's
// token kept working until it expired on its own (up to 24h).
function deleteAdmin(username) {
  const removed = db.prepare('DELETE FROM admin_users WHERE username = ?').run(username).changes > 0;
  if (removed) db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(username);
  return removed;
}

function listAdmins() {
  return db.prepare('SELECT username, role, created_at FROM admin_users ORDER BY created_at ASC').all();
}

// Client-requested (2026-10-01): replaces the old single ADMIN_USERNAME/
// ADMIN_PASSWORD env-var pair with real, individually revocable accounts
// (e.g. a separate login for a Shopee reviewer during Go Live, without
// sharing the real admin's own password). Runs at every startup but is a
// no-op once admin_users has at least one row, so it never overwrites an
// admin who's since changed their password through the table -- it only
// ever bootstraps the very first account.
function seedFromEnvIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM admin_users').get();
  if (count > 0) return;
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  createAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);
  console.log(`[server] seeded admin_users from ADMIN_USERNAME env var (${ADMIN_USERNAME}) -- safe to remove ADMIN_USERNAME/ADMIN_PASSWORD from .env now`);
}

module.exports = { ROLES, hashPassword, verifyPassword, findAdmin, createAdmin, setAdminRole, deleteAdmin, listAdmins, seedFromEnvIfEmpty };
