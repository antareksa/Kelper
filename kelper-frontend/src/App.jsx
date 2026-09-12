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

function App() {
  // landing | dashboard | packing | shopee-callback
  const [view, setView] = useState(() => (isShopeeCallback() ? 'shopee-callback' : 'landing'));

  function backToLanding() {
    window.history.replaceState(null, '', window.location.pathname);
    setView('landing');
  }

  if (view === 'shopee-callback') {
    return <ShopeeCallback onDone={backToLanding} />;
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
