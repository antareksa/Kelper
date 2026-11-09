import { useState } from 'react';
import { colors } from './theme';

// "Cheat" scan panel (2026-11-10): lets a tester drive the Packing Station
// with the mouse when no barcode scanner is at hand. Every button goes through
// the station's own handleScanSubmit, exactly like a scan, so nothing about the
// flow is skipped or faked server-side.
//
// Staging and local development only. Never shown on the live hostnames, where
// the stations have no mouse.
const host = window.location.hostname;
export const SCAN_CHEAT_ENABLED = host.includes('.staging.') || host === 'localhost' || host === '127.0.0.1';

const RECENT_KEY = 'kelper.scanCheat.recent';
const RECENT_MAX = 6;
// SHUTDOWN_PC is left out on purpose: on a set-up PC it really turns it off.
const COMMANDS = ['NEXT_ORDER', 'PAUSE', 'RESUME', 'UNDO', 'MASALAH', 'RELEASE_ORDER', 'REPRINT', 'SHIPPING_MODE', 'PRINT_RESI_MODE', 'PACKING_MODE', 'LOGOUT'];

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list just won't survive a reload
  }
}

// What the station is waiting for right now, as [label, value] buttons.
function suggestions({ operatorName, mode, state, pickupList, besokList }) {
  if (!operatorName) return [];
  if (mode === 'shipping') return pickupList.map((o) => [`Pickup ${o.order_sn}`, o.order_sn]);
  if (mode === 'printresi') return besokList.map((o) => [`Besok ${o.internal_barcode || o.order_sn}`, o.internal_barcode || o.order_sn]);
  if (!state) return [];

  const { session, order, items } = state;
  const out = [];
  if (session.status === 'IN_PROGRESS') {
    for (const it of items) {
      const done = it.scanned_qty >= it.qty;
      out.push([`${done ? '✓ ' : ''}${it.sku} (${it.scanned_qty}/${it.qty})`, it.barcode || it.sku]);
    }
    out.push(['Item salah (uji)', 'CHEAT-WRONG-ITEM']);
  }
  if (['RESUMING', 'DEFERRED_READY'].includes(session.status) && session.internal_barcode) {
    out.push([`Barcode sementara ${session.internal_barcode}`, session.internal_barcode]);
  }
  if (session.status === 'AWAITING_LABEL_SCAN') {
    if (order.tracking_no) out.push([`Resi ${order.tracking_no}`, order.tracking_no]);
    out.push([`Order ${order.order_sn}`, order.order_sn]);
    out.push(['Label salah (uji)', 'CHEAT-WRONG-LABEL']);
  }
  return out;
}

export default function ScanCheatPanel({ onScan, operatorName, mode, state, pickupList, besokList }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [recent, setRecent] = useState(loadRecent);

  function sendTyped() {
    const value = text.trim();
    if (!value) return;
    const next = [value, ...recent.filter((v) => v !== value)].slice(0, RECENT_MAX);
    setRecent(next);
    saveRecent(next);
    setText('');
    onScan(value);
  }

  // preventDefault on mousedown keeps the focus on the station's hidden scan
  // input, so a real scanner (if one is plugged in) still works alongside.
  const button = (label, value, key) => (
    <button key={key ?? value} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onScan(value)} style={buttonStyle}>
      {label}
    </button>
  );

  if (!open) {
    return (
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(true)} style={{ ...panelBase, ...buttonStyle, padding: '8px 12px', fontWeight: 700 }}>
        CHEAT
      </button>
    );
  }

  const hints = suggestions({ operatorName, mode, state, pickupList, besokList });
  return (
    <div style={{ ...panelBase, width: 280, maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 12, background: colors.card, border: `2px dashed ${colors.yellow}`, borderRadius: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: colors.text }}>Cheat scan (staging)</strong>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(false)} style={{ ...buttonStyle, padding: '2px 8px' }}>Tutup</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          data-mouse-input="true"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendTyped(); }}
          placeholder={operatorName ? 'Ketik kode lalu Enter' : 'Barcode operator (OP-...)'}
          style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.cardAlt, color: colors.text }}
        />
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={sendTyped} style={buttonStyle}>Scan</button>
      </div>
      {!operatorName && (
        <p style={noteStyle}>Barcode operator ada di Dashboard → Daftar (operator), formatnya OP-xxxxxxxx.</p>
      )}

      {recent.length > 0 && (
        <Section title="Terakhir diketik">{recent.map((v) => button(v, v, `recent-${v}`))}</Section>
      )}
      {hints.length > 0 && (
        <Section title="Yang ditunggu sekarang">{hints.map(([label, value], i) => button(label, value, `hint-${i}`))}</Section>
      )}
      {operatorName && (
        <Section title="Perintah">{COMMANDS.map((c) => button(c, c))}</Section>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: colors.textDim, marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{children}</div>
    </div>
  );
}

const panelBase = { position: 'fixed', top: 64, right: 16, zIndex: 50, boxSizing: 'border-box', fontFamily: 'var(--sans)' };
const buttonStyle = {
  fontSize: 11,
  padding: '4px 8px',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  textAlign: 'left',
  wordBreak: 'break-all',
};
const noteStyle = { margin: '0 0 4px', fontSize: 11, color: colors.textDim };
