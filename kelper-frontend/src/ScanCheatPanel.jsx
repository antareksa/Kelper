import { useEffect, useState } from 'react';
import { colors } from './theme';
import { API_BASE } from './apiBase';

// "Cheat" scan panel (2026-11-10): lets a tester drive the Packing Station
// with the mouse when no barcode scanner is at hand. Buttons only, picked for
// whatever the station is waiting for: the right scan, a wrong one, and the
// commands that make sense at that moment. Every button goes through the
// station's own handleScanSubmit, exactly like a scan, so nothing about the
// flow is skipped or faked server-side.
//
// Staging and local development only. Never shown on the live hostnames, where
// the stations have no mouse.
const host = window.location.hostname;
export const SCAN_CHEAT_ENABLED = host.includes('.staging.') || host === 'localhost' || host === '127.0.0.1';

// Codes that can't match anything real, for testing the "wrong scan" paths.
const WRONG = 'CHEAT-SALAH';

// [label, value, kind] buttons for the station's current state.
function buttonsFor({ operatorName, operators, paused, mode, state, pickupList, besokList }) {
  if (!operatorName) {
    return [
      ...operators.map((o) => [`Masuk: ${o.name}`, o.login_barcode, 'good']),
      ['Barcode operator salah', WRONG, 'bad'],
    ];
  }
  if (paused) return [['RESUME', 'RESUME', 'good'], ['LOGOUT', 'LOGOUT']];

  if (mode === 'shipping') {
    const next = pickupList[0];
    return [
      ...(next ? [[`Scan resi pickup (benar): ${next.order_sn}`, next.order_sn, 'good']] : []),
      ['Scan resi salah', WRONG, 'bad'],
      ['PACKING_MODE', 'PACKING_MODE'],
    ];
  }

  if (mode === 'printresi') {
    const next = besokList[0];
    const right = !next ? []
      : next.status === 'AWAITING_LABEL_SCAN'
        ? [[`Scan resi tercetak (benar): ${next.order_sn}`, next.order_sn, 'good']]
        : [[`Scan barcode Pack Besok (benar): ${next.internal_barcode}`, next.internal_barcode, 'good']];
    return [...right, ['Scan barcode salah', WRONG, 'bad'], ['PACKING_MODE', 'PACKING_MODE']];
  }

  const idle = [['NEXT_ORDER', 'NEXT_ORDER', 'good'], ['SHIPPING_MODE', 'SHIPPING_MODE'], ['PRINT_RESI_MODE', 'PRINT_RESI_MODE'], ['PAUSE', 'PAUSE'], ['LOGOUT', 'LOGOUT']];
  if (!state) return idle;

  const { session, order, items } = state;
  if (session.status === 'IN_PROGRESS') {
    const next = items.find((it) => it.scanned_qty < it.qty);
    return [
      ...(next ? [[`Scan item benar: ${next.sku} (${next.scanned_qty + 1}/${next.qty})`, next.barcode || next.sku, 'good']] : []),
      ['Scan item salah', WRONG, 'bad'],
      ['UNDO', 'UNDO'],
      ['MASALAH', 'MASALAH'],
      ['RELEASE_ORDER', 'RELEASE_ORDER'],
      ['PAUSE', 'PAUSE'],
    ];
  }
  if (session.status === 'RESUMING' || (session.status === 'DEFERRED_READY' && !session.besok_confirmed_at)) {
    return [
      [`Scan barcode sementara (benar): ${session.internal_barcode}`, session.internal_barcode, 'good'],
      ['Scan barcode sementara salah', WRONG, 'bad'],
      ...(session.status === 'DEFERRED_READY' ? [['REPRINT', 'REPRINT']] : []),
    ];
  }
  if (session.status === 'AWAITING_LABEL_SCAN') {
    const resi = order.tracking_no || order.order_sn;
    return [
      [`Scan resi (benar): ${resi}`, resi, 'good'],
      ['Scan resi salah', WRONG, 'bad'],
      ['REPRINT', 'REPRINT'],
    ];
  }
  return idle;
}

export default function ScanCheatPanel({ onScan, operatorName, paused, mode, state, pickupList, besokList }) {
  const [open, setOpen] = useState(true);
  const [operators, setOperators] = useState([]);
  const [operatorsError, setOperatorsError] = useState(false);

  // Only needed for the login buttons; the server only serves this list on staging.
  useEffect(() => {
    if (operatorName) return;
    fetch(`${API_BASE}/operators/cheat-list`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => { setOperators(data.operators || []); setOperatorsError(false); })
      .catch(() => setOperatorsError(true));
  }, [operatorName]);

  // preventDefault on mousedown keeps the focus on the station's hidden scan
  // input, so a real scanner (if one is plugged in) still works alongside.
  const keepFocus = (e) => e.preventDefault();

  if (!open) {
    return (
      <button type="button" onMouseDown={keepFocus} onClick={() => setOpen(true)} style={{ ...panelBase, ...buttonStyle(), fontWeight: 700 }}>
        CHEAT
      </button>
    );
  }

  const buttons = buttonsFor({ operatorName, operators, paused, mode, state, pickupList, besokList });
  return (
    <div style={{ ...panelBase, width: 300, maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 12, background: colors.card, border: `2px dashed ${colors.yellow}`, borderRadius: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: colors.text }}>Cheat scan (staging)</strong>
        <button type="button" onMouseDown={keepFocus} onClick={() => setOpen(false)} style={{ ...buttonStyle(), padding: '2px 8px', fontSize: 11 }}>Tutup</button>
      </div>
      {!operatorName && operatorsError && (
        <p style={noteStyle}>Daftar operator tidak bisa dimuat.</p>
      )}
      {!operatorName && !operatorsError && operators.length === 0 && (
        <p style={noteStyle}>Belum ada operator. Buat dulu di Dashboard → Daftar.</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {buttons.map(([label, value, kind], i) => (
          <button key={`${i}-${label}`} type="button" onMouseDown={keepFocus} onClick={() => onScan(value)} style={buttonStyle(kind)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

const panelBase = { position: 'fixed', top: 64, right: 16, zIndex: 50, boxSizing: 'border-box', fontFamily: 'var(--sans)' };

function buttonStyle(kind) {
  const accent = kind === 'good' ? colors.green : kind === 'bad' ? colors.red : colors.border;
  return {
    fontSize: 13,
    fontWeight: kind ? 600 : 400,
    padding: '8px 10px',
    background: colors.cardAlt,
    border: `1px solid ${accent}`,
    borderLeft: `4px solid ${accent}`,
    color: colors.text,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'var(--sans)',
    textAlign: 'left',
    wordBreak: 'break-all',
  };
}

const noteStyle = { margin: '0 0 8px', fontSize: 12, color: colors.textDim };
