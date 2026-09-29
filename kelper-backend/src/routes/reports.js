const express = require('express');
const db = require('../db');
const { dateStringWIB, startOfDateWIB, shiftDateStringWIB } = require('../wib');

const router = express.Router();

// Client-requested (2026-09-30): per-operator performance + attendance for a
// given day — average/per-order handling duration (item-scanning through the
// label-scan confirm, i.e. label_confirmed_at - started_at — NOT
// completed_at, which is set much later at courier pickup), the list of
// order_sn's each operator handled that day, and their check-in/check-out
// times (attendance_log). One report covers all of it rather than several
// separate pages, since they're all sliced by the same operator+date.
// Mock orders (debugMode) are excluded so a leftover test session never
// skews a real operator's numbers.
router.get('/operator-performance', (req, res) => {
  const shopId = Number(req.query.shop_id);
  if (!shopId) return res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });

  const date = req.query.date || dateStringWIB(0);
  const dayStart = startOfDateWIB(date);
  const dayEnd = startOfDateWIB(shiftDateStringWIB(date, 1));

  const attendance = db
    .prepare(`
      SELECT operator_name, station_id, checked_in_at, checked_out_at
      FROM attendance_log
      WHERE checked_in_at >= ? AND checked_in_at < ?
      ORDER BY checked_in_at ASC
    `)
    .all(dayStart, dayEnd);

  const completedOrders = db
    .prepare(`
      SELECT ps.order_sn, ps.operator_name, ps.station_id, ps.started_at, ps.label_confirmed_at
      FROM packing_sessions ps
      JOIN orders o ON o.order_sn = ps.order_sn
      WHERE o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%'
        AND ps.label_confirmed_at IS NOT NULL AND ps.label_confirmed_at >= ? AND ps.label_confirmed_at < ?
      ORDER BY ps.label_confirmed_at ASC
    `)
    .all(shopId, dayStart, dayEnd);

  const byOperator = new Map();
  function operatorRow(name) {
    if (!byOperator.has(name)) {
      byOperator.set(name, { operator_name: name, attendance: [], orders: [] });
    }
    return byOperator.get(name);
  }
  for (const a of attendance) {
    operatorRow(a.operator_name).attendance.push({
      station_id: a.station_id,
      checked_in_at: a.checked_in_at,
      checked_out_at: a.checked_out_at,
    });
  }
  for (const o of completedOrders) {
    operatorRow(o.operator_name).orders.push({
      order_sn: o.order_sn,
      station_id: o.station_id,
      started_at: o.started_at,
      label_confirmed_at: o.label_confirmed_at,
      duration_seconds: o.label_confirmed_at - o.started_at,
    });
  }

  const operators = [...byOperator.values()]
    .map((op) => ({
      ...op,
      orders_completed: op.orders.length,
      avg_duration_seconds: op.orders.length
        ? Math.round(op.orders.reduce((sum, o) => sum + o.duration_seconds, 0) / op.orders.length)
        : null,
    }))
    .sort((a, b) => a.operator_name.localeCompare(b.operator_name));

  const allDurations = completedOrders.map((o) => o.label_confirmed_at - o.started_at);
  const overallAvgDurationSeconds = allDurations.length
    ? Math.round(allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length)
    : null;

  res.json({
    date,
    overall_avg_duration_seconds: overallAvgDurationSeconds,
    overall_orders_completed: allDurations.length,
    operators,
  });
});

module.exports = router;
