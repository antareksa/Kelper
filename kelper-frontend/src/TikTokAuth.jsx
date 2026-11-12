import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from './apiBase';
import { colors, card } from './theme';

// TikTok Shop connection card for Pengaturan (2026-11-03, login step only,
// no order sync yet). Renders NOTHING unless the backend has the TikTok app
// key/secret in its env file, which only the staging copy has -- so the live
// Dashboard looks exactly as before.
function TikTokAuth() {
  const [status, setStatus] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function loadStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/auth/tiktok/status`);
      setStatus(res.ok ? await res.json() : { configured: false });
    } catch {
      setStatus({ configured: false });
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function call(path, options) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch(`${API_BASE}/auth/tiktok${path}`, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    const data = await call('/login-url');
    if (data?.url) window.location.href = data.url;
  }

  async function handleCheck() {
    const data = await call('/check');
    if (data?.ok) setMessage(`Koneksi OK: ${data.shops.map((s) => s.name).join(', ') || 'tidak ada toko'}`);
  }

  async function handleDisconnect() {
    if (!window.confirm('Putuskan koneksi TikTok Shop di KELPER?')) return;
    const data = await call('/logout', { method: 'POST' });
    if (data?.ok) loadStatus();
  }

  if (!status || !status.configured) return null;
  const conn = status.connection;

  return (
    <div style={{ ...card(), flex: 1, minWidth: 260 }}>
      <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>TikTok Shop (uji coba)</div>
      {conn ? (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: colors.green, lineHeight: 1.4 }}>✓ Terhubung: {conn.sellerName || '-'}</div>
          {conn.shops.map((s) => (
            <div key={s.id} style={{ fontSize: 12, color: colors.textDim, marginTop: 4 }}>
              {s.name} ({s.region}{s.code ? `, ${s.code}` : ''})
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={handleCheck} disabled={busy} style={{ fontSize: 11, padding: '2px 8px' }}>Cek koneksi</button>
            {/* 2026-11-12: authorize again without disconnecting first (e.g. after a
                new permission is added to the app). The old connection keeps
                working until TikTok returns the new one, and all data stays. */}
            <button
              onClick={() => { if (window.confirm('Hubungkan ulang TikTok Shop? Pilih toko yang SAMA di halaman TikTok. Data barang dan pesanan tetap aman.')) handleConnect(); }}
              disabled={busy}
              title="Login ulang ke TikTok tanpa memutuskan koneksi, misalnya setelah izin baru ditambahkan"
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              Hubungkan ulang
            </button>
            <button onClick={handleDisconnect} disabled={busy} style={{ fontSize: 11, padding: '2px 8px', opacity: 0.75 }}>Putuskan</button>
          </div>
        </div>
      ) : (
        <button onClick={handleConnect} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>
          {busy ? 'Membuka TikTok...' : 'Hubungkan'}
        </button>
      )}
      {message && <p style={{ fontSize: 12, color: colors.green, marginTop: 8, marginBottom: 0 }}>{message}</p>}
      {error && <p style={{ fontSize: 12, color: colors.red, marginTop: 8, marginBottom: 0 }}>{error}</p>}
    </div>
  );
}

export default TikTokAuth;
