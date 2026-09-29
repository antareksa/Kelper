import { useEffect, useState, Fragment } from 'react';
import { colors, card } from './theme';
import { API_BASE, apiFetch } from './apiBase';
import { SHOP_ID } from './shopConfig';

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Client-requested (2026-09-30): per-operator handling duration (item-scan
// through label-scan confirm — see routes/reports.js's operator-performance,
// NOT completed_at, which is set much later at courier pickup) and
// attendance for a pickable day, plus each operator's own order list with
// per-order duration. One report instead of separate pages for each ask,
// since they're all sliced by the same operator+date.
export default function OperatorPerformance() {
  const [date, setDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null); // operator_name currently expanded

  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function load(forDate) {
    setLoading(true);
    setError(null);
    try {
      const url = forDate
        ? `${API_BASE}/reports/operator-performance?shop_id=${SHOP_ID}&date=${forDate}`
        : `${API_BASE}/reports/operator-performance?shop_id=${SHOP_ID}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('Gagal mengambil data kinerja operator.');
      const json = await res.json();
      setData(json);
      // No date picked yet — sync the picker to the server's own default
      // (today, WIB) instead of computing "today" again client-side, which
      // could disagree with WIB if the browser isn't in that timezone.
      if (!forDate) setDate(json.date);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)', color: colors.text }}>
          Kinerja Operator
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            background: colors.cardAlt,
            color: colors.text,
            fontSize: 13,
            fontFamily: 'var(--sans)',
          }}
        />
      </div>

      {error && <p style={{ color: colors.red, fontSize: 13.5, margin: 0 }}>{error}</p>}

      {loading ? (
        <p style={{ color: colors.textDim, fontSize: 13 }}>Memuat...</p>
      ) : !data || data.operators.length === 0 ? (
        <div style={card()}>
          <p style={{ color: colors.textDim, fontSize: 13, margin: 0, textAlign: 'center', padding: '20px 0' }}>
            Tidak ada data untuk tanggal ini.
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ ...card(), flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 6 }}>Order Selesai</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: colors.text }}>{data.overall_orders_completed}</div>
            </div>
            <div style={{ ...card(), flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 6 }}>Rata-rata Durasi (Semua Operator)</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: colors.text }}>{formatDuration(data.overall_avg_duration_seconds)}</div>
            </div>
          </div>

          <div style={{ ...card(), padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}`, textAlign: 'left' }}>
                  <th style={{ padding: '12px 16px', color: colors.textDim, fontWeight: 600 }}>Operator</th>
                  <th style={{ padding: '12px 16px', color: colors.textDim, fontWeight: 600 }}>Jam Masuk</th>
                  <th style={{ padding: '12px 16px', color: colors.textDim, fontWeight: 600 }}>Jam Keluar</th>
                  <th style={{ padding: '12px 16px', color: colors.textDim, fontWeight: 600 }}>Order Selesai</th>
                  <th style={{ padding: '12px 16px', color: colors.textDim, fontWeight: 600 }}>Rata-rata Durasi</th>
                </tr>
              </thead>
              <tbody>
                {data.operators.map((op) => {
                  const checkedInAt = op.attendance.length ? Math.min(...op.attendance.map((a) => a.checked_in_at)) : null;
                  const stillActive = op.attendance.some((a) => a.checked_out_at == null);
                  const checkedOutAt = !stillActive && op.attendance.length ? Math.max(...op.attendance.map((a) => a.checked_out_at)) : null;
                  const isExpanded = expanded === op.operator_name;
                  return (
                    <Fragment key={op.operator_name}>
                      <tr
                        onClick={() => setExpanded(isExpanded ? null : op.operator_name)}
                        style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}
                      >
                        <td style={{ padding: '12px 16px', color: colors.text, fontWeight: 600 }}>{op.operator_name}</td>
                        <td style={{ padding: '12px 16px', color: colors.textDim }}>{formatTime(checkedInAt)}</td>
                        <td style={{ padding: '12px 16px', color: colors.textDim }}>
                          {stillActive ? <span style={{ color: colors.green, fontWeight: 600 }}>Masih Aktif</span> : formatTime(checkedOutAt)}
                        </td>
                        <td style={{ padding: '12px 16px', color: colors.text }}>{op.orders_completed}</td>
                        <td style={{ padding: '12px 16px', color: colors.text }}>{formatDuration(op.avg_duration_seconds)}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} style={{ padding: '0 16px 16px', background: colors.cardAlt }}>
                            {op.orders.length === 0 ? (
                              <p style={{ color: colors.textDim, fontSize: 12.5, margin: '12px 0' }}>Belum ada order selesai.</p>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                                {op.orders.map((o) => (
                                  <div key={o.order_sn} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 12.5 }}>
                                    <span style={{ fontFamily: 'ui-monospace, monospace', color: colors.text }}>{o.order_sn}</span>
                                    <span style={{ color: colors.textDim }}>{formatDuration(o.duration_seconds)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
