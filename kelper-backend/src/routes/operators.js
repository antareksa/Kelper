const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { startOfTodayWIB } = require('../wib');
const { requireAdminAuth } = require('../adminSession');

const router = express.Router();

function now() {
  return Math.floor(Date.now() / 1000);
}

// LOGIN OPERATOR — looks up the operator by barcode and, if a station_id is
// given, checks them into that station (for the admin Active Station view).
router.get('/lookup', (req, res) => {
  const { barcode, station_id } = req.query;
  if (!barcode) return res.status(400).json({ error: 'barcode is required' });

  const operator = db.prepare('SELECT id, name FROM operators WHERE login_barcode = ?').get(barcode);
  if (!operator) return res.status(404).json({ error: 'operator_not_found', message: 'Unknown operator barcode' });

  if (station_id) {
    db.prepare(`
      INSERT INTO station_sessions (station_id, operator_name, checked_in_at)
      VALUES (?, ?, ?)
      ON CONFLICT(station_id) DO UPDATE SET operator_name = excluded.operator_name, checked_in_at = excluded.checked_in_at
    `).run(station_id, operator.name, now());
  }

  res.json(operator);
});

// LOGOUT (or the 1h auto-timeout) — clears this station from the Active
// Station view.
router.post('/check-out', (req, res) => {
  const { station_id } = req.body;
  if (!station_id) return res.status(400).json({ error: 'station_id is required' });
  db.prepare('DELETE FROM station_sessions WHERE station_id = ?').run(station_id);
  res.json({ ok: true });
});

// Admin "Active Station" view — every currently checked-in station, what
// order (if any) it's handling right now, and how many it's finished today.
router.get('/active-stations', requireAdminAuth, (req, res) => {
  const sessions = db.prepare('SELECT * FROM station_sessions').all();

  const rows = sessions.map((s) => {
    // READY_FOR_PICKUP isn't included — once the label's printed AND
    // confirm-scanned, the station has already moved on to its next order,
    // so that status no longer reflects "what this station is doing right
    // now". AWAITING_LABEL_SCAN is included — the station is still blocked
    // there, waiting on the operator's confirm-scan.
    const active = db
      .prepare("SELECT order_sn FROM packing_sessions WHERE station_id = ? AND status IN ('IN_PROGRESS', 'AWAITING_LABEL_SCAN') ORDER BY started_at DESC LIMIT 1")
      .get(s.station_id);
    const doneToday = db
      .prepare("SELECT COUNT(*) as c FROM packing_sessions WHERE station_id = ? AND status = 'DONE' AND completed_at >= ?")
      .get(s.station_id, startOfTodayWIB()).c;

    return {
      station_id: s.station_id,
      operator_name: s.operator_name,
      checked_in_at: s.checked_in_at,
      current_order_sn: active ? active.order_sn : null,
      total_orders_today: doneToday,
    };
  });

  res.json(rows);
});

// Daftar — register a new operator, auto-generating their login barcode.
router.post('/register', requireAdminAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const barcode = `OP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  db.prepare('INSERT INTO operators (name, login_barcode, created_at) VALUES (?, ?, ?)').run(name.trim(), barcode, now());

  res.json({ name: name.trim(), login_barcode: barcode });
});

// Daftar — reprint an existing operator's barcode by name.
router.get('/by-name', requireAdminAuth, (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const operator = db.prepare('SELECT name, login_barcode FROM operators WHERE name = ?').get(name);
  if (!operator) return res.status(404).json({ error: 'operator_not_found', message: 'No operator with that name' });

  res.json(operator);
});

module.exports = router;
