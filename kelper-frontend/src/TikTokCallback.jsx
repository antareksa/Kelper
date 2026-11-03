import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from './apiBase';

// Where TikTok sends the seller back after they approve the app
// (Partner Center redirect URL: https://<dashboard host>/tiktok-callback).
// Hands the one-time code and the state to the backend, then returns to
// Pengaturan. Needs the admin to be logged in on this browser, since the
// exchange is admin-only.
function TikTokCallback({ onDone }) {
  const [message, setMessage] = useState('Menghubungkan ke TikTok Shop...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const exchangeParams = new URLSearchParams();
    for (const name of ['code', 'auth_code', 'state']) {
      if (params.get(name)) exchangeParams.set(name, params.get(name));
    }

    (async () => {
      try {
        const res = await apiFetch(`${API_BASE}/auth/tiktok/exchange?${exchangeParams}`);
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('Login admin dulu di Dashboard ini, lalu klik Hubungkan lagi dari Pengaturan.');
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
        setMessage('Terhubung! Kembali ke Pengaturan...');
        setTimeout(backToConfig, 1200);
      } catch (err) {
        setError(err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function backToConfig() {
    window.history.replaceState(null, '', '/config/shopee');
    onDone();
  }

  return (
    <div style={{ fontFamily: 'var(--sans)', textAlign: 'center', marginTop: 120 }}>
      <h2>Koneksi TikTok Shop</h2>
      {error ? (
        <>
          <p style={{ color: '#c62828' }}>Gagal: {error}</p>
          <button onClick={backToConfig} style={{ padding: '8px 16px', marginTop: 12 }}>Kembali ke Pengaturan</button>
        </>
      ) : (
        <p>{message}</p>
      )}
    </div>
  );
}

export default TikTokCallback;
