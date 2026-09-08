const express = require('express');

const router = express.Router();

// Dev-stage only: plaintext comparison against .env, no sessions/hashing.
// There's no real sensitive dashboard data behind this yet — this just gates
// the placeholder screen. Needs real auth (hashed passwords, sessions) before
// any actual dashboard data is wired up.
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const ok = username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD;
  if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: 'Wrong username or password' });
  res.json({ ok: true });
});

module.exports = router;
