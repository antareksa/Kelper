import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import ShopeeAuth from './ShopeeAuth';
import PackingStation from './PackingStation';
import Dashboard from './Dashboard';
import ShopeeCallback from './ShopeeCallback';
import { colors } from './theme';
import { initActiveShopId } from './shopConfig';
import { API_BASE } from './apiBase';

// Captured at module load, before anything renders: Dashboard's router
// redirects unknown paths (a /check-connection landing it doesn't recognize
// becomes /home) before App's own effects run, which would otherwise leave
// nothing to report.
const LANDING_PATH = window.location.pathname.replace(/\/+$/, '');
const LANDING_PARAM_NAMES = [...new URLSearchParams(window.location.search).keys()];

// A Shopee redirect always lands on /check-connection or
// /check-connection-brand with a one-time `code`; which id comes with it
// depends on the kind of authorization (shop_id for a shop account,
// main_account_id for a main account, others for other kinds -- see
// routes/auth.js's runExchange). Requiring a specific id here made a callback
// carrying a different one silently open as a normal Dashboard, so the path
// plus the code is what identifies it now. (A code+shop_id on any other path
// still counts, as before.)
function isShopeeCallback() {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && (window.location.pathname.startsWith('/check-connection') || params.has('shop_id'));
}

// The Brand Portal app (a separate Shopee app, see ShopeeBrandAuth) is
// registered with its own redirect URI ending in this path (the main app
// uses /check-connection instead — see .env's SHOPEE_REDIRECT_URI), so its
// callback can be told apart from the main app's — both return the same
// `code`+`shop_id` query shape, and sending a Brand-issued code to the main
// app's /auth/exchange (or vice versa) would fail since each code is only
// valid for the app it was issued to.
function isShopeeBrandCallback() {
  return isShopeeCallback() && window.location.pathname === '/check-connection-brand';
}

// A dedicated hostname (e.g. dashboard.kelper.co.id / packing.kelper.co.id)
// jumps straight to that view — most useful for a Packing Station kiosk,
// which can then launch directly into station setup instead of needing a
// mouse click on the landing page every boot. Anything else (localhost, a
// bare IP, the root domain) falls back to the landing page with both
// buttons, unchanged from before.
function initialView() {
  if (isShopeeBrandCallback()) return 'shopee-callback-brand';
  if (isShopeeCallback()) return 'shopee-callback';
  const host = window.location.hostname;
  if (host.startsWith('packing')) return 'packing';
  // The quick launcher names the station in the address (?station=<PC name>);
  // that is a Packing Station on any host, including a local preview.
  if (new URLSearchParams(window.location.search).has('station')) return 'packing';
  if (host.startsWith('dashboard')) return 'dashboard';
  return 'landing';
}

function App() {
  // landing | dashboard | packing | shopee-callback | shopee-callback-brand
  const [view, setView] = useState(initialView);
  // Every view below (including 'landing', via ShopeeAuth's connection
  // check) reads shopConfig's SHOP_ID — gating first render on this
  // resolving means nothing ever runs against the stale build-time
  // fallback while the real active shop is still loading.
  const [shopIdReady, setShopIdReady] = useState(false);

  useEffect(() => {
    initActiveShopId().finally(() => setShopIdReady(true));
  }, []);

  // Tells the backend a Shopee authorization just landed here, and which
  // query parameter NAMES came with it (never values -- the code is a
  // one-time credential), so a connection that silently doesn't complete
  // can be diagnosed from the server log instead of needing the person who
  // authorized to dig through their browser history. See routes/auth.js's
  // /callback-seen.
  useEffect(() => {
    if (!LANDING_PATH.startsWith('/check-connection')) return;
    fetch(`${API_BASE}/auth/callback-seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: LANDING_PATH, params: LANDING_PARAM_NAMES }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  // Named for what it did before dedicated hostnames existed — now returns
  // to whichever view actually belongs on this hostname (e.g. straight back
  // to Dashboard on dashboard.kelper.co.id, never the generic landing page
  // there), since the query string is cleared first and initialView() reads
  // it fresh.
  function backToLanding() {
    window.history.replaceState(null, '', window.location.pathname);
    setView(initialView());
  }

  if (!shopIdReady) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.bg, color: colors.textDim, fontFamily: 'var(--sans)' }}>
        Memuat...
      </div>
    );
  }

  if (view === 'shopee-callback') {
    return <ShopeeCallback onDone={backToLanding} />;
  }

  if (view === 'shopee-callback-brand') {
    return <ShopeeCallback onDone={backToLanding} exchangeUrl="/auth/brand/exchange" title="Koneksi Brand Portal" />;
  }

  if (view === 'landing') {
    return (
      <div
        style={{
          fontFamily: 'var(--sans)',
          position: 'relative',
          minHeight: '100vh',
          background: colors.bg,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 2 }}>
          <ShopeeAuth />
        </div>

        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: 640,
            height: 640,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(circle, ${colors.blue}3a 0%, transparent 70%)`,
            filter: 'blur(50px)',
            pointerEvents: 'none',
          }}
        />

        <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
          <h1 style={{ fontSize: 64, fontWeight: 700, color: colors.text, margin: 0, letterSpacing: -1.5, fontFamily: 'var(--heading)' }}>
            KELPER
          </h1>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 36 }}>
            <button onClick={() => setView('dashboard')} style={primaryPill}>
              Buka Dashboard
            </button>
            <button onClick={() => setView('packing')} style={secondaryPill}>
              Buka Packing Station <span style={{ marginLeft: 6 }}>→</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Only the Dashboard gets real sub-URLs (/home, /list-barang, ...) —
          the Packing Station kiosk app has no equivalent need for them, and
          wrapping it too would just be dead weight. */}
      {view === 'dashboard' && (
        <BrowserRouter>
          <Dashboard />
        </BrowserRouter>
      )}
      {view === 'packing' && <PackingStation />}
    </div>
  );
}

const pillBase = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '14px 28px',
  borderRadius: 999,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  border: 'none',
};

const primaryPill = {
  ...pillBase,
  background: colors.text,
  color: colors.bg,
};

const secondaryPill = {
  ...pillBase,
  background: colors.cardAlt,
  color: colors.text,
  border: `1px solid ${colors.border}`,
};

export default App;
