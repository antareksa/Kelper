import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import PackingStationDashboard from './PackingStationDashboard';
import MainDashboard from './MainDashboard';
import ListBarang from './ListBarang';
import OrderSearch from './OrderSearch';
import OperatorPerformance from './OperatorPerformance';
import ShopeeConfigPage from './ShopeeConfigPage';
import { useShopeeConnection } from './useShopeeConnection';
import { SHOP_ID } from './shopConfig';
import { colors } from './theme';
import { IconGrid, IconBox, IconMonitor, IconUser, IconTag, IconChevronDown, IconSettings, IconPower, IconAlertTriangle, IconSearch, IconHistory } from './Icons';
import { API_BASE, apiFetch, setAdminToken, clearAdminToken, getAdminToken } from './apiBase';

const DASHBOARD_TAB = { path: '/home', label: 'Dashboard', Icon: IconGrid };
const ITEMS_TAB = { path: '/list-barang', label: 'List Barang', Icon: IconBox };
const ORDER_TAB = { path: '/order', label: 'Order', Icon: IconSearch };

const PACKING_GROUP = { path: '/packing-station', label: 'Packing Station Dashboard', Icon: IconMonitor };
const PACKING_SUB_ITEMS = [
  { path: '/packing-station/order-lists', label: 'Orderan', Icon: IconTag },
  { path: '/packing-station/daftar', label: 'Daftar Staff', Icon: IconUser },
  { path: '/packing-station/cancel-masalah', label: 'Orderan Bermasalah', Icon: IconAlertTriangle },
  { path: '/packing-station/kinerja-operator', label: 'Kinerja Operator', Icon: IconHistory },
];

const DashboardIcon = DASHBOARD_TAB.Icon;
const ItemsIcon = ITEMS_TAB.Icon;
const OrderIcon = ORDER_TAB.Icon;
const PackingIcon = PACKING_GROUP.Icon;

function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  // Optimistic — trusts a stored token until an actual API call proves
  // otherwise (a 401 on an admin route). Previously this was plain in-memory
  // state that reset to false on every reload; now that login issues a real
  // session (see adminSession.js), there's a token worth trusting across
  // reloads instead of forcing a fresh login every time.
  const [authenticated, setAuthenticated] = useState(() => !!getAdminToken());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [shopeeModalDismissed, setShopeeModalDismissed] = useState(false);

  // Checked only once actually logged in (not on the login form) — a fresh
  // check every login, since local dismissal state resets on reload, so
  // this can't go permanently silent while still disconnected.
  const shopee = useShopeeConnection(authenticated);
  const showShopeeModal = authenticated && !shopee.checking && !shopee.connected && !shopeeModalDismissed;

  // Client-requested (2026-09-29): a red badge on "Batal & Masalah" so an
  // unresolved cancellation/problem order isn't only visible to someone who
  // happens to open that screen -- polls a cheap count endpoint rather than
  // the full list, since this is always mounted regardless of which page is
  // open. Only runs once actually logged in with a shop connected.
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  useEffect(() => {
    if (!authenticated || !SHOP_ID) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await apiFetch(`${API_BASE}/packing/unresolved-count?shop_id=${SHOP_ID}`);
        if (res.ok && !cancelled) setUnresolvedCount((await res.json()).count);
      } catch {
        // best-effort -- a missed poll just means a stale badge until the next one
      }
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [authenticated]);

  // Gives the login screen its own real URL rather than just showing it
  // inline at whatever path happened to be current. Doesn't preserve the
  // originally-requested path through login — same as the Shopee OAuth
  // callback, which also always lands on one fixed page rather than
  // wherever the person started.
  useEffect(() => {
    if (!authenticated && location.pathname !== '/admin-login') {
      navigate('/admin-login', { replace: true });
    }
    if (authenticated && location.pathname === '/admin-login') {
      navigate('/home', { replace: true });
    }
  }, [authenticated, location.pathname, navigate]);

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
      setAdminToken(data.token);
      setAuthenticated(true);
    } catch (err) {
      setError(err.message);
    }
  }

  function handleLogout() {
    apiFetch(`${API_BASE}/admin/logout`, { method: 'POST' }).catch(() => {
      // best-effort — the token gets forgotten client-side regardless
    });
    clearAdminToken();
    setAuthenticated(false);
  }

  if (!authenticated) {
    return (
      <div style={{ background: colors.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)' }}>
        <form onSubmit={handleLogin} style={{ ...cardStyle, width: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <IconGrid size={18} />
            <span style={{ fontWeight: 700, fontSize: 16, color: colors.text, fontFamily: 'var(--heading)' }}>KELPER Admin</span>
          </div>
          <label style={labelStyle}>Nama Pengguna</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>Kata Sandi</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
          <button type="submit" style={submitStyle}>Masuk</button>
          {error && <p style={{ color: colors.red, marginTop: 12, fontSize: 13 }}>{error}</p>}
        </form>
      </div>
    );
  }

  // Client-requested (2026-09-27): no shop has ever connected (SHOP_ID is
  // only null in that case — see shopConfig.js). Unlike showShopeeModal
  // below (a dismissible reminder for a shop that WAS connected but its
  // token lapsed), there's no historical data to fall back to here, so
  // every route under this would just fire shop_id-less requests and show
  // empty/broken content. Blocks the whole dashboard, not dismissible --
  // except /config/shopee itself (see the pathname check below), which is
  // where the actual "Hubungkan" controls for both the main app and Brand
  // Portal live and needs no shop_id to render.
  if (!SHOP_ID && location.pathname !== '/config/shopee') {
    return (
      <div style={{ background: colors.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)' }}>
        <div style={{ ...cardStyle, width: 360, textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: colors.text, marginBottom: 10, fontFamily: 'var(--heading)' }}>
            Hubungkan Shopee
          </div>
          <p style={{ fontSize: 13, color: colors.textDim, marginBottom: 22, lineHeight: 1.55 }}>
            Belum ada toko Shopee yang terhubung. Hubungkan toko Anda terlebih dahulu untuk menggunakan Dashboard.
          </p>
          {/* Client-requested (2026-10-02): goes to the Settings page
              (where the real Shopee connection controls live) instead of
              immediately firing the OAuth login itself -- lets the admin
              see/choose which app (main vs Brand Portal) to connect, rather
              than this button always kicking off the main app's login. */}
          <button onClick={() => navigate('/config/shopee')} style={submitStyle}>
            Hubungkan
          </button>
        </div>
      </div>
    );
  }

  // Client-requested (2026-09-30): full-screen, no sidebar at all — a TV/
  // monitor display in the packing area, not an admin working screen. Every
  // other route always gets the sidebar shell below; this one specific path
  // bypasses it entirely rather than adding a "hide sidebar" prop that every
  // other route would have to remember not to set.
  if (location.pathname === '/packing-station/order-lists/view-only') {
    return (
      <div style={{ background: colors.bg, height: '100vh', boxSizing: 'border-box', padding: 24, overflow: 'hidden', fontFamily: 'var(--sans)' }}>
        <PackingStationDashboard view="listsViewOnly" />
      </div>
    );
  }

  return (
    <div style={{ background: colors.bg, height: '100vh', display: 'flex', overflow: 'hidden', fontFamily: 'var(--sans)' }}>
      <>
        {showShopeeModal && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
            }}
          >
            <div style={{ ...cardStyle, width: 360, textAlign: 'center' }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: colors.text, marginBottom: 10, fontFamily: 'var(--heading)' }}>
                Hubungkan Shopee
              </div>
              <p style={{ fontSize: 13, color: colors.textDim, marginBottom: 22, lineHeight: 1.55 }}>
                Toko belum terhubung ke Shopee. Sinkronisasi pesanan dan katalog produk tidak akan berjalan sampai ini terhubung.
              </p>
              <button onClick={shopee.loginShopee} style={{ ...submitStyle, marginBottom: 10 }}>
                Hubungkan
              </button>
              <button
                onClick={() => setShopeeModalDismissed(true)}
                style={{ background: 'none', border: 'none', color: colors.textDim, fontSize: 12.5, cursor: 'pointer', fontFamily: 'var(--sans)' }}
              >
                Nanti saja
              </button>
            </div>
          </div>
        )}

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', marginBottom: 10 }}>
              <IconGrid size={18} />
              <span style={{ fontWeight: 700, fontSize: 15, color: colors.text, letterSpacing: 0.3, fontFamily: 'var(--heading)' }}>KELPER</span>
            </div>
            <div style={{ fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 10px', marginBottom: 6 }}>
              Utama
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                onClick={() => navigate(DASHBOARD_TAB.path)}
                style={navItemStyle(location.pathname === DASHBOARD_TAB.path)}
              >
                <DashboardIcon size={16} />
                {DASHBOARD_TAB.label}
              </button>

              <button
                onClick={() => navigate(ITEMS_TAB.path)}
                style={navItemStyle(location.pathname === ITEMS_TAB.path)}
              >
                <ItemsIcon size={16} />
                {ITEMS_TAB.label}
              </button>

              <button
                onClick={() => navigate(ORDER_TAB.path)}
                style={navItemStyle(location.pathname === ORDER_TAB.path)}
              >
                <OrderIcon size={16} />
                {ORDER_TAB.label}
              </button>

              <button
                onClick={() => navigate(PACKING_SUB_ITEMS[0].path)}
                style={navItemStyle(location.pathname.startsWith(PACKING_GROUP.path))}
              >
                <PackingIcon size={16} />
                <span style={{ flex: 1 }}>{PACKING_GROUP.label}</span>
                <span style={{ display: 'flex', transform: location.pathname.startsWith(PACKING_GROUP.path) ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
                  <IconChevronDown size={12} />
                </span>
              </button>
              {location.pathname.startsWith(PACKING_GROUP.path) && (
                <div style={{ marginLeft: 18, marginTop: 6, paddingLeft: 10, borderLeft: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {PACKING_SUB_ITEMS.map(({ path, label }) => (
                    <button
                      key={path}
                      onClick={() => navigate(path)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: 'none',
                        background: location.pathname === path ? colors.cardAlt : 'transparent',
                        color: location.pathname === path ? colors.text : colors.textDim,
                        fontSize: 13.5,
                        fontWeight: location.pathname === path ? 600 : 400,
                        cursor: 'pointer',
                        fontFamily: 'var(--sans)',
                      }}
                    >
                      <span>{label}</span>
                      {path === '/packing-station/cancel-masalah' && unresolvedCount > 0 && (
                        <span
                          style={{
                            flexShrink: 0,
                            minWidth: 16,
                            height: 16,
                            padding: '0 4px',
                            borderRadius: 8,
                            background: colors.red,
                            color: '#fff',
                            fontSize: 10.5,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontFamily: 'var(--sans)',
                          }}
                        >
                          {unresolvedCount > 99 ? '99+' : unresolvedCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </nav>
          </div>

          <div>
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* Shopee connection status/controls used to live here directly
                  (and before that, the old landing page's top-right corner) —
                  moved to its own /config/shopee page instead of taking up
                  permanent sidebar space, since it's a status page you check
                  occasionally, not something needed on every screen. */}
              <button
                onClick={() => navigate('/config/shopee')}
                style={{ ...sideItemStyle, background: location.pathname === '/config/shopee' ? colors.cardAlt : 'none', border: 'none', cursor: 'pointer', width: '100%', fontFamily: 'var(--sans)', textAlign: 'left' }}
              >
                <IconSettings size={16} />
                Pengaturan
              </button>
              <button
                onClick={handleLogout}
                style={{ ...sideItemStyle, background: 'none', border: 'none', cursor: 'pointer', width: '100%', fontFamily: 'var(--sans)' }}
              >
                <IconPower size={16} />
                Keluar
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
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<MainDashboard />} />
            <Route path="/list-barang" element={<ListBarang />} />
            <Route path="/order" element={<OrderSearch />} />
            <Route path="/packing-station" element={<Navigate to="/packing-station/order-lists" replace />} />
            <Route path="/packing-station/active-station" element={<PackingStationDashboard view="active" />} />
            <Route path="/packing-station/order-lists" element={<PackingStationDashboard view="lists" />} />
            <Route path="/packing-station/daftar" element={<PackingStationDashboard view="daftar" />} />
            <Route path="/packing-station/cancel-masalah" element={<PackingStationDashboard view="cancelMasalah" />} />
            <Route path="/packing-station/kinerja-operator" element={<OperatorPerformance />} />
            <Route path="/config/shopee" element={<ShopeeConfigPage />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
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
