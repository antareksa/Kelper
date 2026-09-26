const express = require('express');
const { checkLocked, recordFailure, recordSuccess } = require('../loginGuard');
const { createSession, destroySession } = require('../adminSession');

const router = express.Router();

// Plaintext comparison against .env — still true, but now backed by a real
// session (see adminSession.js): every other admin route requires the token
// this returns, not just this login screen's own success response.
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
  const ok = username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD;
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Wrong username or password' });
  }

  recordSuccess(ip);
  const token = createSession();
  res.json({ ok: true, token });
});

router.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  destroySession(token);
  res.json({ ok: true });
});

module.exports = router;
