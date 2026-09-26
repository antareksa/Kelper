import { useEffect, useState } from 'react';
import { API_BASE } from './apiBase';

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
        setTimeout(backToConfig, 1200);
      } catch (err) {
        setError(err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Either outcome sends the person back to the page where they clicked
  // Connect in the first place, so they can see the result and retry
  // without hunting for the Dashboard's default /home.
  function backToConfig() {
    window.history.replaceState(null, '', '/config/shopee');
    onDone();
  }

  return (
    <div style={{ fontFamily: 'var(--sans)', textAlign: 'center', marginTop: 120 }}>
      <h2>{title}</h2>
      {error ? (
        <>
          <p style={{ color: '#c62828' }}>Failed: {error}</p>
          <button onClick={backToConfig} style={{ padding: '8px 16px', marginTop: 12 }}>Back to main menu</button>
        </>
      ) : (
        <p>{message}</p>
      )}
    </div>
  );
}

export default ShopeeCallback;
