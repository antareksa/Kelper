import { useEffect, useRef, useState } from 'react';
import { colors, card } from './theme';
import { renderCode39Svg } from './Barcode';

// A production build is served from the same origin as the API (Caddy
// proxies both from one hostname), so relative paths just work and http://
// would break under HTTPS as mixed content anyway. Dev still needs the
// explicit cross-origin call since Vite's dev server (5173) and the backend
// (3001) really are different origins there.
const API_BASE = import.meta.env.PROD ? '' : `http://${window.location.hostname}:3001`;
const REFRESH_MS = 10000;
const SHOP_ID = 227886187;

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ActiveStation() {
  const [stations, setStations] = useState([]);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    const res = await fetch(`${API_BASE}/operators/active-stations`);
    if (res.ok) setStations(await res.json());
  }

  if (stations.length === 0) {
    return (
      <div style={{ ...card(), height: '100%', boxSizing: 'border-box' }}>
        <p style={{ color: colors.textDim, margin: 0 }}>No stations currently checked in.</p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {stations.map((s) => (
        <div
          key={s.station_id}
          style={{
            ...card(),
            borderLeft: `3px solid ${s.current_order_sn ? colors.green : colors.blue}`,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: colors.text }}>{s.station_id} - {s.operator_name}</div>
            <div style={{ color: colors.textDim, fontSize: 13, marginTop: 2 }}>
              {s.current_order_sn ? `Handling Order Id ${s.current_order_sn}` : 'Menunggu order packing masuk'}
            </div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 13, color: colors.textDim }}>
            <div>Start Check In: {formatTime(s.checked_in_at)}</div>
            <div>Total Order hari ini: {s.total_orders_today}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// The pools from the packing flow diagram: orders discovered from Shopee
// that the server hasn't finished booking/labeling yet ("Processing"),
// orders discovered + labeled but no Packing Station has claimed yet ("Ready
// to Check"), orders a Packing Station has claimed and is actively scanning
// right now ("On Progress Check"), orders packed today with a real label
// waiting for Shipping Mode to confirm the courier took them ("Ready to
// Pickup"), and
// orders deferred to tomorrow, already scanned, waiting to be resumed
// ("Ready to Process Tomorrow").
function OrderLists() {
  const [lists, setLists] = useState({ processing: [], readyToCheck: [], onProgressCheck: [], readyForPickup: [], readyTomorrow: [] });
  const [loading, setLoading] = useState(true);
  // null = still checking on first load, not "paused" — the toggle button
  // stays disabled until we actually know, so a click can't race a stale
  // guess of the state.
  const [syncEnabled, setSyncEnabled] = useState(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    load();
    loadSyncStatus();
    const interval = setInterval(() => {
      load();
      loadSyncStatus();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/packing/order-lists?shop_id=${SHOP_ID}`);
      if (res.ok) setLists(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function loadSyncStatus() {
    try {
      const res = await fetch(`${API_BASE}/orders/sync-status`);
      if (res.ok) setSyncEnabled((await res.json()).enabled);
    } catch {
      // best-effort — keeps whatever was last known rather than flashing "checking"
    }
  }

  async function toggleSync() {
    setToggling(true);
    try {
      const res = await fetch(`${API_BASE}/orders/sync-toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !syncEnabled }),
      });
      if (res.ok) setSyncEnabled((await res.json()).enabled);
    } finally {
      setToggling(false);
    }
  }

  const columns = [
    { key: 'processing', title: 'Processing' },
    { key: 'readyToCheck', title: 'Ready to Check' },
    { key: 'onProgressCheck', title: 'On Progress Check' },
    { key: 'readyForPickup', title: 'Ready to Pickup' },
    { key: 'readyTomorrow', title: 'Ready to Process Tomorrow' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ ...card(), display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: syncEnabled ? colors.green : colors.textFaint,
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: colors.text, fontSize: 13.5 }}>
              {syncEnabled === null ? 'Memeriksa status fetching...' : syncEnabled ? 'Fetching Order: Aktif' : 'Fetching Order: Dijeda'}
            </div>
            <div style={{ fontSize: 11.5, color: colors.textDim, marginTop: 1 }}>
              {syncEnabled
                ? 'Server sedang mengambil pesanan baru dari Shopee secara otomatis.'
                : 'Server tidak akan mengambil pesanan baru sampai fetching dimulai di sini.'}
            </div>
          </div>
        </div>
        <button
          onClick={toggleSync}
          disabled={syncEnabled === null || toggling}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            fontWeight: 600,
            fontSize: 13,
            flexShrink: 0,
            cursor: syncEnabled === null || toggling ? 'default' : 'pointer',
            background: syncEnabled ? colors.redDim : colors.greenDim,
            color: syncEnabled ? colors.red : colors.green,
            opacity: toggling ? 0.6 : 1,
          }}
        >
          {syncEnabled ? 'Jeda Fetching' : 'Mulai Fetching'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {columns.map(({ key, title }) => {
        const rows = lists[key];
        return (
          <div key={key} style={{ flex: 1, ...card(), display: 'flex', flexDirection: 'column', minWidth: 0, boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 700, color: colors.text, marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 12 }}>
              {rows.length} order{rows.length === 1 ? '' : 's'}
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {loading ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Loading...</p>
              ) : rows.length === 0 ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Empty.</p>
              ) : (
                rows.map((row) => (
                  <div key={row.order_sn} style={{ padding: 8, borderRadius: 6, background: colors.cardAlt, fontSize: 12.5 }}>
                    <div style={{ fontWeight: 600, color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{row.order_sn}</div>
                    <div style={{ color: colors.textDim, marginTop: 2 }}>
                      {row.buyer_name || '—'}
                      {row.station_id && ` · ${row.station_id}`}
                      {row.operator_name && ` (${row.operator_name})`}
                    </div>
                    {row.status === 'AWAITING_LABEL_SCAN' && (
                      <div style={{ color: colors.red, marginTop: 2, fontWeight: 600 }}>
                        Waiting on confirm-scan — check the printer
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function Daftar() {
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const printFrameRef = useRef(null);

  // Prints the operator's login barcode as an actual scannable Code 39
  // barcode (not just the plain text shown on screen) — this is the card
  // the operator scans at the Packing Station to log in, so it needs to be
  // physically scannable, same encoding as the Hardware Test barcode there.
  function printLoginBarcode(data) {
    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }, 300);
    };
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            body { font-family: monospace; text-align: center; padding: 24px; }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <h2>${data.name}</h2>
          ${renderCode39Svg(data.login_barcode)}
          <p style="letter-spacing: 2px;">${data.login_barcode}</p>
          <p style="font-size: 11px;">Scan this barcode at the Packing Station to log in.</p>
        </body>
      </html>
    `;
  }

  async function handleRegister() {
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/operators/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setResult(data);
      printLoginBarcode(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReprint() {
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/operators/by-name?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setResult(data);
      printLoginBarcode(data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ ...card(), height: '100%', boxSizing: 'border-box' }}>
      <label style={{ color: colors.textDim, fontSize: 13 }}>Nama</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={handleRegister} style={buttonStyle}>Daftar Baru</button>
        <button onClick={handleReprint} style={buttonStyle}>Print Ulang Barcode Login</button>
      </div>
      {result && (
        <p style={{ marginTop: 16, color: colors.text }}>
          Barcode for <strong>{result.name}</strong>:{' '}
          <span style={{ fontFamily: 'monospace', fontSize: 18, color: colors.green }}>{result.login_barcode}</span>
        </p>
      )}
      {error && <p style={{ color: colors.red, marginTop: 16 }}>{error}</p>}
      <iframe ref={printFrameRef} title="operator-barcode-print" style={{ display: 'none' }} />
    </div>
  );
}

function PackingStationDashboard({ view = 'active' }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 160px)' }}>
      {view === 'active' ? <ActiveStation /> : view === 'lists' ? <OrderLists /> : <Daftar />}
    </div>
  );
}

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginTop: 4,
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
};

const buttonStyle = {
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  padding: '8px 14px',
  borderRadius: 6,
  cursor: 'pointer',
};

export default PackingStationDashboard;
