import { useState } from 'react';
import PackingStationDashboard from './PackingStationDashboard';
import MainDashboard from './MainDashboard';
import { colors } from './theme';

const API_BASE = 'http://localhost:3001';

const TABS = [
  { key: 'main', label: 'Dashboard' },
  { key: 'items', label: 'List Barang' },
  { key: 'packing', label: 'Packing Station Dashboard' },
];

function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('main'); // main | items | packing

  async function handleLogin(e) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setAuthenticated(true);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!authenticated) {
    return (
      <form onSubmit={handleLogin} style={{ maxWidth: 320, margin: '40px auto', fontFamily: 'sans-serif' }}>
        <h2>Admin Login</h2>
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        <button type="submit" style={{ marginTop: 12, padding: '8px 16px' }}>Login</button>
        {error && <p style={{ color: '#c62828', marginTop: 12 }}>{error}</p>}
      </form>
    );
  }

  return (
    <div style={{ fontFamily: 'sans-serif', background: colors.bg, minHeight: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 32,
          padding: '0 24px',
          height: 56,
          background: colors.card,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16, color: colors.text, letterSpacing: 0.5 }}>KELPER</span>
        <nav style={{ display: 'flex', gap: 28, height: '100%' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${tab === t.key ? colors.blue : 'transparent'}`,
                color: tab === t.key ? colors.blue : colors.textDim,
                fontSize: 14,
                fontWeight: tab === t.key ? 600 : 400,
                cursor: 'pointer',
                height: '100%',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div style={{ padding: '20px 32px' }}>
        {tab === 'main' && <MainDashboard />}

        {tab === 'items' && (
          <div style={{ color: colors.text }}>
            <h2>List Barang</h2>
            <p style={{ opacity: 0.7 }}>Not built yet — needs the Shopee Product API.</p>
          </div>
        )}

        {tab === 'packing' && <PackingStationDashboard />}
      </div>
    </div>
  );
}

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginTop: 4,
  marginBottom: 12,
  boxSizing: 'border-box',
};

export default Dashboard;
