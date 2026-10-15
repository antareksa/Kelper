import { useCallback, useEffect, useState } from 'react';
import { colors, card } from './theme';
import { API_BASE, apiFetch } from './apiBase';
import { SHOP_ID } from './shopConfig';

// Client-requested (2026-10-15): the shop's per-item ad campaigns, with an Iklan
// on/off switch (pauses/resumes the campaign on Shopee) and an Auto ROAS on/off
// switch (whether the weekly rule may change its ROAS target), the rule's
// settings, and the log of every decision. Backend: routes/ads.js, roasAuto.js.

function formatRupiah(value) {
  if (value == null) return '—';
  return `Rp${Math.round(Number(value)).toLocaleString('id-ID')}`;
}

function formatDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}-${m}-${y}`;
}

// The day before a YYYY-MM-DD date (week ranges end on the next Monday, exclusive).
function dayBefore(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatTime(unix) {
  return new Date(unix * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = { ongoing: 'Berjalan', paused: 'Dijeda', scheduled: 'Terjadwal', ended: 'Selesai', deleted: 'Dihapus', closed: 'Ditutup' };
const STATUS_ORDER = ['ongoing', 'paused', 'scheduled', 'ended', 'closed', 'deleted']; // the filter buttons, in this order

const MODES = [
  { value: 'off', label: 'Mati', hint: 'Tidak ada perhitungan mingguan.' },
  { value: 'preview', label: 'Preview', hint: 'Dihitung setiap Senin dan dicatat, tapi target di Shopee TIDAK diubah.' },
  { value: 'live', label: 'Aktif', hint: 'Dihitung setiap Senin dan target ROAS di Shopee benar-benar diubah.' },
];

function decisionText(d) {
  if (!d) return '—';
  if (d.error) return `Gagal: ${d.error}`;
  if (d.action === 'lower') return `Turun ${d.oldTarget} → ${d.newTarget}`;
  if (d.action === 'raise') return `Naik ${d.oldTarget} → ${d.newTarget}`;
  if (d.action === 'error') return 'Gagal membaca Shopee';
  return d.reason || 'Tidak berubah';
}

function decisionColor(d) {
  if (!d) return colors.textFaint;
  if (d.error || d.action === 'error') return colors.red;
  if (d.action === 'lower') return colors.green;
  if (d.action === 'raise') return colors.orange;
  return colors.textDim;
}

function Switch({ on, disabled, busy, onChange, title }) {
  return (
    <button
      onClick={() => !disabled && !busy && onChange(!on)}
      disabled={disabled || busy}
      title={title}
      style={{
        width: 42,
        height: 22,
        borderRadius: 11,
        border: 'none',
        padding: 2,
        background: on ? colors.green : colors.border,
        opacity: disabled ? 0.35 : busy ? 0.6 : 1,
        cursor: disabled || busy ? 'default' : 'pointer',
        display: 'flex',
        justifyContent: on ? 'flex-end' : 'flex-start',
        transition: 'background 0.15s',
      }}
    >
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', display: 'block' }} />
    </button>
  );
}

const inputStyle = {
  width: 80,
  padding: '7px 9px',
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
  fontSize: 13,
};

function buttonStyle(disabled, primary = false) {
  return {
    padding: '8px 14px',
    borderRadius: 6,
    border: primary ? 'none' : `1px solid ${colors.border}`,
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? 'default' : 'pointer',
    background: primary ? colors.text : colors.cardAlt,
    color: primary ? colors.bg : colors.text,
    opacity: disabled ? 0.5 : 1,
  };
}

function SettingsCard({ settings, weeks, onSaved }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  useEffect(() => setDraft(settings), [settings]);

  const changed = ['mode', 'bandPct', 'step', 'floor', 'ceiling'].some((k) => String(draft[k]) !== String(settings[k]));

  async function save() {
    if (draft.mode === 'live' && settings.mode !== 'live'
      && !window.confirm('Mode Aktif: setiap Senin target ROAS di Shopee akan benar-benar diubah. Lanjutkan?')) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch(`${API_BASE}/ads/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) setMessage({ error: true, text: data.message || 'Gagal menyimpan.' });
      else {
        setMessage({ error: false, text: 'Tersimpan.' });
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  }

  const field = (key, label, step) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.textDim }}>
      {label}
      <input type="number" step={step} min="0" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} style={inputStyle} />
    </label>
  );

  return (
    <div style={{ ...card(), marginBottom: 16 }}>
      <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>ROAS Otomatis (mingguan)</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setDraft({ ...draft, mode: m.value })}
            style={{
              ...buttonStyle(false),
              background: draft.mode === m.value ? (m.value === 'live' ? colors.green : colors.text) : colors.cardAlt,
              color: draft.mode === m.value ? colors.bg : colors.textDim,
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 14 }}>{MODES.find((m) => m.value === draft.mode)?.hint}</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {field('bandPct', 'Batas perubahan (%)', '1')}
        {field('step', 'Langkah ROAS', '0.1')}
        {field('floor', 'ROAS minimum', '0.1')}
        {field('ceiling', 'ROAS maksimum', '0.1')}
        <button onClick={save} disabled={!changed || saving} style={buttonStyle(!changed || saving, true)}>
          {saving ? 'Menyimpan...' : 'Simpan'}
        </button>
        {message && <span style={{ fontSize: 12, color: message.error ? colors.red : colors.green }}>{message.text}</span>}
      </div>
      <p style={{ fontSize: 11.5, color: colors.textFaint, marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
        Setiap Senin 00:05 WIB: (Laba − biaya iklan) per produk minggu lalu ({formatDate(weeks.thisWeek.start)} s/d {formatDate(dayBefore(weeks.thisWeek.end))})
        dibandingkan minggu sebelumnya. Naik lebih dari {settings.bandPct}% → target ROAS turun {settings.step} (iklan lebih agresif);
        turun lebih dari {settings.bandPct}% → target naik {settings.step}; selain itu tidak berubah. Target selalu di antara {settings.floor} dan {settings.ceiling}.
        Produk dilewati jika iklannya sempat mati, Auto ROAS mati, atau tidak ada data minggu sebelumnya.
      </p>
    </div>
  );
}

const GRID = 'minmax(220px,2.2fr) 90px 70px 90px 70px minmax(150px,1.2fr) minmax(150px,1.2fr) minmax(150px,1.2fr)';

function CampaignRow({ c, busy, onIklan, onAuto }) {
  const p = c.preview;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, fontSize: 12.5 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
        {c.imageUrl
          ? <img src={c.imageUrl} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
          : <div style={{ width: 36, height: 36, borderRadius: 6, background: colors.cardAlt, flexShrink: 0 }} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.itemName || c.adName}>
            {c.itemName || c.adName || `Campaign ${c.campaignId}`}
          </div>
          <div style={{ fontSize: 11, color: colors.textFaint }}>
            {c.skus.length > 0 ? c.skus.join(', ') : c.itemCount > 1 ? `${c.itemCount} produk` : '—'} · #{c.campaignId}
          </div>
        </div>
      </div>
      <div style={{ color: c.status === 'ongoing' ? colors.green : colors.textDim }}>{STATUS_LABEL[c.status] || c.status || '—'}</div>
      <div>
        <Switch
          on={c.status === 'ongoing'}
          disabled={!c.canToggleIklan}
          busy={busy === `iklan-${c.campaignId}`}
          onChange={(v) => onIklan(c, v)}
          title={c.canToggleIklan ? 'Nyalakan / jeda iklan ini di Shopee' : 'Tidak bisa diatur dari sini'}
        />
      </div>
      <div style={{ fontFamily: 'var(--num)', fontWeight: 600 }}>{c.roasTarget > 0 ? c.roasTarget : '—'}</div>
      <div>
        <Switch
          on={c.autoRoas}
          disabled={!c.itemId || !!c.notManaged}
          busy={busy === `auto-${c.itemId}`}
          onChange={(v) => onAuto(c, v)}
          title={c.notManaged || 'Boleh diubah otomatis setiap Senin'}
        />
      </div>
      <div style={{ fontFamily: 'var(--num)', lineHeight: 1.5 }}>
        {p.thisWeek != null ? (
          <>
            <div>{formatRupiah(p.thisWeek)}</div>
            <div style={{ fontSize: 11, color: colors.textFaint }}>
              sebelumnya {formatRupiah(p.lastWeek)}
              {p.changePct != null && (
                <span style={{ marginLeft: 6, color: p.changePct >= 0 ? colors.green : colors.red }}>{p.changePct > 0 ? '+' : ''}{p.changePct}%</span>
              )}
            </div>
          </>
        ) : <span style={{ color: colors.textFaint }}>—</span>}
      </div>
      <div style={{ color: decisionColor(p) }}>{decisionText(p)}</div>
      <div style={{ color: decisionColor(c.lastDecision), lineHeight: 1.5 }}>
        {decisionText(c.lastDecision)}
        {c.lastDecision && (
          <div style={{ fontSize: 11, color: colors.textFaint }}>
            {formatTime(c.lastDecision.at)}{c.lastDecision.mode === 'preview' ? ' · preview' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

const LOG_ACTION = { lower: 'Target turun', raise: 'Target naik', skip: 'Dilewati', error: 'Gagal', pause: 'Iklan dijeda', resume: 'Iklan dinyalakan', on: 'Auto ROAS on', off: 'Auto ROAS off' };

function LogList({ log }) {
  if (log.length === 0) return <div style={{ fontSize: 12.5, color: colors.textFaint }}>Belum ada catatan.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {log.map((l) => (
        <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '110px 70px minmax(160px,1.5fr) 120px minmax(200px,2fr)', gap: 10, padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 12 }}>
          <span style={{ color: colors.textFaint }}>{formatTime(l.created_at)}</span>
          <span style={{ color: colors.textFaint }}>{l.kind === 'weekly' ? (l.mode === 'preview' ? 'Preview' : 'Senin') : l.username || 'admin'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.item_name || (l.campaign_id ? `#${l.campaign_id}` : '—')}</span>
          <span style={{ color: decisionColor({ action: l.action, error: l.error }) }}>
            {l.error && l.action === 'pause' ? 'Gagal menjeda' : l.error && l.action === 'resume' ? 'Gagal menyalakan' : LOG_ACTION[l.action] || l.action}
          </span>
          <span style={{ color: colors.textDim }}>
            {l.error
              ? `Gagal: ${l.error}`
              : ['lower', 'raise'].includes(l.action)
                ? `${l.old_target} → ${l.new_target}${l.change_pct != null ? ` (${l.change_pct > 0 ? '+' : ''}${l.change_pct}%)` : ''}`
                : l.reason || ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function IklanRoas() {
  const [data, setData] = useState(null);
  const [log, setLog] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const [res, logRes] = await Promise.all([
        apiFetch(`${API_BASE}/ads/campaigns?shop_id=${SHOP_ID}`),
        apiFetch(`${API_BASE}/ads/log?shop_id=${SHOP_ID}&limit=100`),
      ]);
      if (!res.ok) throw new Error((await res.json()).message || 'Gagal memuat.');
      setData(await res.json());
      if (logRes.ok) setLog((await logRes.json()).log);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(path, body, busyKey) {
    setBusy(busyKey);
    setNotice(null);
    try {
      const res = await apiFetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_id: SHOP_ID, ...body }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) setNotice({ error: true, text: result.message || 'Gagal.' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  function onIklan(c, running) {
    const name = c.itemName || c.adName;
    if (!window.confirm(running ? `Nyalakan iklan "${name}" di Shopee?` : `Jeda iklan "${name}" di Shopee?`)) return;
    post(`/ads/campaigns/${c.campaignId}/running`, { running }, `iklan-${c.campaignId}`);
  }

  function onAuto(c, enabled) {
    post(`/ads/items/${c.itemId}/auto-roas`, { enabled }, `auto-${c.itemId}`);
  }

  if (loadError && !data) return <div style={{ color: colors.red, fontSize: 13 }}>{loadError}</div>;
  if (!data) return <div style={{ color: colors.textDim, fontSize: 13 }}>Memuat...</div>;
  const shown = statusFilter === 'all' ? data.campaigns : data.campaigns.filter((c) => c.status === statusFilter);

  return (
    <div style={{ color: colors.text }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)' }}>Iklan</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {notice && <span style={{ fontSize: 12, color: notice.error ? colors.red : colors.green }}>{notice.text}</span>}
          <button onClick={() => post('/ads/sync', {}, 'sync')} disabled={busy === 'sync'} style={buttonStyle(busy === 'sync')}>
            {busy === 'sync' ? 'Membaca Shopee...' : 'Sinkron dari Shopee'}
          </button>
        </div>
      </div>

      <SettingsCard settings={data.settings} weeks={data.weeks} onSaved={load} />

      {data.campaigns.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {[['all', 'Semua'], ...STATUS_ORDER.filter((st) => data.campaigns.some((c) => c.status === st)).map((st) => [st, STATUS_LABEL[st] || st])].map(([value, label]) => {
            const count = value === 'all' ? data.campaigns.length : data.campaigns.filter((c) => c.status === value).length;
            const active = statusFilter === value;
            return (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                style={{ ...buttonStyle(false), padding: '6px 12px', fontSize: 12.5, background: active ? colors.text : colors.cardAlt, color: active ? colors.bg : colors.textDim }}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div style={{ ...card({ padding: 0 }), marginBottom: 16, overflowX: 'auto' }}>
        <div style={{ minWidth: 1050 }}>
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 12px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${colors.border}` }}>
            <span>Produk</span>
            <span>Status</span>
            <span>Iklan</span>
            <span>Target ROAS</span>
            <span>Auto ROAS</span>
            <span>Laba − iklan (minggu lalu)</span>
            <span>Jika dihitung sekarang</span>
            <span>Keputusan terakhir</span>
          </div>
          {data.campaigns.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12.5, color: colors.textFaint }}>
              Belum ada campaign iklan produk. Tekan "Sinkron dari Shopee", atau tunggu hingga 30 menit.
            </div>
          ) : (
            shown.length === 0
              ? <div style={{ padding: 16, fontSize: 12.5, color: colors.textFaint }}>Tidak ada campaign dengan status ini.</div>
              : shown.map((c) => <CampaignRow key={c.campaignId} c={c} busy={busy} onIklan={onIklan} onAuto={onAuto} />)
          )}
        </div>
      </div>

      <div style={card()}>
        <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 10 }}>Catatan</div>
        <LogList log={log} />
      </div>
    </div>
  );
}

export default IklanRoas;
