import { useEffect, useRef, useState } from 'react';
import { colors } from './theme';
import { IconMonitor } from './Icons';

const API_BASE = 'http://localhost:3001';
const SYNC_INTERVAL_MS = 60000;
const SHOP_ID = 227886187;

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const COMMANDS = [
  { cmd: 'NEXT_ORDER', desc: 'Start processing the next available new order.' },
  { cmd: 'NEXT_ORDER_KEMAREN', desc: "Resume the next order set aside yesterday (Pack Besok), without needing its specific barcode." },
  { cmd: 'PAUSE', desc: 'Pause the station (freezes scanning) while you step away.' },
  { cmd: 'RESUME', desc: 'Resume the station after a pause.' },
  { cmd: 'UNDO', desc: 'Revert your last item scan.' },
  { cmd: 'MASALAH', desc: 'Flag the current order as a problem — needs manual resolution.' },
  { cmd: 'RELEASE_ORDER', desc: "Give up this order and put it back in the pool for any station (e.g. you're not going to finish it)." },
  { cmd: 'KIRIM_HARI_INI', desc: 'Ship this order today — books the real shipment and prints the label.' },
  { cmd: 'PACK_BESOK', desc: 'Set this order aside for tomorrow instead of shipping now.' },
  { cmd: 'REPRINT', desc: 'Reprint the current label without creating a new shipment.' },
  { cmd: 'LOGOUT', desc: 'End this operator\'s shift on this station (station stays configured for the next operator).' },
];

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error);
  return data;
}

function PackingStation() {
  // Two-stage login: the station itself is configured once (Station ID only —
  // the shop is fixed), then whichever operator is on shift identifies
  // themselves by scanning their own barcode — matching the tech doc's
  // LOGIN OPERATOR command.
  const [stationReady, setStationReady] = useState(false);
  const [stationId, setStationId] = useState('STATION-A');
  const [debugMode, setDebugMode] = useState(false);
  const [operatorName, setOperatorName] = useState('');

  const [state, setState] = useState(null); // { session, order, items, allComplete, tracking_no, internal_barcode }
  const [lastSku, setLastSku] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const [infoType, setInfoType] = useState('info'); // info | error | success
  const [scanValue, setScanValue] = useState('');
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [queueCounts, setQueueCounts] = useState({ ready_to_pack: 0, deferred_ready: 0 });
  const inputRef = useRef(null);
  const submittingRef = useRef(false); // reentrancy guard — a real scanner can fire faster than a request round-trips
  const printFrameRef = useRef(null);

  useEffect(() => {
    if (stationReady && inputRef.current) inputRef.current.focus();
  }, [stationReady, operatorName, state]);

  // Single source of truth for checking a station out of the admin Active
  // Station view. Runs as a cleanup whenever operatorName changes (covers
  // LOGOUT and the auto-timeout) AND on unmount (covers the operator hitting
  // "← Back" without logging out first — that unmounts this component
  // entirely, so nothing inside it would otherwise run).
  useEffect(() => {
    return () => {
      if (operatorName) {
        fetch(`${API_BASE}/operators/check-out`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ station_id: stationId }),
        });
      }
    };
  }, [operatorName, stationId]);

  // Background sync — automatic only. Operators don't need a manual sync
  // button; that's a system/admin concern, not a packing-floor one.
  useEffect(() => {
    if (!stationReady) return;
    performSync();
    const interval = setInterval(performSync, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationReady]);

  // Detects the backend auto-releasing this session after 1h of inactivity
  // (operator walked away and never came back) and logs the operator out —
  // the station itself stays configured for whoever badges in next.
  useEffect(() => {
    if (!state || state.session.status !== 'IN_PROGRESS') return;
    const sessionId = state.session.id;
    const interval = setInterval(async () => {
      const res = await fetch(`${API_BASE}/packing/session/${sessionId}`);
      if (res.status === 404) {
        setOperatorName('');
        setState(null);
        setLastSku(null);
        notify('Session timed out after 1 hour of inactivity — logged out.', 'error');
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [state?.session?.id, state?.session?.status]);

  async function refreshCounts() {
    try {
      const res = await fetch(`${API_BASE}/orders/queue-counts?shop_id=${SHOP_ID}`);
      const data = await res.json();
      if (res.ok) setQueueCounts(data);
    } catch {
      // best-effort — the counts are informational, not worth surfacing an error for
    }
  }

  function notify(text, type = 'info') {
    setInfoMessage(text);
    setInfoType(type);
  }

  // The "what to do next" bar is always derived from current state — never
  // set imperatively — so it can't drift out of sync with what's actually true.
  function getGuidance() {
    if (!operatorName) return { text: 'Scan your operator barcode to log in.', type: 'info' };
    if (paused) return { text: 'Station paused. Scan RESUME to continue.', type: 'info' };
    if (!state) return { text: 'Scan NEXT_ORDER to begin.', type: 'info' };
    const { session, allComplete } = state;

    if (session.status === 'DONE') return { text: 'Order done! Grabbing next order...', type: 'success' };
    if (session.status === 'DEFERRED_READY') {
      return { text: `Set aside. Internal barcode: ${session.internal_barcode}. Grabbing next order...`, type: 'success' };
    }
    if (session.status === 'EXCEPTION') {
      return { text: 'Order flagged as a problem (MASALAH) — needs manual resolution.', type: 'error' };
    }
    if (session.status === 'AWAITING_LABEL_SCAN') {
      return { text: `Label printed: ${session.tracking_no}. Scan the label to confirm.`, type: 'info' };
    }
    if (session.status === 'IN_PROGRESS') {
      return allComplete
        ? { text: 'All items scanned! Scan KIRIM_HARI_INI or PACK_BESOK.', type: 'success' }
        : { text: 'Scan each item on the order.', type: 'info' };
    }
    return { text: 'Scan NEXT_ORDER to continue.', type: 'info' };
  }

  function applyState(data) {
    setState(data);
    if (data.session?.status === 'DONE') {
      setTimeout(() => grabNextOrder(), 800);
    } else if (data.session?.status === 'DEFERRED_READY') {
      setTimeout(() => grabNextOrder(), 1200);
    } else if (data.session?.status === 'AWAITING_LABEL_SCAN') {
      autoPrintLabel(data.session.id);
    }
  }

  // Cross-origin PDFs can't have .print() called on them directly, so fetch it
  // into a same-origin blob first, then print that. Still shows the browser's
  // print dialog — a fully silent zero-click print needs the station's browser
  // launched with a kiosk-printing flag, or a local print-agent service; both
  // are machine/deployment setup, not something the web app can force.
  async function autoPrintLabel(sessionId) {
    try {
      const res = await fetch(`${API_BASE}/packing/label/${sessionId}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const iframe = printFrameRef.current;
      if (!iframe) return;
      iframe.onload = () => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      };
      iframe.src = blobUrl;
    } catch {
      // best-effort — the "View real Shopee label PDF" link still works as a fallback
    }
  }

  async function grabNextOrder() {
    try {
      const data = await post('/packing/next-order', { station_id: stationId, shop_id: SHOP_ID, operator_name: operatorName, debug: debugMode });
      setLastSku(null);
      applyState(data);
    } catch (err) {
      setState(null);
      notify(err.message === 'no_orders' ? 'No orders ready to pack right now.' : err.message, 'error');
    }
  }

  async function grabNextBesok() {
    setBusy(true);
    setBusyLabel('Rechecking order status & booking shipment with Shopee...');
    try {
      const data = await post('/packing/next-besok', { station_id: stationId, shop_id: SHOP_ID, operator_name: operatorName });
      setLastSku(null);
      applyState(data);
    } catch (err) {
      setState(null);
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function handleStationSetup(e) {
    e.preventDefault();
    setStationReady(true);
  }

  async function performSync() {
    try {
      const res = await fetch(`${API_BASE}/orders/sync?shop_id=${SHOP_ID}`, { method: 'POST' });
      if (!res.ok) return;
      setLastSyncAt(Date.now());
      await refreshCounts();
    } catch {
      // best-effort background sync — queue counts just won't update this cycle
    }
  }

  function handleLogout() {
    setOperatorName('');
    setState(null);
    setLastSku(null);
    notify('Logged out', 'info');
  }

  async function handleOperatorBarcode(barcode) {
    try {
      const res = await fetch(`${API_BASE}/operators/lookup?barcode=${encodeURIComponent(barcode)}&station_id=${encodeURIComponent(stationId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setOperatorName(data.name);
      notify(`Welcome, ${data.name}.`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function handleScanSubmit(e) {
    if (e) e.preventDefault();
    const value = scanValue.trim();
    setScanValue('');
    if (!value) return;

    if (submittingRef.current) {
      return notify('Still processing the previous scan — try again in a moment.', 'error');
    }

    // Not identified yet — every scan here is treated as an operator login
    // barcode attempt, not a packing command.
    if (!operatorName) {
      submittingRef.current = true;
      try {
        await handleOperatorBarcode(value);
      } finally {
        submittingRef.current = false;
      }
      return;
    }

    if (value === 'LOGOUT') return handleLogout();
    if (value === 'PAUSE') { setPaused(true); return notify('Paused', 'info'); }
    if (value === 'RESUME') { setPaused(false); return notify('Resumed', 'info'); }
    if (paused) return notify('Station is paused. Scan RESUME first.', 'error');

    submittingRef.current = true;
    try {
      if (value === 'NEXT_ORDER' || value === 'NEXT_ORDER_KEMAREN') {
        if (state && state.session.status !== 'DONE' && state.session.status !== 'DEFERRED_READY') {
          return notify('Finish or defer the current order first.', 'error');
        }
        return value === 'NEXT_ORDER' ? await grabNextOrder() : await grabNextBesok();
      }

      if (!state) {
        // no active session — only NEXT_ORDER or resuming a Pack Besok barcode make sense here
        if (value.startsWith('BESOK-')) {
          setBusy(true);
          setBusyLabel('Rechecking order status & booking shipment with Shopee...');
          try {
            const data = await post('/packing/resume-besok', { internal_barcode: value });
            applyState(data);
          } finally {
            setBusy(false);
          }
          return;
        }
        return notify('No active order. Scan NEXT_ORDER first.', 'error');
      }

      if (state.session.status === 'AWAITING_LABEL_SCAN') {
        if (value === 'REPRINT') {
          const data = await post('/packing/reprint', { session_id: state.session.id });
          return notify(`Reprinted label: ${data.tracking_no}`, 'success');
        }
        const data = await post('/packing/label-scan', { session_id: state.session.id, tracking_no: value });
        return applyState(data);
      }

      if (state.session.status === 'IN_PROGRESS') {
        if (value === 'MASALAH') {
          const data = await post('/packing/masalah', { session_id: state.session.id });
          setState(data);
          return notify('Order flagged as a problem (MASALAH).', 'error');
        }
        if (value === 'RELEASE_ORDER') {
          await post('/packing/release-order', { session_id: state.session.id });
          setState(null);
          setLastSku(null);
          return notify(`Order ${state.order.order_sn} released back to the pool.`, 'success');
        }
        if (value === 'UNDO') {
          if (!lastSku) return notify('Nothing to undo.', 'error');
          const data = await post('/packing/undo-last-scan', { session_id: state.session.id, sku: lastSku });
          setLastSku(null);
          return applyState(data);
        }
        if (value === 'KIRIM_HARI_INI') {
          if (!state.allComplete) return notify('Not all items are scanned yet.', 'error');
          setBusy(true);
          setBusyLabel('Booking shipment & generating label with Shopee...');
          try {
            const data = await post('/packing/ship-today', { session_id: state.session.id });
            applyState(data);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (value === 'PACK_BESOK') {
          if (!state.allComplete) return notify('Not all items are scanned yet.', 'error');
          const data = await post('/packing/pack-besok', { session_id: state.session.id });
          return applyState(data);
        }
        // otherwise treat it as an item SKU scan
        const data = await post('/packing/scan-item', { session_id: state.session.id, sku: value });
        setLastSku(value);
        return applyState(data);
      }

      notify('Unexpected state — scan NEXT_ORDER to reset.', 'error');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      submittingRef.current = false;
    }
  }

  if (!stationReady) {
    return (
      <div style={{ background: colors.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)' }}>
        <form onSubmit={handleStationSetup} style={{ ...setupCardStyle, width: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <IconMonitor size={18} />
            <span style={{ fontWeight: 700, fontSize: 16, color: colors.text, fontFamily: 'var(--heading)' }}>KELPER Station</span>
          </div>
          <label style={setupLabelStyle}>Station ID</label>
          <input value={stationId} onChange={(e) => setStationId(e.target.value)} style={setupInputStyle} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: colors.textDim, cursor: 'pointer' }}>
            <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(e.target.checked)} />
            Debug mode (gunakan order mockup, tidak memanggil Shopee)
          </label>
          <button type="submit" style={setupSubmitStyle}>Continue</button>
          {infoMessage && (
            <p style={{ marginTop: 12, fontSize: 13, color: infoType === 'error' ? colors.red : infoType === 'success' ? colors.green : colors.textDim }}>
              {infoMessage}
            </p>
          )}
        </form>
      </div>
    );
  }

  const showGreen = state?.allComplete && state.session.status === 'IN_PROGRESS';
  const guidance = getGuidance();

  return (
    <div style={{ display: 'flex', gap: 24, maxWidth: 924, margin: '20px auto', alignItems: 'flex-start', textAlign: 'left' }}>
      <div
        style={{
          width: 260,
          flexShrink: 0,
          fontFamily: 'var(--sans)',
          background: '#1a1a1a',
          color: 'white',
          borderRadius: 8,
          padding: 20,
          fontSize: 12,
        }}
      >
        <div style={{ fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Commands
        </div>
        {operatorName ? (
          COMMANDS.map(({ cmd, desc }) => (
            <div key={cmd} style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'monospace', color: '#a5d6a7' }}>{cmd}</div>
              <div style={{ opacity: 0.85 }}>{desc}</div>
            </div>
          ))
        ) : (
          <div style={{ opacity: 0.85 }}>Scan your operator barcode to see available commands.</div>
        )}
      </div>

      <div
        style={{
          flex: 1,
          fontFamily: 'var(--sans)',
          padding: 24,
          background: showGreen ? '#2e7d32' : '#1a1a1a',
          color: 'white',
          borderRadius: 8,
          transition: 'background 0.2s',
        }}
      >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h2>Packing Station — {stationId}</h2>
        <div style={{ textAlign: 'right', fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 14, fontWeight: 'bold' }}>
              {operatorName || 'Not logged in'} {paused && '(PAUSED)'}
            </span>
            {operatorName && <button onClick={handleLogout} style={{ fontSize: 12 }}>Logout</button>}
          </div>
          <div>Last sync: {formatTime(lastSyncAt)}</div>
          <div>Next sync: {formatTime(lastSyncAt && lastSyncAt + SYNC_INTERVAL_MS)}</div>
          <div>New orders to process: {queueCounts.ready_to_pack}</div>
          <div>Orders from yesterday to process: {queueCounts.deferred_ready}</div>
        </div>
      </div>

      {state ? (
        <div>
          <p>
            Order: <strong>{state.order.order_sn}</strong> — {state.order.buyer_name}
            {state.order.order_sn.startsWith('MOCK-') && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 'bold', color: '#000', background: '#ffca28', padding: '2px 6px', borderRadius: 4 }}>
                DEBUG
              </span>
            )}
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #555' }}>
                <th>SKU</th><th>Product</th><th>Scanned / Qty</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((it) => (
                <tr key={it.sku} style={{ color: it.scanned_qty === it.qty ? '#a5d6a7' : 'white' }}>
                  <td>{it.sku}</td>
                  <td>{it.product_name}</td>
                  <td>{it.scanned_qty} / {it.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.session.status === 'AWAITING_LABEL_SCAN' && (
            <a
              href={`${API_BASE}/packing/label/${state.session.id}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#90caf9', display: 'inline-block', marginBottom: 16 }}
            >
              View {state.order.order_sn.startsWith('MOCK-') ? 'mock' : 'real Shopee'} label PDF (tracking: {state.session.tracking_no})
            </a>
          )}
        </div>
      ) : (
        <p>{operatorName ? 'No active order.' : 'Scan your operator barcode below to log in.'}</p>
      )}

      <style>{`
        @keyframes kelper-spin { to { transform: rotate(360deg); } }
        .kelper-spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255,255,255,0.4);
          border-top-color: #fff;
          border-radius: 50%;
          animation: kelper-spin 0.7s linear infinite;
          margin-right: 8px;
          vertical-align: middle;
        }
      `}</style>

      <div
        style={{
          padding: 12,
          borderRadius: 4,
          marginBottom: 16,
          background: busy ? '#37474f' : guidance.type === 'error' ? '#c62828' : guidance.type === 'success' ? '#1b5e20' : '#333',
        }}
      >
        {busy ? (<><span className="kelper-spinner" />{busyLabel}</>) : guidance.text}
      </div>

      <input
        ref={inputRef}
        value={scanValue}
        onChange={(e) => setScanValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleScanSubmit(e); }}
        onBlur={() => inputRef.current && inputRef.current.focus()}
        autoFocus
        placeholder={busy ? 'Please wait... (scans still accepted)' : operatorName ? 'Scan here (command or SKU)...' : 'Scan operator barcode...'}
        style={{ ...inputStyle, background: '#000', color: '#0f0', fontFamily: 'monospace', fontSize: 18 }}
      />

      {infoMessage && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Status
          </div>
          <div
            style={{
              padding: 10,
              borderRadius: 4,
              fontSize: 13,
              background: infoType === 'error' ? '#c62828' : infoType === 'success' ? '#1b5e20' : '#333',
            }}
          >
            {infoMessage}
          </div>
        </div>
      )}
      </div>

      <iframe ref={printFrameRef} title="label-print" style={{ display: 'none' }} />
    </div>
  );
}

const setupCardStyle = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 16,
  padding: 24,
  boxSizing: 'border-box',
};

const setupLabelStyle = {
  display: 'block',
  fontSize: 12,
  color: colors.textDim,
  marginBottom: 4,
};

const setupInputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginBottom: 14,
  boxSizing: 'border-box',
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  color: colors.text,
  fontFamily: 'var(--sans)',
};

const setupSubmitStyle = {
  width: '100%',
  padding: '10px 16px',
  background: colors.text,
  color: colors.bg,
  border: 'none',
  borderRadius: 8,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
};

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: 10,
  marginTop: 4,
  marginBottom: 12,
  boxSizing: 'border-box',
};

export default PackingStation;
