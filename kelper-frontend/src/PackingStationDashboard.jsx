import { useEffect, useState } from 'react';
import { colors, card } from './theme';

const API_BASE = 'http://localhost:3001';
const REFRESH_MS = 10000;

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

function Daftar() {
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

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
    </div>
  );
}

const NAV_ITEMS = [
  { key: 'active', label: 'Active Station' },
  { key: 'daftar', label: 'Daftar' },
];

function PackingStationDashboard() {
  const [tab, setTab] = useState('active');

  return (
    <div style={{ display: 'flex', gap: 24, background: colors.bg, padding: 20, borderRadius: 8, minHeight: 'calc(100vh - 160px)' }}>
      <style>{`
        .psd-nav-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: 8px 12px;
          border-radius: 6px;
          border: none;
          border-left: 3px solid transparent;
          background: transparent;
          color: ${colors.textDim};
          font-size: 14px;
          cursor: pointer;
          margin-bottom: 2px;
        }
        .psd-nav-item:hover {
          background: ${colors.cardAlt};
          color: ${colors.text};
        }
        .psd-nav-item.active {
          background: ${colors.cardAlt};
          border-left-color: ${colors.blue};
          color: ${colors.text};
          font-weight: 600;
        }
      `}</style>
      <div style={{ width: 180, flexShrink: 0, background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8 }}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`psd-nav-item${tab === item.key ? ' active' : ''}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }}>
        {tab === 'active' ? <ActiveStation /> : <Daftar />}
      </div>
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
