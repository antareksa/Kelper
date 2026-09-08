import { useState } from 'react';
import ShopeeAuth from './ShopeeAuth';
import PackingStation from './PackingStation';
import Dashboard from './Dashboard';
import ShopeeCallback from './ShopeeCallback';

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
      <div style={{ fontFamily: 'sans-serif', position: 'relative', minHeight: '100vh' }}>
        <div style={{ position: 'absolute', top: 16, right: 16 }}>
          <ShopeeAuth />
        </div>
        <div style={{ textAlign: 'center', marginTop: 80 }}>
          <h1>KELPER</h1>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 24 }}>
            <button onClick={() => setView('dashboard')} style={{ padding: '16px 32px', fontSize: 16 }}>
              Open Dashboard
            </button>
            <button onClick={() => setView('packing')} style={{ padding: '16px 32px', fontSize: 16 }}>
              Open Packing Station
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, padding: 12, fontFamily: 'sans-serif' }}>
        <button onClick={() => setView('landing')}>← Back</button>
      </div>
      {view === 'dashboard' && <Dashboard />}
      {view === 'packing' && <PackingStation />}
    </div>
  );
}

export default App;
