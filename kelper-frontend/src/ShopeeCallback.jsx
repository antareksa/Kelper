import { useEffect, useState } from 'react';

// Resolves relative to whatever host served this page, so a client machine
// on the LAN reaches the real backend instead of its own empty localhost.
const API_BASE = `http://${window.location.hostname}:3001`;

function ShopeeCallback({ onDone }) {
  const [message, setMessage] = useState('Connecting to Shopee...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const shopId = params.get('shop_id');

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/exchange?code=${code}&shop_id=${shopId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error);
        setMessage('Connected! Returning to the main menu...');
        setTimeout(() => onDone(), 1200);
      } catch (err) {
        setError(err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ fontFamily: 'var(--sans)', textAlign: 'center', marginTop: 120 }}>
      <h2>Shopee Connection</h2>
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
