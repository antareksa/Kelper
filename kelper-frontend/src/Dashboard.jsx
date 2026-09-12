import { useState } from 'react';
import PackingStationDashboard from './PackingStationDashboard';
import MainDashboard from './MainDashboard';
import ListBarang from './ListBarang';
import HppBiaya from './HppBiaya';
import { colors } from './theme';
import { IconGrid, IconBox, IconMonitor, IconUser, IconTag, IconChevronDown, IconBell, IconSettings, IconPower } from './Icons';

const DASHBOARD_TAB = { key: 'main', label: 'Dashboard', Icon: IconGrid };

const ITEMS_GROUP = { key: 'items', label: 'List Barang', Icon: IconBox };
const ITEMS_SUB_ITEMS = [
  { key: 'produk', label: 'Produk', Icon: IconBox },
  { key: 'hpp', label: 'HPP & Biaya', Icon: IconTag },
];

const PACKING_GROUP = { key: 'packing', label: 'Packing Station Dashboard', Icon: IconMonitor };
const PACKING_SUB_ITEMS = [
  { key: 'active', label: 'Active Station', Icon: IconMonitor },
  { key: 'daftar', label: 'Daftar', Icon: IconUser },
];

const DashboardIcon = DASHBOARD_TAB.Icon;
const ItemsIcon = ITEMS_GROUP.Icon;
const PackingIcon = PACKING_GROUP.Icon;

function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('main'); // main | items | packing
  const [itemsView, setItemsView] = useState('produk'); // produk | hpp
  const [packingView, setPackingView] = useState('active'); // active | daftar

  async function handleLogin(e) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(`http://localhost:3001/admin/login`, {
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
      <div style={{ background: colors.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)' }}>
        <form onSubmit={handleLogin} style={{ ...cardStyle, width: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <IconGrid size={18} />
            <span style={{ fontWeight: 700, fontSize: 16, color: colors.text, fontFamily: 'var(--heading)' }}>KELPER Admin</span>
          </div>
          <label style={labelStyle}>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
          <button type="submit" style={submitStyle}>Login</button>
          {error && <p style={{ color: colors.red, marginTop: 12, fontSize: 13 }}>{error}</p>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ background: colors.bg, height: '100vh', display: 'flex', overflow: 'hidden', fontFamily: 'var(--sans)' }}>
      <>
        {/* Sidebar */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            height: '100vh',
            borderRight: `1px solid ${colors.border}`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: 20,
            boxSizing: 'border-box',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', marginBottom: 24 }}>
              <IconGrid size={18} />
              <span style={{ fontWeight: 700, fontSize: 15, color: colors.text, letterSpacing: 0.3, fontFamily: 'var(--heading)' }}>KELPER</span>
            </div>
            <div style={{ fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 10px', marginBottom: 6 }}>
              Main
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                onClick={() => setTab(DASHBOARD_TAB.key)}
                style={navItemStyle(tab === DASHBOARD_TAB.key)}
              >
                <DashboardIcon size={16} />
                {DASHBOARD_TAB.label}
              </button>

              <button
                onClick={() => setTab(ITEMS_GROUP.key)}
                style={navItemStyle(tab === ITEMS_GROUP.key)}
              >
                <ItemsIcon size={16} />
                <span style={{ flex: 1 }}>{ITEMS_GROUP.label}</span>
                <span style={{ display: 'flex', transform: tab === ITEMS_GROUP.key ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
                  <IconChevronDown size={12} />
                </span>
              </button>
              {tab === ITEMS_GROUP.key && (
                <div style={{ marginLeft: 18, marginTop: 6, paddingLeft: 10, borderLeft: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {ITEMS_SUB_ITEMS.map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setItemsView(key)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: 'none',
                        background: itemsView === key ? colors.cardAlt : 'transparent',
                        color: itemsView === key ? colors.text : colors.textDim,
                        fontSize: 13.5,
                        fontWeight: itemsView === key ? 600 : 400,
                        cursor: 'pointer',
                        fontFamily: 'var(--sans)',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => setTab(PACKING_GROUP.key)}
                style={navItemStyle(tab === PACKING_GROUP.key)}
              >
                <PackingIcon size={16} />
                <span style={{ flex: 1 }}>{PACKING_GROUP.label}</span>
                <span style={{ display: 'flex', transform: tab === PACKING_GROUP.key ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
                  <IconChevronDown size={12} />
                </span>
              </button>
              {tab === PACKING_GROUP.key && (
                <div style={{ marginLeft: 18, marginTop: 6, paddingLeft: 10, borderLeft: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {PACKING_SUB_ITEMS.map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setPackingView(key)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: 'none',
                        background: packingView === key ? colors.cardAlt : 'transparent',
                        color: packingView === key ? colors.text : colors.textDim,
                        fontSize: 13.5,
                        fontWeight: packingView === key ? 600 : 400,
                        cursor: 'pointer',
                        fontFamily: 'var(--sans)',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </nav>
          </div>

          <div>
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={sideItemStyle}>
                <IconBell size={16} />
                Notifications
              </div>
              <div style={sideItemStyle}>
                <IconSettings size={16} />
                Settings
              </div>
              <button
                onClick={() => setAuthenticated(false)}
                style={{ ...sideItemStyle, background: 'none', border: 'none', cursor: 'pointer', width: '100%', fontFamily: 'var(--sans)' }}
              >
                <IconPower size={16} />
                Logout
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '8px 8px 0' }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: colors.cardAlt,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors.text,
                }}
              >
                A
              </div>
              <span style={{ fontSize: 13, color: colors.text, fontWeight: 600 }}>Admin</span>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: 1, height: '100vh', overflowY: 'auto', padding: 24, boxSizing: 'border-box' }}>
          {tab === 'main' && <MainDashboard />}

          {tab === 'items' && (itemsView === 'produk' ? <ListBarang /> : <HppBiaya />)}

          {tab === 'packing' && <PackingStationDashboard view={packingView} />}
        </div>
      </>
    </div>
  );
}

const cardStyle = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 16,
  padding: 24,
  boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block',
  fontSize: 12,
  color: colors.textDim,
  marginBottom: 4,
};

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginBottom: 14,
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  color: colors.text,
  fontFamily: 'var(--sans)',
};

const submitStyle = {
  width: '100%',
  padding: '10px 16px',
  background: colors.text,
  color: colors.bg,
  border: 'none',
  borderRadius: 8,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
};

function navItemStyle(active) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    padding: '9px 10px',
    borderRadius: 8,
    border: 'none',
    background: active ? colors.cardAlt : 'transparent',
    color: active ? colors.text : colors.textDim,
    fontSize: 13.5,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
  };
}

const sideItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  fontSize: 13,
  color: colors.textDim,
};

export default Dashboard;
