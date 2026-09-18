const db = require('./db');

// Runtime-mutable toggles an admin flips from the UI (e.g. pausing order
// sync) — stored in the database, not config.json. config.json is
// git-tracked deployment config; a UI write to it would get silently
// reverted the next time auto-deploy pulls and rebuilds.
function getSetting(key, defaultValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

module.exports = { getSetting, setSetting };
