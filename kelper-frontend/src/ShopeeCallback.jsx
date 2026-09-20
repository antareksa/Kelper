import { useEffect, useState } from 'react';

// A production build is served from the same origin as the API (Caddy
// proxies both from one hostname), so relative paths just work and http://
// would break under HTTPS as mixed content anyway. Dev still needs the
// explicit cross-origin call since Vite's dev server (5173) and the backend
// (3001) really are different origins there.
const API_BASE = import.meta.env.PROD ? '' : `http://${window.location.hostname}:3001`;

// exchangeUrl lets the same component handle both the main app's callback
// and the Brand Portal app's (a separate Shopee app — see ShopeeBrandAuth) —
// each app's code is only valid against its own /auth[/brand]/exchange, so
// which endpoint gets called must match which app's redirect URI brought us
// here (App.jsx's isShopeeBrandCallback decides that from the URL path).
function ShopeeCallback({ onDone, exchangeUrl = '/auth/exchange', title = 'Shopee Connection' }) {
  const [message, setMessage] = useState('Connecting to Shopee...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const shopId = params.get('shop_id');

    (async () => {
      try {
        const res = await fetch(`${API_BASE}${exchangeUrl}?code=${code}&shop_id=${shopId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error);
        setMessage('Connected! Returning to Shopee config...');
        setTimeout(() => {
          // Land back on the config page (where the connection widgets
          // live) rather than the Dashboard's default /home — onDone
          // (App.jsx's backToLanding) re-derives the view from whatever
          // pathname is current, so setting it here before calling onDone
          // is what actually decides where that ends up.
          window.history.replaceState(null, '', '/config/shopee');
          onDone();
        }, 1200);
      } catch (err) {
        setError(err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ fontFamily: 'var(--sans)', textAlign: 'center', marginTop: 120 }}>
      <h2>{title}</h2>
      {error ? (
        <>
          <p style={{ color: '#c62828' }}>Failed: {error}</p>
          <button onClick={onDone} style={{ padding: '8px 16px', marginTop: 12 }}>Back to main menu</button>
        </>
      ) : (
        <p>{message}</p>
      )}
    </div>
  );
}

export default ShopeeCallback;
