import { useEffect, useRef, useState } from 'react';
import { colors, card } from './theme';
import { renderCode39Svg } from './Barcode';
import { COMMANDS } from './PackingStation';
import { IconBolt, IconMoon, IconAlertTriangle, IconRotateCcw } from './Icons';
import { SHOP_ID } from './shopConfig';
import { API_BASE, apiFetch } from './apiBase';
// Only ever hits our own backend (active-stations, order-lists), never
// Shopee directly, so there's no rate-limit or cost concern with polling
// this often — matches PackingStation.jsx's own idle-retry cadence.
const REFRESH_MS = 3000;

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())} ${pad(d.getMonth() + 1)} ${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Order tags (client-requested 2026-09-25): Instant Shipping, Order from
// Yesterday, Stuck in Ready to Check — computed server-side (see
// routes/packing.js's computeTags) since "from yesterday"/"stuck" both need
// facts (a session's start day, how long a row's been in a specific bucket)
// the backend already has and the frontend would otherwise have to
// re-derive. An order can carry any combination of these at once.
const TAG_META = {
  instant: { Icon: IconBolt, color: colors.blue, title: 'Pengiriman Instant' },
  from_yesterday: { Icon: IconMoon, color: colors.orange, title: 'Order dari kemarin' },
  stuck: { Icon: IconAlertTriangle, color: colors.red, title: 'Belum dicek — sudah lama di Ready to Check' },
  retry_ship: { Icon: IconRotateCcw, color: colors.red, title: 'Kurir gagal ambil paket — perlu diatur ulang di Shopee' },
};

function OrderTags({ tags }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
      {tags.map((tag) => {
        const meta = TAG_META[tag];
        if (!meta) return null;
        const { Icon, color, title } = meta;
        return (
          <span key={tag} title={title} style={{ display: 'inline-flex', color }}>
            <Icon size={13} />
          </span>
        );
      })}
    </div>
  );
}

// Order Detail popup (client-requested 2026-09-25) — opened by clicking any
// order row in any Order Lists bucket. The Cancel/Force buttons only render
// once the order is at least Ready to Check (detail.canManage, computed
// server-side by resolveOrderBucket) — nothing to manage on an order that
// hasn't even started its flow yet.
function OrderDetailModal({ orderSn, detail, loading, error, actionBusy, onForceReady, onForcePickup, onCancelOrder, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ ...card(), width: 560, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: colors.text, marginBottom: 10 }}>ORDER ID - {orderSn}</div>

        {loading ? (
          <p style={{ color: colors.textDim, fontSize: 13 }}>Memuat...</p>
        ) : error ? (
          <p style={{ color: colors.red, fontSize: 13 }}>{error}</p>
        ) : detail ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: colors.orange, marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div>DITERIMA - {formatDateTime(detail.created_at)}</div>
                <div>PENGIRIMAN - {detail.shipping_carrier || '—'}</div>
              </div>
              <div>STATUS SAAT INI - {detail.bucket}{detail.forced ? ' (DIPAKSA)' : ''}</div>
            </div>

            {detail.exceptionReason && (
              <div style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${colors.red}`, color: colors.red, fontSize: 12.5, marginBottom: 14 }}>
                {detail.exceptionReason}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {detail.items.length === 0 ? (
                <p style={{ color: colors.textDim, fontSize: 13 }}>Belum ada data item.</p>
              ) : (
                detail.items.map((it) => (
                  <div key={it.sku} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12.5 }}>
                    <div>
                      <div style={{ color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{it.sku}</div>
                      <div style={{ color: colors.textDim, fontSize: 11 }}>{it.product_name}</div>
                    </div>
                    <div style={{ color: colors.text, fontFamily: 'var(--num)', fontWeight: 600 }}>{it.scanned_qty}/{it.qty}</div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {detail.canManage && (
                  <>
                    <button onClick={onForceReady} disabled={actionBusy} style={{ ...modalButtonStyle, borderColor: colors.green, color: colors.green, opacity: actionBusy ? 0.6 : 1 }}>
                      Pindahkan ke Siap Diambil
                    </button>
                    {detail.bucket === 'Ready to Pickup' && (
                      <button onClick={onForcePickup} disabled={actionBusy} style={{ ...modalButtonStyle, borderColor: colors.blue, color: colors.blue, opacity: actionBusy ? 0.6 : 1 }}>
                        Paksa Pickup
                      </button>
                    )}
                    <button onClick={onCancelOrder} disabled={actionBusy} style={{ ...modalButtonStyle, borderColor: colors.red, color: colors.red, opacity: actionBusy ? 0.6 : 1 }}>
                      Batalkan Order
                    </button>
                  </>
                )}
              </div>
              <button onClick={onClose} disabled={actionBusy} style={modalButtonStyle}>Tutup</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

const modalButtonStyle = {
  padding: '8px 14px',
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.cardAlt,
  color: colors.text,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

function ActiveStation() {
  const [stations, setStations] = useState([]);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    const res = await apiFetch(`${API_BASE}/operators/active-stations`);
    if (res.ok) setStations(await res.json());
  }

  if (stations.length === 0) {
    return (
      <div style={{ ...card(), height: '100%', boxSizing: 'border-box' }}>
        <p style={{ color: colors.textDim, margin: 0 }}>Belum ada station yang check-in.</p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {stations.map((s) => (
        <div
          key={s.station_id}
          style={{
            ...card(),
            borderLeft: `3px solid ${s.current_order_sn ? colors.green : colors.blue}`,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: colors.text }}>{s.station_id} - {s.operator_name}</div>
            <div style={{ color: colors.textDim, fontSize: 13, marginTop: 2 }}>
              {s.current_order_sn ? `Sedang mengerjakan Order Id ${s.current_order_sn}` : 'Menunggu order packing masuk'}
            </div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 13, color: colors.textDim }}>
            <div>Mulai Check In: {formatTime(s.checked_in_at)}</div>
            <div>Total Order Hari Ini: {s.total_orders_today}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// The pools from the packing flow diagram: orders past their buyer-
// cancellation delay but, during work hour, not yet booked with Shopee
// ("Processing" — always empty outside work hour, since nothing's being
// booked until the window reopens); orders actually claimable by a station
// right now ("Ready to Check" — during work hour that means already
// labeled, outside work hour label status doesn't matter, see the
// backend's /next-order and finalizeCompletedOrder); orders a Packing
// Station has claimed and is actively scanning right now ("On Progress
// Check"); orders packed today with a real label waiting for Shipping Mode
// to confirm the courier took them ("Ready to Pickup"); and orders already
// scanned but still waiting on a real label ("Ready to Process Tomorrow").
// Order Detail popup state/actions (client-requested 2026-09-25, extracted
// as a shared hook 2026-09-27 once a second page — Cancel & Masalah — needed
// the exact same modal). `onChanged` is that caller's own refresh function,
// called after any action succeeds so it re-fetches whatever list it shows.
function useOrderDetailModal(onChanged) {
  const [selectedOrderSn, setSelectedOrderSn] = useState(null);
  const [orderDetail, setOrderDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);

  async function openOrderDetail(orderSn) {
    setSelectedOrderSn(orderSn);
    setOrderDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/packing/order-detail?order_sn=${encodeURIComponent(orderSn)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setOrderDetail(data);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeOrderDetail() {
    setSelectedOrderSn(null);
    setOrderDetail(null);
    setDetailError(null);
  }

  async function runAction(path, confirmMessage) {
    if (!window.confirm(confirmMessage)) return;
    setActionBusy(true);
    setDetailError(null);
    try {
      const res = await apiFetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_sn: selectedOrderSn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      closeOrderDetail();
      onChanged?.();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  const handleForceReady = () =>
    runAction('/packing/force-ready-for-pickup', `Apakah Anda yakin? Ini akan memaksa order ${selectedOrderSn} langsung ke Siap Diambil, melewati proses scan/label normal.`);
  // Same effect as Shipping Mode's real barcode scan (/confirm-pickup) —
  // this just lets an admin trigger it here for an order already sitting in
  // Ready to Pickup, without needing the physical label in hand.
  const handleForcePickup = () =>
    runAction('/packing/confirm-pickup', `Apakah Anda yakin? Ini akan menandai order ${selectedOrderSn} sebagai sudah diambil, sama seperti scan labelnya di Mode Pengiriman.`);
  const handleCancelOrder = () =>
    runAction('/packing/cancel-order', `Apakah Anda yakin? Ini akan membatalkan order ${selectedOrderSn} di Shopee secara nyata, dan tidak bisa dikembalikan.`);

  return {
    selectedOrderSn, orderDetail, detailLoading, detailError, actionBusy,
    openOrderDetail, closeOrderDetail, handleForceReady, handleForcePickup, handleCancelOrder,
  };
}

function OrderLists() {
  const [lists, setLists] = useState({ waitingList: [], processing: [], readyToCheck: [], onProgressCheck: [], readyForPickup: [], latePickup: [], readyTomorrow: [] });
  const [loading, setLoading] = useState(true);
  // null = still checking on first load, not "paused" — the toggle button
  // stays disabled until we actually know, so a click can't race a stale
  // guess of the state.
  const [syncEnabled, setSyncEnabled] = useState(null);
  const [toggling, setToggling] = useState(false);

  const [bulkBusy, setBulkBusy] = useState(null); // null | 'moveAll' | 'forceAll'
  // Order Detail popup (client-requested 2026-09-25) — opened by clicking any
  // row in any bucket. `load` is hoisted (function declaration further down
  // this same component), so referencing it here before its textual
  // definition is fine.
  const {
    selectedOrderSn, orderDetail, detailLoading, detailError, actionBusy,
    openOrderDetail, closeOrderDetail, handleForceReady, handleForcePickup, handleCancelOrder,
  } = useOrderDetailModal(load);

  // Packing Station configuration (client-requested 2026-09-22): Delay
  // (minutes an order sits in Waiting List before it's eligible for
  // booking/shipping), Max Process Order (concurrent Shopee bookings), Max
  // Ready to Check (cap on the booked-but-unclaimed pool). Loaded once, then
  // only re-fetched after a successful save — no need to poll settings on
  // the same 3s cadence as the order lists themselves.
  const [settings, setSettings] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // Separate from settings/settingsDraft on purpose: this is a live clock
  // readout ("is it work hour right now"), not part of the editable form —
  // it needs to keep refreshing on the same cadence as the order lists
  // without ever overwriting settingsDraft mid-edit.
  const [currentlyWithinWorkHour, setCurrentlyWithinWorkHour] = useState(null);

  useEffect(() => {
    load();
    loadSyncStatus();
    loadSettings();
    loadWorkHourStatus();
    const interval = setInterval(() => {
      load();
      loadSyncStatus();
      loadWorkHourStatus();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/packing/order-lists?shop_id=${SHOP_ID}`);
      if (res.ok) setLists(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function loadSyncStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/orders/sync-status`);
      if (res.ok) setSyncEnabled((await res.json()).enabled);
    } catch {
      // best-effort — keeps whatever was last known rather than flashing "checking"
    }
  }

  async function loadSettings() {
    try {
      const res = await apiFetch(`${API_BASE}/packing/settings`);
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setSettingsDraft(data);
      }
    } catch {
      // best-effort — form just stays disabled/empty until this succeeds
    }
  }

  async function loadWorkHourStatus() {
    try {
      const res = await apiFetch(`${API_BASE}/packing/settings`);
      if (res.ok) setCurrentlyWithinWorkHour((await res.json()).currentlyWithinWorkHour);
    } catch {
      // best-effort — badge just keeps showing whatever was last known
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
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
        setCurrentlyWithinWorkHour(data.currentlyWithinWorkHour);
      }
    } finally {
      setSavingSettings(false);
    }
  }

  // A number input controlled by `value={draft ?? ''}` with a plain
  // Number(e.target.value) onChange can never actually go empty: clearing
  // the field fires onChange with '', Number('') is 0, and the next render
  // forces the DOM back to "0" — so a user trying to retype 60 as 22 ends
  // up with the old digit still there ("022"), since the field can never
  // pass through a genuinely empty state. Keeping '' as its own draft value
  // (instead of coercing it to 0 immediately) lets the field actually clear;
  // Number(e.target.value) still runs for any real digit input.
  function handleSettingsNumberChange(key) {
    return (e) => {
      const v = e.target.value;
      setSettingsDraft((s) => ({ ...s, [key]: v === '' ? '' : Number(v) }));
    };
  }

  async function toggleSync() {
    setToggling(true);
    try {
      const res = await apiFetch(`${API_BASE}/orders/sync-toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !syncEnabled }),
      });
      if (res.ok) setSyncEnabled((await res.json()).enabled);
    } finally {
      setToggling(false);
    }
  }

  // Bulk forms of the Order Detail popup's per-order actions (client-
  // requested 2026-09-25) — one click across every eligible order instead of
  // opening each one individually. Same backend rules apply per order (see
  // /force-ready-for-pickup-all and /force-pickup-all), this button is just
  // the trigger.
  async function handleMoveAllToReadyForPickup() {
    if (!window.confirm('Apakah Anda yakin? Ini akan memaksa setiap order yang sedang di Siap Dicek atau Sedang Discan langsung ke Siap Diambil, melewati proses scan/label normal.')) return;
    setBulkBusy('moveAll');
    try {
      const res = await apiFetch(`${API_BASE}/packing/force-ready-for-pickup-all?shop_id=${SHOP_ID}`, { method: 'POST' });
      if (res.ok) load();
    } finally {
      setBulkBusy(null);
    }
  }

  async function handleForceAllPickup() {
    if (!window.confirm('Apakah Anda yakin? Ini akan menandai setiap order yang ada di Siap Diambil sebagai sudah diambil, sama seperti scan setiap labelnya di Mode Pengiriman.')) return;
    setBulkBusy('forceAll');
    try {
      const res = await apiFetch(`${API_BASE}/packing/force-pickup-all?shop_id=${SHOP_ID}`, { method: 'POST' });
      if (res.ok) load();
    } finally {
      setBulkBusy(null);
    }
  }

  const columns = [
    { key: 'waitingList', title: 'Daftar Tunggu' },
    { key: 'processing', title: 'Diproses' },
    { key: 'readyToCheck', title: 'Siap Dicek' },
    { key: 'onProgressCheck', title: 'Sedang Discan' },
    { key: 'readyForPickup', title: 'Siap Diambil' },
    { key: 'latePickup', title: 'Pickup Terlambat' },
    { key: 'readyTomorrow', title: 'Diproses Besok' },
  ];

  const settingsChanged = settings && settingsDraft && (
    settings.orderDelayMinutes !== settingsDraft.orderDelayMinutes ||
    settings.maxConcurrentBookings !== settingsDraft.maxConcurrentBookings ||
    settings.maxReadyToCheck !== settingsDraft.maxReadyToCheck ||
    settings.workHourStartHour !== settingsDraft.workHourStartHour ||
    settings.workHourEndHour !== settingsDraft.workHourEndHour ||
    settings.workHourEnabled !== settingsDraft.workHourEnabled ||
    settings.readyToCheckStuckSeconds !== settingsDraft.readyToCheckStuckSeconds
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ ...card(), display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: syncEnabled ? colors.green : colors.textFaint,
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: colors.text, fontSize: 13.5 }}>
              {syncEnabled === null ? 'Memeriksa status fetching...' : syncEnabled ? 'Fetching Order: Aktif' : 'Fetching Order: Dijeda'}
            </div>
            <div style={{ fontSize: 11.5, color: colors.textDim, marginTop: 1 }}>
              {syncEnabled
                ? 'Server sedang mengambil pesanan baru dari Shopee secara otomatis.'
                : 'Server tidak akan mengambil pesanan baru sampai fetching dimulai di sini.'}
            </div>
          </div>
        </div>
        <button
          onClick={toggleSync}
          disabled={syncEnabled === null || toggling}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            fontWeight: 600,
            fontSize: 13,
            flexShrink: 0,
            cursor: syncEnabled === null || toggling ? 'default' : 'pointer',
            background: syncEnabled ? colors.redDim : colors.greenDim,
            color: syncEnabled ? colors.red : colors.green,
            opacity: toggling ? 0.6 : 1,
          }}
        >
          {syncEnabled ? 'Jeda Fetching' : 'Mulai Fetching'}
        </button>
      </div>

      <div style={{ ...card(), display: 'flex', alignItems: 'flex-end', gap: 20, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, color: colors.text, fontSize: 13.5, alignSelf: 'center', marginRight: 4 }}>
          Konfigurasi Packing Station
        </div>
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
          <label style={settingsLabelStyle}>Jam Kerja Mulai</label>
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
          <label style={settingsLabelStyle}>Jam Kerja Selesai</label>
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
          <label style={settingsLabelStyle}>Status Sekarang</label>
          <div
            style={{
              padding: '9px 14px',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              background: currentlyWithinWorkHour ? colors.greenDim : colors.orangeDim,
              color: currentlyWithinWorkHour ? colors.green : colors.orange,
            }}
          >
            {currentlyWithinWorkHour === null ? 'Memeriksa...' : currentlyWithinWorkHour ? 'Sedang Jam Kerja' : 'Di Luar Jam Kerja'}
          </div>
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
        <button
          onClick={handleMoveAllToReadyForPickup}
          disabled={bulkBusy !== null}
          style={{ ...modalButtonStyle, borderColor: colors.green, color: colors.green, opacity: bulkBusy !== null ? 0.6 : 1 }}
        >
          {bulkBusy === 'moveAll' ? 'Memproses...' : 'PINDAHKAN SEMUA KE SIAP DIAMBIL'}
        </button>
        <button
          onClick={handleForceAllPickup}
          disabled={bulkBusy !== null}
          style={{ ...modalButtonStyle, borderColor: colors.blue, color: colors.blue, opacity: bulkBusy !== null ? 0.6 : 1 }}
        >
          {bulkBusy === 'forceAll' ? 'Memproses...' : 'PAKSA SEMUA PICKUP'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {columns.map(({ key, title }) => {
        const rows = lists[key];
        return (
          <div key={key} style={{ flex: 1, ...card(), display: 'flex', flexDirection: 'column', minWidth: 0, boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 700, color: colors.text, marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 12 }}>
              {rows.length} order
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {loading ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Memuat...</p>
              ) : rows.length === 0 ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Kosong.</p>
              ) : (
                rows.map((row) => (
                  <div
                    key={row.order_sn}
                    onClick={() => openOrderDetail(row.order_sn)}
                    style={{ padding: 8, borderRadius: 6, background: colors.cardAlt, fontSize: 12.5, cursor: 'pointer' }}
                  >
                    <div style={{ fontWeight: 600, color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{row.order_sn}</div>
                    {(row.station_id || row.operator_name) && (
                      <div style={{ color: colors.textDim, marginTop: 2 }}>
                        {row.station_id}
                        {row.operator_name && ` (${row.operator_name})`}
                      </div>
                    )}
                    {row.status === 'AWAITING_LABEL_SCAN' && (
                      <div style={{ color: colors.red, marginTop: 2, fontWeight: 600 }}>
                        Menunggu scan konfirmasi — cek printer
                      </div>
                    )}
                    {key === 'readyToCheck' && (
                      <div style={{ color: row.label_ready ? colors.green : colors.textFaint, marginTop: 2 }}>
                        {row.label_ready ? 'Label siap' : 'Menunggu label'}
                      </div>
                    )}
                    {key === 'readyToCheck' && row.internal_barcode && (
                      <div style={{ color: colors.orange, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                        Scan: {row.internal_barcode}
                      </div>
                    )}
                    {key === 'readyForPickup' && row.pickup_time_label && (
                      <div style={{ color: colors.textDim, marginTop: 2 }}>
                        Pickup: {row.pickup_time_label}
                      </div>
                    )}
                    {key === 'latePickup' && (
                      <div style={{ color: colors.red, marginTop: 2, fontWeight: 600 }}>
                        Jadwal pickup terlewat{row.pickup_time_label ? ` (${row.pickup_time_label})` : ''} — atur ulang di Shopee
                      </div>
                    )}
                    <OrderTags tags={row.tags} />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
      </div>

      {selectedOrderSn && (
        <OrderDetailModal
          orderSn={selectedOrderSn}
          detail={orderDetail}
          loading={detailLoading}
          error={detailError}
          actionBusy={actionBusy}
          onForceReady={handleForceReady}
          onForcePickup={handleForcePickup}
          onCancelOrder={handleCancelOrder}
          onClose={closeOrderDetail}
        />
      )}
    </div>
  );
}

// Order Lists — view-only (client-requested 2026-09-30) — a passive, no-
// login-actions-needed display of just the 7 buckets for a TV/monitor
// screen in the packing area: no fetching toggle, no Konfigurasi Packing
// Station settings, no bulk-action buttons, and no click-to-open Order
// Detail (rows are plain, non-interactive — "just an image" of the current
// state). Deliberately its own component rather than a stripped-down prop
// on OrderLists — that component's state (settings, sync toggle, bulk
// actions, the detail modal) simply doesn't exist here at all.
function OrderListsViewOnly() {
  const [lists, setLists] = useState({ waitingList: [], processing: [], readyToCheck: [], onProgressCheck: [], readyForPickup: [], latePickup: [], readyTomorrow: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/packing/order-lists?shop_id=${SHOP_ID}`);
      if (res.ok) setLists(await res.json());
    } finally {
      setLoading(false);
    }
  }

  const columns = [
    { key: 'waitingList', title: 'Daftar Tunggu' },
    { key: 'processing', title: 'Diproses' },
    { key: 'readyToCheck', title: 'Siap Dicek' },
    { key: 'onProgressCheck', title: 'Sedang Discan' },
    { key: 'readyForPickup', title: 'Siap Diambil' },
    { key: 'latePickup', title: 'Pickup Terlambat' },
    { key: 'readyTomorrow', title: 'Diproses Besok' },
  ];

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%' }}>
      {columns.map(({ key, title }) => {
        const rows = lists[key];
        return (
          <div key={key} style={{ flex: 1, ...card(), display: 'flex', flexDirection: 'column', minWidth: 0, boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 700, color: colors.text, marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 12 }}>
              {rows.length} order
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {loading ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Memuat...</p>
              ) : rows.length === 0 ? (
                <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Kosong.</p>
              ) : (
                rows.map((row) => (
                  <div key={row.order_sn} style={{ padding: 8, borderRadius: 6, background: colors.cardAlt, fontSize: 12.5 }}>
                    <div style={{ fontWeight: 600, color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{row.order_sn}</div>
                    {(row.station_id || row.operator_name) && (
                      <div style={{ color: colors.textDim, marginTop: 2 }}>
                        {row.station_id}
                        {row.operator_name && ` (${row.operator_name})`}
                      </div>
                    )}
                    {row.status === 'AWAITING_LABEL_SCAN' && (
                      <div style={{ color: colors.red, marginTop: 2, fontWeight: 600 }}>
                        Menunggu scan konfirmasi — cek printer
                      </div>
                    )}
                    {key === 'readyToCheck' && (
                      <div style={{ color: row.label_ready ? colors.green : colors.textFaint, marginTop: 2 }}>
                        {row.label_ready ? 'Label siap' : 'Menunggu label'}
                      </div>
                    )}
                    {key === 'readyToCheck' && row.internal_barcode && (
                      <div style={{ color: colors.orange, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                        Scan: {row.internal_barcode}
                      </div>
                    )}
                    {key === 'readyForPickup' && row.pickup_time_label && (
                      <div style={{ color: colors.textDim, marginTop: 2 }}>
                        Pickup: {row.pickup_time_label}
                      </div>
                    )}
                    {key === 'latePickup' && (
                      <div style={{ color: colors.red, marginTop: 2, fontWeight: 600 }}>
                        Jadwal pickup terlewat{row.pickup_time_label ? ` (${row.pickup_time_label})` : ''} — atur ulang di Shopee
                      </div>
                    )}
                    <OrderTags tags={row.tags} />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Cancel & Masalah (client-requested 2026-09-27) — cancelled orders vanish
// from every Order Lists bucket once CANCELLED, with nowhere else to see
// them; Masalah (Problem Order/EXCEPTION) already has a live bucket in Order
// Lists, this is the broader, longer-history view of both together. Reuses
// the same Order Detail popup as Order Lists (resolveOrderBucket on the
// backend already returns the right bucket/canManage for a CANCELLED order —
// no actions, terminal state — or a Problem Order — Cancel/Force available).
function CancelMasalahList() {
  const [data, setData] = useState({ cancelled: [], masalah: [] });
  const [loading, setLoading] = useState(true);
  const {
    selectedOrderSn, orderDetail, detailLoading, detailError, actionBusy,
    openOrderDetail, closeOrderDetail, handleForceReady, handleForcePickup, handleCancelOrder,
  } = useOrderDetailModal(load);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/packing/cancel-masalah-list?shop_id=${SHOP_ID}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  // "Selesaikan" (client-requested 2026-09-29) -- pure acknowledgment, clears
  // the notification badge only. What resolving actually means differs by
  // type (see the backend's resolve-cancelled/resolve-masalah comments), so
  // this deliberately doesn't try to auto-fix anything; it just tells the
  // system a human has looked at this entry.
  async function resolveCancelled(orderSn, e) {
    e.stopPropagation();
    await apiFetch(`${API_BASE}/packing/resolve-cancelled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_sn: orderSn }),
    });
    load();
  }

  async function resolveMasalah(sessionId, e) {
    e.stopPropagation();
    await apiFetch(`${API_BASE}/packing/resolve-masalah`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    load();
  }

  const columns = [
    { key: 'cancelled', title: 'Dibatalkan' },
    { key: 'masalah', title: 'Masalah' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        {columns.map(({ key, title }) => {
          const rows = data[key];
          return (
            <div key={key} style={{ flex: 1, ...card(), display: 'flex', flexDirection: 'column', minWidth: 0, boxSizing: 'border-box' }}>
              <div style={{ fontWeight: 700, color: colors.text, marginBottom: 2 }}>{title}</div>
              <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 12 }}>
                {rows.length} order
              </div>
              <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {loading ? (
                  <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Memuat...</p>
                ) : rows.length === 0 ? (
                  <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Kosong.</p>
                ) : (
                  rows.map((row) => {
                    const needsResolve = key === 'cancelled' ? row.cancel_needs_resolve : row.needs_resolve;
                    return (
                      <div
                        key={key === 'cancelled' ? row.order_sn : row.session_id}
                        onClick={() => openOrderDetail(row.order_sn)}
                        style={{ padding: 8, borderRadius: 6, background: colors.cardAlt, fontSize: 12.5, cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            {!!needsResolve && (
                              <span
                                title="Belum diselesaikan"
                                style={{ width: 7, height: 7, borderRadius: '50%', background: colors.red, flexShrink: 0 }}
                              />
                            )}
                            <span style={{ fontWeight: 600, color: colors.text, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {row.order_sn}
                            </span>
                          </div>
                          {!!needsResolve && (
                            <button
                              onClick={(e) => (key === 'cancelled' ? resolveCancelled(row.order_sn, e) : resolveMasalah(row.session_id, e))}
                              style={{ flexShrink: 0, fontSize: 11, padding: '3px 8px', borderRadius: 4, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textDim, cursor: 'pointer' }}
                            >
                              Selesaikan
                            </button>
                          )}
                        </div>
                        {(row.station_id || row.operator_name) && (
                          <div style={{ color: colors.textDim, marginTop: 2 }}>
                            {row.station_id}
                            {row.operator_name && ` (${row.operator_name})`}
                          </div>
                        )}
                        {row.exception_reason && (
                          <div style={{ color: colors.red, marginTop: 4 }}>{row.exception_reason}</div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selectedOrderSn && (
        <OrderDetailModal
          orderSn={selectedOrderSn}
          detail={orderDetail}
          loading={detailLoading}
          error={detailError}
          actionBusy={actionBusy}
          onForceReady={handleForceReady}
          onForcePickup={handleForcePickup}
          onCancelOrder={handleCancelOrder}
          onClose={closeOrderDetail}
        />
      )}
    </div>
  );
}

function Daftar() {
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const printFrameRef = useRef(null);

  // Prints the operator's login barcode as an actual scannable Code 39
  // barcode (not just the plain text shown on screen) — this is the card
  // the operator scans at the Packing Station to log in, so it needs to be
  // physically scannable, same encoding as the Hardware Test barcode there.
  function printLoginBarcode(data) {
    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }, 300);
    };
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            body { font-family: monospace; text-align: center; padding: 24px; }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <h2>${data.name}</h2>
          ${renderCode39Svg(data.login_barcode)}
          <p style="letter-spacing: 2px;">${data.login_barcode}</p>
          <p style="font-size: 11px;">Scan barcode ini di Packing Station untuk masuk.</p>
        </body>
      </html>
    `;
  }

  // Client-requested (2026-09-29): printable barcode cards for the station
  // commands (NEXT_ORDER, PAUSE, etc. — see PackingStation.jsx's COMMANDS,
  // exported from there so this stays a single source of truth) so an
  // admin can post physical scannable cards at a station instead of the
  // operator needing to type these. Same iframe/print pattern as the login
  // barcode above.
  //
  // cmd.replace('_', '-') before encoding: Code 39 has no underscore in its
  // character set (see Barcode.jsx's CODE39_PATTERNS) — renderCode39Svg just
  // silently drops unsupported characters, so a barcode encoded straight
  // from "SHIPPING_MODE" actually reads back as "SHIPPINGMODE" and never
  // matches PackingStation.jsx's exact command check. Hyphen IS supported,
  // and PackingStation.jsx's COMMAND_BARCODE_ALIASES maps it back to the
  // real underscore command on scan — the printed/displayed text label
  // still shows the real command name either way.
  function printCommandBarcode(cmd) {
    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }, 300);
    };
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            body { font-family: monospace; text-align: center; padding: 24px; }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <h2>${cmd}</h2>
          ${renderCode39Svg(cmd.replace(/_/g, '-'))}
          <p style="letter-spacing: 2px;">${cmd}</p>
        </body>
      </html>
    `;
  }

  // All commands in one print job, one card per command (page-break-inside
  // avoided so a card never splits across pages) — for printing the whole
  // reference sheet at once instead of one command at a time.
  function printAllCommandBarcodes() {
    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }, 300);
    };
    const cards = COMMANDS.map(
      ({ cmd }) => `
        <div class="card">
          <h2>${cmd}</h2>
          ${renderCode39Svg(cmd.replace(/_/g, '-'))}
          <p style="letter-spacing: 2px;">${cmd}</p>
        </div>
      `
    ).join('');
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            body { font-family: monospace; }
            .card { text-align: center; padding: 24px; page-break-inside: avoid; border-bottom: 1px dashed #999; }
            .card:last-child { border-bottom: none; }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>${cards}</body>
      </html>
    `;
  }

  async function handleRegister() {
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch(`${API_BASE}/operators/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setResult(data);
      printLoginBarcode(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReprint() {
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch(`${API_BASE}/operators/by-name?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setResult(data);
      printLoginBarcode(data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', boxSizing: 'border-box' }}>
      <div style={card()}>
        <label style={{ color: colors.textDim, fontSize: 13 }}>Nama</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={handleRegister} style={buttonStyle}>Daftar Baru</button>
          <button onClick={handleReprint} style={buttonStyle}>Print Ulang Barcode Login</button>
        </div>
        {result && (
          <p style={{ marginTop: 16, color: colors.text }}>
            Barcode untuk <strong>{result.name}</strong>:{' '}
            <span style={{ fontFamily: 'monospace', fontSize: 18, color: colors.green }}>{result.login_barcode}</span>
          </p>
        )}
        {error && <p style={{ color: colors.red, marginTop: 16 }}>{error}</p>}
      </div>

      <div style={{ ...card(), flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: colors.text, fontSize: 14 }}>Barcode Command</div>
          <button onClick={printAllCommandBarcodes} style={buttonStyle}>Print Semua Barcode</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {COMMANDS.map(({ cmd, desc }) => (
            <div
              key={cmd}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6 }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600, color: colors.text }}>{cmd}</div>
                <div style={{ fontSize: 11.5, color: colors.textDim, marginTop: 2 }}>{desc}</div>
              </div>
              <button onClick={() => printCommandBarcode(cmd)} style={{ ...buttonStyle, flexShrink: 0 }}>Print</button>
            </div>
          ))}
        </div>
      </div>

      <iframe ref={printFrameRef} title="operator-barcode-print" style={{ display: 'none' }} />
    </div>
  );
}

function PackingStationDashboard({ view = 'active' }) {
  return (
    <div style={{ minHeight: 'calc(100vh - 160px)' }}>
      {view === 'active' ? <ActiveStation /> : view === 'lists' ? <OrderLists /> : view === 'listsViewOnly' ? <OrderListsViewOnly /> : view === 'cancelMasalah' ? <CancelMasalahList /> : <Daftar />}
    </div>
  );
}

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginTop: 4,
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
};

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

const buttonStyle = {
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  padding: '8px 14px',
  borderRadius: 6,
  cursor: 'pointer',
};

export default PackingStationDashboard;
