import { useEffect, useState } from 'react';
import ShopeeAuth from './ShopeeAuth';
import ShopeeBrandAuth from './ShopeeBrandAuth';
import { colors, card } from './theme';
import { API_BASE, apiFetch } from './apiBase';

// Dashboard configuration (client-requested 2026-09-22) — currently just Ads
// tax percentage, a multiplier added on top of raw Shopee ad spend before
// it's shown as Iklan on the Dashboard. Lives here (the general Settings
// page, reached via the sidebar's "Settings" button) rather than a separate
// route, since there's only this one field so far.
function DashboardSettings() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch(`${API_BASE}/dashboard/settings`)
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setDraft(String(data.adsTaxPercentage));
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await apiFetch(`${API_BASE}/dashboard/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adsTaxPercentage: Number(draft) }),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setDraft(String(data.adsTaxPercentage));
        setSaved(true);
      }
    } finally {
      setSaving(false);
    }
  }

  const changed = settings && Number(draft) !== settings.adsTaxPercentage;

  return (
    <div style={{ ...card(), flex: 1, minWidth: 260 }}>
      <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Pengaturan Dashboard</div>
      <label style={{ display: 'block', fontSize: 12, color: colors.textDim, marginBottom: 4 }}>
        Ads tax percentage (%)
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="number"
          min="0"
          step="0.1"
          disabled={!settings}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          style={{
            width: 100,
            padding: '8px 10px',
            boxSizing: 'border-box',
            background: colors.cardAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            color: colors.text,
            fontSize: 13,
          }}
        />
        <button
          onClick={handleSave}
          disabled={!changed || saving}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            fontWeight: 600,
            fontSize: 13,
            cursor: !changed || saving ? 'default' : 'pointer',
            background: colors.text,
            color: colors.bg,
            opacity: !changed || saving ? 0.5 : 1,
          }}
        >
          {saving ? 'Menyimpan...' : 'Simpan'}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Persentase ini ditambahkan di atas pengeluaran Iklan mentah dari Shopee sebelum ditampilkan di Dashboard.
      </p>
      {saved && <p style={{ fontSize: 12, color: colors.green, marginTop: 8, marginBottom: 0 }}>Tersimpan.</p>}
    </div>
  );
}

// Dedicated page for both Shopee connections (main app for order sync,
// Brand Portal app for Affiliasi/Pengunjung) — moved here from the sidebar's
// bottom-left so checking/managing them doesn't take up permanent space in
// every other screen; this is purely a status/control page, nothing else.
function ShopeeConfigPage() {
  return (
    <div style={{ color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)', marginBottom: 16 }}>
        Konfigurasi Shopee
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card(), flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Koneksi Utama (Order Sync)</div>
          <ShopeeAuth />
        </div>

        <div style={{ ...card(), flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Brand Portal (Affiliasi/Pengunjung)</div>
          <ShopeeBrandAuth />
        </div>

        <DashboardSettings />
      </div>
    </div>
  );
}

export default ShopeeConfigPage;
