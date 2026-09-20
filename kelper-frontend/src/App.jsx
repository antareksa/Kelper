import { useState } from 'react';
import ShopeeAuth from './ShopeeAuth';
import PackingStation from './PackingStation';
import Dashboard from './Dashboard';
import ShopeeCallback from './ShopeeCallback';
import { colors } from './theme';

function isShopeeCallback() {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && params.has('shop_id');
}

// The Brand Portal app (a separate Shopee app, see ShopeeBrandAuth) is
// registered with its own redirect URI ending in this path, so its callback
// can be told apart from the main app's — both return the same `code`+
// `shop_id` query shape, and sending a Brand-issued code to the main app's
// /auth/exchange (or vice versa) would fail since each code is only valid
// for the app it was issued to.
function isShopeeBrandCallback() {
  return isShopeeCallback() && window.location.pathname === '/shopee-callback-brand';
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
  if (host.startsWith('dashboard')) return 'dashboard';
  return 'landing';
}

function App() {
  // landing | dashboard | packing | shopee-callback | shopee-callback-brand
  const [view, setView] = useState(initialView);

  // Named for what it did before dedicated hostnames existed — now returns
  // to whichever view actually belongs on this hostname (e.g. straight back
  // to Dashboard on dashboard.kelper.co.id, never the generic landing page
  // there), since the query string is cleared first and initialView() reads
  // it fresh.
  function backToLanding() {
    window.history.replaceState(null, '', window.location.pathname);
    setView(initialView());
  }

  if (view === 'shopee-callback') {
    return <ShopeeCallback onDone={backToLanding} />;
  }

  if (view === 'shopee-callback-brand') {
    return <ShopeeCallback onDone={backToLanding} exchangeUrl="/auth/brand/exchange" title="Brand Portal Connection" />;
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
              Open Dashboard
            </button>
            <button onClick={() => setView('packing')} style={secondaryPill}>
              Open Packing Station <span style={{ marginLeft: 6 }}>→</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {view === 'dashboard' && <Dashboard />}
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
