import { useEffect, useState } from 'react';
import { API_BASE } from './apiBase';
import { refreshActiveShopId } from './shopConfig';

// exchangeUrl lets the same component handle both the main app's callback
// and the Brand Portal app's (a separate Shopee app — see ShopeeBrandAuth) —
// each app's code is only valid against its own /auth[/brand]/exchange, so
// which endpoint gets called must match which app's redirect URI brought us
// here (App.jsx's isShopeeBrandCallback decides that from the URL path).
function ShopeeCallback({ onDone, exchangeUrl = '/auth/exchange', title = 'Koneksi Shopee' }) {
  const [message, setMessage] = useState('Menghubungkan ke Shopee...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const shopId = params.get('shop_id');
    const mainAccountId = params.get('main_account_id');

    // Whichever of the two Shopee sent -- see routes/auth.js's runExchange.
    const exchangeParams = new URLSearchParams({ code });
    if (shopId) exchangeParams.set('shop_id', shopId);
    else if (mainAccountId) exchangeParams.set('main_account_id', mainAccountId);

    (async () => {
      try {
        const res = await fetch(`${API_BASE}${exchangeUrl}?${exchangeParams}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error);
        // Only the main app's connection changes which shop is "active" —
        // Brand Portal (exchangeUrl === '/auth/brand/exchange') just adds
        // analytics access for whichever shop is already active, it never
        // switches it.
        if (exchangeUrl === '/auth/exchange') {
          await refreshActiveShopId();
        }
        setMessage('Terhubung! Kembali ke konfigurasi Shopee...');
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
          <p style={{ color: '#c62828' }}>Gagal: {error}</p>
          <button onClick={backToConfig} style={{ padding: '8px 16px', marginTop: 12 }}>Kembali ke menu utama</button>
        </>
      ) : (
        <p>{message}</p>
      )}
    </div>
  );
}

export default ShopeeCallback;
