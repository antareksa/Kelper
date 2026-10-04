const express = require('express');
const { checkLocked, recordFailure, recordSuccess } = require('../loginGuard');
const { createSession, destroySession, requireAdminAuth } = require('../adminSession');
const { findAdmin, verifyPassword } = require('../adminUsers');

const router = express.Router();

// Checked against admin_users (see adminUsers.js), not a single .env pair --
// still backed by a real session either way (see adminSession.js): every
// other admin route requires the token this returns, not just this login
// screen's own success response.
router.post('/login', (req, res) => {
  const ip = req.ip;
  const retryAfterSeconds = checkLocked(ip);
  if (retryAfterSeconds > 0) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `Too many failed login attempts. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    });
  }

  const { username, password } = req.body;
  const admin = findAdmin(username);
  const ok = admin && verifyPassword(password, admin.password_hash);
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Wrong username or password' });
  }

  recordSuccess(ip);
  const role = admin.role || 'admin';
  const token = createSession(role, admin.username);
  res.json({ ok: true, token, role });
});

// Who the current session belongs to and what role it has. The page asks this
// on load instead of trusting a role it saved in the browser, so a packing
// account can't turn itself into a full admin by editing local storage (the
// server enforces the role on every request regardless, see adminSession.js).
router.get('/me', requireAdminAuth, (req, res) => {
  res.json({ role: req.adminRole, username: req.adminUsername });
});

router.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  destroySession(token);
  res.json({ ok: true });
});

module.exports = router;
