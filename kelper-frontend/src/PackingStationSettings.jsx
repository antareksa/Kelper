import { useEffect, useState } from 'react';
import { colors, card } from './theme';
import { API_BASE, apiFetch } from './apiBase';

// Packing Station configuration (client-requested 2026-09-22), moved from the
// Order Lists screen to Pengaturan (2026-10-16): Delay (minutes an order sits
// in Waiting List before it's eligible for booking/shipping), Max Process
// Order (concurrent Shopee bookings), Max Ready to Check (cap on the
// booked-but-unclaimed pool), the work hour per day, stuck threshold and
// expedition priority. The live "is it work hour now" label stays on the
// Order Lists screen (see PackingStationDashboard.jsx's WorkHourStatus).
function PackingStationSettings() {
  const [settings, setSettings] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch(`${API_BASE}/packing/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setSettings(data);
        setSettingsDraft(data);
      })
      .catch(() => {}); // best-effort: the form stays disabled until this succeeds
  }, []);

  async function saveSettings() {
    setSavingSettings(true);
    setSaved(false);
    try {
      const res = await apiFetch(`${API_BASE}/packing/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsDraft),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setSettingsDraft(data);
        setSaved(true);
      }
    } finally {
      setSavingSettings(false);
    }
  }

  // A number input controlled by `value={draft ?? ''}` with a plain
  // Number(e.target.value) onChange can never actually go empty: clearing
  // the field fires onChange with '', Number('') is 0, and the next render
  // forces the DOM back to "0". Keeping '' as its own draft value lets the
  // field actually clear; Number(e.target.value) still runs for any digit.
  function handleSettingsNumberChange(key) {
    return (e) => {
      const v = e.target.value;
      setSaved(false);
      setSettingsDraft((s) => ({ ...s, [key]: v === '' ? '' : Number(v) }));
    };
  }

  const settingsChanged = settings && settingsDraft && (
    settings.orderDelayMinutes !== settingsDraft.orderDelayMinutes ||
    settings.instantOrderDelayMinutes !== settingsDraft.instantOrderDelayMinutes ||
    settings.maxConcurrentBookings !== settingsDraft.maxConcurrentBookings ||
    settings.maxReadyToCheck !== settingsDraft.maxReadyToCheck ||
    settings.workHourStartHour !== settingsDraft.workHourStartHour ||
    settings.workHourEndHour !== settingsDraft.workHourEndHour ||
    settings.saturdayStartHour !== settingsDraft.saturdayStartHour ||
    settings.saturdayEndHour !== settingsDraft.saturdayEndHour ||
    settings.sundayOff !== settingsDraft.sundayOff ||
    settings.workHourEnabled !== settingsDraft.workHourEnabled ||
    settings.readyToCheckStuckSeconds !== settingsDraft.readyToCheckStuckSeconds ||
    (settings.priorityCarriers ?? '') !== (settingsDraft.priorityCarriers ?? '')
  );

  return (
    <div style={{ ...card(), flexBasis: '100%' }}>
      <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Konfigurasi Packing Station</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <label style={settingsLabelStyle}>Delay (menit)</label>
          <input
            type="number"
            min="0"
            disabled={!settingsDraft}
            value={settingsDraft?.orderDelayMinutes ?? ''}
            onChange={handleSettingsNumberChange('orderDelayMinutes')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Delay Instant (menit)</label>
          <input
            type="number"
            min="0"
            disabled={!settingsDraft}
            value={settingsDraft?.instantOrderDelayMinutes ?? ''}
            onChange={handleSettingsNumberChange('instantOrderDelayMinutes')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Maks Proses Order</label>
          <input
            type="number"
            min="0"
            placeholder="0 = tanpa batas"
            disabled={!settingsDraft}
            value={settingsDraft?.maxConcurrentBookings ?? ''}
            onChange={handleSettingsNumberChange('maxConcurrentBookings')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Maks Siap Dicek</label>
          <input
            type="number"
            min="0"
            placeholder="0 = tanpa batas"
            disabled={!settingsDraft}
            value={settingsDraft?.maxReadyToCheck ?? ''}
            onChange={handleSettingsNumberChange('maxReadyToCheck')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Jam Kerja Mulai (Sen-Jum)</label>
          <input
            type="number"
            min="0"
            max="23"
            disabled={!settingsDraft}
            value={settingsDraft?.workHourStartHour ?? ''}
            onChange={handleSettingsNumberChange('workHourStartHour')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Jam Kerja Selesai (Sen-Jum)</label>
          <input
            type="number"
            min="0"
            max="23"
            disabled={!settingsDraft}
            value={settingsDraft?.workHourEndHour ?? ''}
            onChange={handleSettingsNumberChange('workHourEndHour')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Sabtu Mulai</label>
          <input
            type="number"
            min="0"
            max="23"
            disabled={!settingsDraft}
            value={settingsDraft?.saturdayStartHour ?? ''}
            onChange={handleSettingsNumberChange('saturdayStartHour')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Sabtu Selesai</label>
          <input
            type="number"
            min="0"
            max="23"
            disabled={!settingsDraft}
            value={settingsDraft?.saturdayEndHour ?? ''}
            onChange={handleSettingsNumberChange('saturdayEndHour')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          {/* Sunday off (2026-10-16): the whole day counts as outside work hour. */}
          <label style={settingsLabelStyle}>Minggu</label>
          <button
            type="button"
            disabled={!settingsDraft}
            onClick={() => setSettingsDraft((s) => ({ ...s, sundayOff: !s.sundayOff }))}
            style={{
              padding: '9px 14px',
              borderRadius: 8,
              border: 'none',
              fontWeight: 600,
              fontSize: 13,
              cursor: !settingsDraft ? 'default' : 'pointer',
              background: settingsDraft?.sundayOff ? colors.redDim : colors.greenDim,
              color: settingsDraft?.sundayOff ? colors.red : colors.green,
              opacity: !settingsDraft ? 0.5 : 1,
            }}
          >
            {settingsDraft?.sundayOff ? 'Libur' : 'Masuk (jam Sen-Jum)'}
          </button>
        </div>
        <div>
          {/* Renamed from just "Jam Kerja" — that read as "are we currently
              in work hours", which is a different question from what this
              toggle actually controls (whether the restriction is enforced
              at all). The live answer to "are we in work hours right now"
              is the separate read-only badge below instead. */}
          <label style={settingsLabelStyle}>Batasi Jam Kerja</label>
          <button
            type="button"
            disabled={!settingsDraft}
            onClick={() => setSettingsDraft((s) => ({ ...s, workHourEnabled: !s.workHourEnabled }))}
            style={{
              padding: '9px 14px',
              borderRadius: 8,
              border: 'none',
              fontWeight: 600,
              fontSize: 13,
              cursor: !settingsDraft ? 'default' : 'pointer',
              background: settingsDraft?.workHourEnabled ? colors.greenDim : colors.redDim,
              color: settingsDraft?.workHourEnabled ? colors.green : colors.red,
              opacity: !settingsDraft ? 0.5 : 1,
            }}
          >
            {settingsDraft?.workHourEnabled ? 'Aktif' : 'Nonaktif'}
          </button>
        </div>
        <div>
          <label style={settingsLabelStyle}>Batas Waktu Macet (detik)</label>
          <input
            type="number"
            min="1"
            disabled={!settingsDraft}
            value={settingsDraft?.readyToCheckStuckSeconds ?? ''}
            onChange={handleSettingsNumberChange('readyToCheckStuckSeconds')}
            style={settingsInputStyle}
          />
        </div>
        <div>
          <label style={settingsLabelStyle}>Prioritas Ekspedisi</label>
          <input
            type="text"
            placeholder="mis. SPX, J&T (kosong = tanpa)"
            title="Pisahkan dengan koma; urutan = prioritas. Cukup sebagian nama, mis. SPX untuk SPX Express dan SPX Hemat. Urutan pembagian order: 1. Instant, 2. ekspedisi ini, 3. item lebih sedikit, 4. paling lama."
            disabled={!settingsDraft}
            value={settingsDraft?.priorityCarriers ?? ''}
            onChange={(e) => setSettingsDraft((s) => ({ ...s, priorityCarriers: e.target.value }))}
            style={{ ...settingsInputStyle, width: 210 }}
          />
        </div>
        <button
          onClick={saveSettings}
          disabled={!settingsChanged || savingSettings}
          style={{
            padding: '9px 16px',
            borderRadius: 8,
            border: 'none',
            fontWeight: 600,
            fontSize: 13,
            cursor: !settingsChanged || savingSettings ? 'default' : 'pointer',
            background: colors.text,
            color: colors.bg,
            opacity: !settingsChanged || savingSettings ? 0.5 : 1,
          }}
        >
          {savingSettings ? 'Menyimpan...' : 'Simpan'}
        </button>
      </div>
      {saved && <p style={{ fontSize: 12, color: colors.green, marginTop: 8, marginBottom: 0 }}>Tersimpan.</p>}
    </div>
  );
}

const settingsLabelStyle = {
  display: 'block',
  fontSize: 11.5,
  color: colors.textDim,
  marginBottom: 4,
};

const settingsInputStyle = {
  width: 130,
  padding: '8px 10px',
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
  fontSize: 13,
};

export default PackingStationSettings;
