import { useEffect, useRef, useState } from 'react';
import { colors, card } from './theme';
import { IconMonitor } from './Icons';
import { renderCode39Svg } from './Barcode';

// A production build is served from the same origin as the API (Caddy
// proxies both from one hostname), so relative paths just work and http://
// would break under HTTPS as mixed content anyway. Dev still needs the
// explicit cross-origin call since Vite's dev server (5173) and the backend
// (3001) really are different origins there.
const API_BASE = import.meta.env.PROD ? '' : `http://${window.location.hostname}:3001`;
const SHOP_ID = 227886187;

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// orders.created_at is unix SECONDS (server-side, see shopeeSync.js's now())
// — unlike formatTime above, which takes the millisecond timestamps this
// same file generates client-side (Date.now(), pickupLog entries).
function formatReceivedAt(tsSeconds) {
  if (!tsSeconds) return '—';
  const d = new Date(tsSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Same "no image → colored initials" fallback already used for products
// with no synced Shopee image (see ListBarang.jsx) — kept visually
// consistent across the app rather than inventing a second placeholder style.
function ItemThumb({ imageUrl, sku, size = 44 }) {
  if (imageUrl) {
    return <img src={imageUrl} alt="" style={{ width: size, height: size, borderRadius: 8, objectFit: 'cover', display: 'block', flexShrink: 0 }} />;
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: colors.cardAlt,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        color: colors.textDim,
        flexShrink: 0,
      }}
    >
      {sku.slice(0, 2).toUpperCase()}
    </div>
  );
}

// One item row in the active scan list. `flashType` briefly overrides the
// row's background right after a scan targets this exact SKU (see
// PackingStation's flashRow) — green for a correct scan, red for a
// rejected one (already fully scanned) — independent of the row's
// steady-state "done" tint (done rows remain green after the flash fades).
function ItemRow({ item, flashType }) {
  const done = item.scanned_qty >= item.qty;
  const bg = flashType === 'success' ? colors.greenDim : flashType === 'error' ? colors.redDim : done ? colors.greenDim : 'transparent';
  const border = flashType === 'success' ? colors.green : flashType === 'error' ? colors.red : done ? colors.green : colors.border;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: 10,
        border: `1px solid ${border}`,
        background: bg,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <ItemThumb imageUrl={item.image_url} sku={item.sku} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.product_name}
        </div>
        <div style={{ fontSize: 11, color: colors.textDim, fontFamily: 'monospace' }}>{item.sku}</div>
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontFamily: 'var(--num)',
          color: done ? colors.green : colors.text,
          flexShrink: 0,
        }}
      >
        {item.scanned_qty}/{item.qty}
      </div>
    </div>
  );
}

// The item-scan screen — shown only while actively scanning (IN_PROGRESS
// with item data). Fully-scanned rows sink to the bottom (stable within
// each group) so the operator never has to scroll past done items to see
// what's left, no matter how long the order is.
function ItemScanCard({ order, receivedAt, items, flash }) {
  const remaining = items.filter((it) => it.scanned_qty < it.qty);
  const done = items.filter((it) => it.scanned_qty >= it.qty);

  return (
    <div style={card()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: colors.textDim }}>
          Order <span style={{ color: colors.text, fontWeight: 600, fontFamily: 'monospace' }}>{order.order_sn}</span>
          {order.order_sn.startsWith('MOCK-') && (
            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: colors.bg, background: colors.orange, padding: '2px 6px', borderRadius: 4 }}>
              DEBUG
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: colors.textFaint }}>Diterima {formatReceivedAt(receivedAt)}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {[...remaining, ...done].map((it) => (
          <ItemRow key={it.sku} item={it} flashType={flash?.sku === it.sku ? flash.type : null} />
        ))}
      </div>
    </div>
  );
}

// Everything that ISN'T "actively scanning items" funnels through here —
// no active order, waiting for item data, flagged as a problem, waiting on
// a label confirm scan, finishing up, etc. Order context (when there is
// one) sits above the message so it's never ambiguous which order a
// transitional message refers to.
function ActionMessageCard({ order, receivedAt, message, type }) {
  const accent = type === 'error' ? colors.red : type === 'success' ? colors.green : colors.textDim;
  return (
    <div style={card()}>
      {order && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${colors.border}`, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 13, color: colors.textDim }}>
            Order <span style={{ color: colors.text, fontWeight: 600, fontFamily: 'monospace' }}>{order.order_sn}</span>
            {order.order_sn.startsWith('MOCK-') && (
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: colors.bg, background: colors.orange, padding: '2px 6px', borderRadius: 4 }}>
                DEBUG
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: colors.textFaint }}>Diterima {formatReceivedAt(receivedAt)}</div>
        </div>
      )}

      <div style={{ padding: '28px 12px', textAlign: 'center', fontSize: 16, fontWeight: 600, color: accent, lineHeight: 1.5 }}>
        {message}
      </div>
    </div>
  );
}

// The bottom bar doubles as both the scan-capture point and the feedback
// channel: "Barcode Scanner Active..." when idle, or the latest scan result
// (colored per type) right after one — one place to look, instead of a
// separate status box the operator's eyes have to jump to. The actual
// input is functionally real (ref, focus, keystrokes) but visually
// invisible; this div is what's actually seen.
function ScanFeedbackBar({ inputRef, value, onChange, onKeyDown, onBlur, message, type }) {
  const accent = type === 'error' ? colors.red : type === 'success' ? colors.green : colors.textDim;
  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        autoFocus
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 'none', padding: 0 }}
      />
      <div
        style={{
          padding: '14px 16px',
          borderRadius: 10,
          background: colors.cardAlt,
          border: `1px solid ${message ? accent : colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 13,
          fontWeight: message ? 600 : 400,
          color: accent,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.green, flexShrink: 0 }} className="kelper-pulse" />
        {message || 'Barcode Scanner Active...'}
      </div>
    </div>
  );
}

const COMMANDS = [
  { cmd: 'NEXT_ORDER', desc: 'Start processing the next available order — automatically picks the highest-priority one (Instant, then yesterday\'s leftovers, then fresh).' },
  { cmd: 'PAUSE', desc: 'Pause the station (freezes scanning) while you step away.' },
  { cmd: 'RESUME', desc: 'Resume the station after a pause.' },
  { cmd: 'UNDO', desc: 'Revert your last item scan.' },
  { cmd: 'MASALAH', desc: 'Flag the current order as a problem — needs manual resolution.' },
  { cmd: 'RELEASE_ORDER', desc: "Give up this order and put it back in the pool for any station (e.g. you're not going to finish it)." },
  { cmd: 'REPRINT', desc: 'After scanning all items: if the label fails to scan back (printer issue), reprint it without creating a new shipment.' },
  { cmd: 'SHIPPING_MODE', desc: 'Switch this station to Shipping Mode — scan packed labels to confirm courier pickup, separate from packing.' },
  { cmd: 'PACKING_MODE', desc: 'Switch back to normal packing from Shipping Mode.' },
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
  const [operatorName, setOperatorName] = useState('');
  const [testScanValue, setTestScanValue] = useState('');
  const [lastTestScan, setLastTestScan] = useState(null);
  const [paperWidthMm, setPaperWidthMm] = useState(100);
  const [paperHeightMm, setPaperHeightMm] = useState(120);
  const [hwCheckCode, setHwCheckCode] = useState(null);
  const [hwCheckStatus, setHwCheckStatus] = useState('idle'); // idle | awaiting_scan | pass | fail

  const [mode, setMode] = useState('packing'); // packing | shipping — toggled by scanning SHIPPING_MODE / PACKING_MODE
  const [pickupLog, setPickupLog] = useState([]); // recent Shipping Mode confirmations, most recent first
  const [state, setState] = useState(null); // { session, order, items, allComplete, tracking_no, internal_barcode }
  const [lastSku, setLastSku] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const [infoType, setInfoType] = useState('info'); // info | error | success
  const [scanValue, setScanValue] = useState('');
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  // Which item row to flash green/red right after a scan, and for how long —
  // cleared automatically so it never lingers past the next scan.
  const [flash, setFlash] = useState(null); // { sku, type: 'success' | 'error' }
  const inputRef = useRef(null);
  const testScanInputRef = useRef(null);
  const submittingRef = useRef(false); // reentrancy guard — a real scanner can fire faster than a request round-trips
  const printFrameRef = useRef(null);

  // Station ID / debug checkbox are the one place a mouse is expected (initial
  // setup); the scanner test below should work the moment the screen loads,
  // same as the real scan input does once logged in — no click needed.
  useEffect(() => {
    if (!stationReady) testScanInputRef.current?.focus();
  }, [stationReady]);

  useEffect(() => {
    if (stationReady && inputRef.current) inputRef.current.focus();
  }, [stationReady, operatorName, state]);

  // Kiosk-mode prints silently and instantly, with no OS dialog — but the
  // printer driver itself can still briefly take real OS-level window focus
  // away from Chrome during the physical print (some thermal-printer drivers
  // pop a transient status window), which no amount of element.focus() can
  // fix on its own since the input can look focused at the DOM level while
  // the browser window itself isn't the foreground window — the blinking
  // caret follows OS focus, not DOM focus. window.focus() asks the browser
  // to reclaim the foreground; element.focus() then puts the caret back on
  // the right field. Each print helper calls this directly after its
  // .print() call, and the watchdog below keeps re-asserting it afterward.
  function focusScanInput() {
    window.focus();
    if (stationReady) inputRef.current?.focus();
    else testScanInputRef.current?.focus();
  }

  // Self-healing backstop: whatever specifically stole focus — a button, the
  // invisible print iframe, a real print dialog, the printer driver's own
  // status window, an OS app-switch — this keeps re-asserting focus so it
  // can't stay lost for more than a fraction of a second, without needing to
  // know which of those it was. It reasserts unconditionally (not just when
  // it detects focus is missing) because document.activeElement can already
  // read as the scan input while the OS window itself still isn't foreground
  // — re-calling focus() is a harmless no-op in the normal case. The only
  // exemption is the handful of fields that genuinely need a mouse during
  // one-time station setup (marked data-mouse-input="true"); anything else
  // is fair game to reclaim, since the physical station has no mouse.
  useEffect(() => {
    const interval = setInterval(() => {
      const active = document.activeElement;
      if (active?.dataset?.mouseInput === 'true') return;
      const target = stationReady ? inputRef.current : testScanInputRef.current;
      if (!target) return;
      window.focus();
      target.focus();
    }, 400);
    return () => clearInterval(interval);
  }, [stationReady]);

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

  // Auto-retry when idle so a station with nothing to do picks up a newly
  // available order on its own — the server can finish booking one
  // moments after this station last checked and came up empty. NEXT_ORDER
  // still works as a manual "check right now" nudge, it's just no longer
  // required to actually get the next order.
  useEffect(() => {
    if (!operatorName || paused || mode !== 'packing' || state || busy) return;
    const interval = setInterval(() => grabNextOrder(), 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatorName, paused, mode, state, busy]);

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

  // Self-healing for the "order booked but Shopee hasn't sent item details
  // yet" gap: the server backfills order_items in the background on its
  // own schedule, independent of this session — so once it succeeds, this
  // picks the new items up automatically instead of leaving the operator
  // stuck on a screen with nothing to scan and no way to notice it changed.
  useEffect(() => {
    if (!state || state.session.status !== 'IN_PROGRESS' || state.items.length > 0) return;
    const sessionId = state.session.id;
    const interval = setInterval(async () => {
      const res = await fetch(`${API_BASE}/packing/session/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.items?.length > 0) applyState(data);
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.session?.id, state?.session?.status, state?.items?.length]);

  function notify(text, type = 'info') {
    setInfoMessage(text);
    setInfoType(type);
  }

  // Briefly highlights one item row green (correct scan) or red (rejected
  // scan) — cleared on a timer so it never lingers into the next scan.
  function flashRow(sku, type) {
    setFlash({ sku, type });
    setTimeout(() => setFlash((f) => (f?.sku === sku && f?.type === type ? null : f)), 700);
  }

  // The "what to do next" bar is always derived from current state — never
  // set imperatively — so it can't drift out of sync with what's actually true.
  function getGuidance() {
    if (!operatorName) return { text: 'Scan your operator barcode to log in.', type: 'info' };
    if (mode === 'shipping') return { text: 'Shipping Mode — scan a packed label to confirm pickup. Scan PACKING_MODE to go back.', type: 'info' };
    if (paused) return { text: 'Station paused. Scan RESUME to continue.', type: 'info' };
    if (!state) return { text: 'No orders ready right now — checking automatically. Scan NEXT_ORDER to check now.', type: 'info' };
    const { session, allComplete } = state;

    if (session.status === 'DONE') return { text: 'Order done! Grabbing next order...', type: 'success' };
    if (session.status === 'DEFERRED_READY') {
      return { text: `Set aside. Internal barcode: ${session.internal_barcode}. Grabbing next order...`, type: 'success' };
    }
    if (session.status === 'EXCEPTION') {
      return { text: 'Order flagged as a problem (MASALAH) — needs manual resolution.', type: 'error' };
    }
    if (session.status === 'AWAITING_LABEL_SCAN') {
      return { text: `Label printed for ${state.order.order_sn} — scan the label's barcode to confirm it printed correctly. If nothing came out (or it's wrong), scan REPRINT.`, type: 'info' };
    }
    if (session.status === 'READY_FOR_PICKUP') {
      return { text: `Confirmed — put it on the package. Grabbing next order...`, type: 'success' };
    }
    if (session.status === 'IN_PROGRESS') {
      if (state.items.length === 0) {
        return { text: 'No item data from Shopee yet for this order — nothing to scan. Waiting for it to arrive (checking automatically), or scan RELEASE_ORDER to put it back and try a different one.', type: 'error' };
      }
      return allComplete
        ? { text: 'All items scanned — finishing up...', type: 'success' }
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
      // Print, then stop and wait — the operator must scan the label back to
      // confirm it actually came out before this station moves on. That
      // confirm-scan is the printer health check; there's no separate
      // detection for a jam/out-of-paper/wrong-tray failure.
      autoPrintLabel(data.session.id);
    } else if (data.session?.status === 'READY_FOR_PICKUP') {
      // Reached only after the confirm-scan above succeeds — safe to move on.
      setTimeout(() => grabNextOrder(), 800);
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
        // A brand-new kiosk window may not have finished enumerating system
        // printers yet — printing immediately can make Chrome fall back to
        // its own "Save as PDF" pseudo-destination instead of the real
        // default. A short delay gives printer discovery time to finish.
        setTimeout(() => {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
          focusScanInput();
        }, 1000);
      };
      iframe.src = blobUrl;
    } catch {
      // best-effort — the "View real Shopee label PDF" link still works as a fallback
    }
  }

  // Pure hardware sanity check — no backend involved. Builds a tiny static
  // receipt and prints it the same way a real label gets printed, just
  // skipping the fetch-a-PDF step since there's nothing real to print yet.
  function handleTestPrint() {
    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        focusScanInput();
      }, 1000);
    };
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            @page { size: ${paperWidthMm}mm ${paperHeightMm}mm; margin: 0; }
            html, body {
              width: ${paperWidthMm}mm;
              height: ${paperHeightMm}mm;
              margin: 0;
              overflow: hidden;
            }
            body {
              font-family: monospace;
              box-sizing: border-box;
              padding: 8mm;
              page-break-after: avoid;
              page-break-inside: avoid;
            }
          </style>
        </head>
        <body>
          <h2>TEST PRINT OK</h2>
          <p>Station: ${stationId}</p>
          <p>Paper: ${paperWidthMm}mm x ${paperHeightMm}mm</p>
          <p>Time: ${new Date().toLocaleString()}</p>
        </body>
      </html>
    `;
  }

  // Closed-loop hardware check: print a barcode encoding a fresh random code,
  // then require the operator to scan that exact barcode back. A match proves
  // the printer produced a physically scannable label AND the scanner reads
  // it correctly — checking both devices in one pass instead of trusting
  // "the printer made paper come out" and "the scanner made text appear" as
  // separate, weaker signals.
  function startHardwareCheck() {
    const code = `HW${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    setHwCheckCode(code);
    setHwCheckStatus('awaiting_scan');

    const iframe = printFrameRef.current;
    if (!iframe) return;
    iframe.onload = () => {
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        focusScanInput();
      }, 1000);
    };
    iframe.srcdoc = `
      <html>
        <head>
          <style>
            @page { size: ${paperWidthMm}mm ${paperHeightMm}mm; margin: 0; }
            html, body {
              width: ${paperWidthMm}mm;
              height: ${paperHeightMm}mm;
              margin: 0;
              overflow: hidden;
            }
            body {
              font-family: monospace;
              box-sizing: border-box;
              padding: 8mm;
              text-align: center;
              page-break-after: avoid;
              page-break-inside: avoid;
            }
            svg { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <h2>HARDWARE CHECK</h2>
          ${renderCode39Svg(code)}
          <p style="letter-spacing: 2px;">${code}</p>
          <p style="font-size: 11px;">Scan this barcode below to confirm hardware.</p>
        </body>
      </html>
    `;
  }

  // Scanning/typing TEST_PRINT here triggers the same print as the button —
  // the physical station only has a scanner and a printer, no mouse, so
  // nothing in this panel should require a click to operate.
  function handleTestScan(e) {
    if (e.key !== 'Enter') return;
    const value = testScanValue;
    setTestScanValue('');
    if (value === 'TEST_PRINT') {
      handleTestPrint();
      return;
    }
    if (value === 'CHECK_HW') {
      startHardwareCheck();
      return;
    }
    if (hwCheckStatus === 'awaiting_scan') {
      setHwCheckStatus(value === hwCheckCode ? 'pass' : 'fail');
      return;
    }
    setLastTestScan(value);
  }

  // Accepts an explicit operator name override for the call made right after
  // login (see handleOperatorBarcode) — setOperatorName() there hasn't been
  // applied to the `operatorName` state yet by the time this runs in the same
  // tick, so falling back to the closed-over state would send an empty name.
  async function grabNextOrder(overrideOperatorName) {
    try {
      const data = await post('/packing/next-order', { station_id: stationId, shop_id: SHOP_ID, operator_name: overrideOperatorName ?? operatorName });
      setLastSku(null);
      applyState(data);
    } catch (err) {
      setState(null);
      notify(err.message === 'no_orders' ? 'No orders ready right now — checking automatically.' : err.message, 'error');
    }
  }

  function handleStationSetup(e) {
    e.preventDefault();
    setStationReady(true);
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
      // No separate NEXT_ORDER scan needed to start a shift — go straight
      // into the first order the same way the station already auto-advances
      // between orders (see applyState).
      setBusy(true);
      setBusyLabel('Finding the next order...');
      try {
        await grabNextOrder(data.name);
      } finally {
        setBusy(false);
      }
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
    // Mode toggle works regardless of pause/session state — switching to
    // check on pickups shouldn't require first resolving whatever the
    // packing side happens to be doing.
    if (value === 'SHIPPING_MODE') { setMode('shipping'); return notify('Shipping Mode — scan a packed label to confirm pickup.', 'info'); }
    if (value === 'PACKING_MODE') { setMode('packing'); return notify('Back to Packing Mode.', 'info'); }
    if (paused) return notify('Station is paused. Scan RESUME first.', 'error');

    if (mode === 'shipping') {
      submittingRef.current = true;
      try {
        const data = await post('/packing/confirm-pickup', { order_sn: value });
        setPickupLog((log) => [{ order_sn: data.order_sn, at: Date.now() }, ...log].slice(0, 20));
        return notify(`${data.order_sn} confirmed picked up.`, 'success');
      } catch (err) {
        return notify(err.message, 'error');
      } finally {
        submittingRef.current = false;
      }
    }

    submittingRef.current = true;
    try {
      if (value === 'NEXT_ORDER') {
        const doneStatuses = ['DONE', 'DEFERRED_READY', 'READY_FOR_PICKUP'];
        if (state && !doneStatuses.includes(state.session.status)) {
          return notify('Finish or defer the current order first.', 'error');
        }
        setBusy(true);
        setBusyLabel('Finding the next order...');
        try {
          await grabNextOrder();
        } finally {
          setBusy(false);
        }
        return;
      }

      if (!state) {
        // no active session — only NEXT_ORDER or resuming a Pack Besok barcode make sense here
        if (value.startsWith('BESOK-')) {
          setBusy(true);
          setBusyLabel('Confirming order status...');
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

      // AWAITING_LABEL_SCAN blocks here until the operator scans the printed
      // label back — that scan is the printer health check (see
      // finalizeCompletedOrder). REPRINT re-fires the same label/PDF without
      // creating a new shipment; any other scan is tried as the confirm.
      if (state.session.status === 'AWAITING_LABEL_SCAN') {
        if (value === 'REPRINT') {
          await post('/packing/reprint', { session_id: state.session.id });
          autoPrintLabel(state.session.id);
          return notify('Reprinting label...', 'info');
        }
        const data = await post('/packing/confirm-print', { session_id: state.session.id, order_sn: value });
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
        // otherwise treat it as an item SKU scan — the server auto-decides
        // ship-today vs. defer-to-tomorrow once every item is scanned
        try {
          const data = await post('/packing/scan-item', { session_id: state.session.id, sku: value });
          setLastSku(value);
          // Which row actually incremented — the scanned value can be a
          // barcode, not the SKU itself, so this can't just flash `value`
          // directly; diffing against the pre-scan counts finds the real one.
          const grown = data.items.find((it) => {
            const before = state.items.find((b) => b.sku === it.sku);
            return before && it.scanned_qty > before.scanned_qty;
          });
          if (grown) {
            flashRow(grown.sku, 'success');
            notify(`${grown.product_name} scanned (${grown.scanned_qty}/${grown.qty})`, 'success');
          }
          return applyState(data);
        } catch (err) {
          // A rejected scan that still matches a known row (already fully
          // scanned) gets a red flash on that row; one that matches nothing
          // (wrong item entirely) has no row to flash, so it's left to the
          // status message below instead.
          const match = state.items.find((it) => it.sku === value || it.barcode === value);
          if (match) flashRow(match.sku, 'error');
          throw err;
        }
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
      <div style={{ background: colors.bg, minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--sans)' }}>
        <form onSubmit={handleStationSetup} style={{ ...setupCardStyle, width: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <IconMonitor size={18} />
            <span style={{ fontWeight: 700, fontSize: 16, color: colors.text, fontFamily: 'var(--heading)' }}>KELPER Station</span>
          </div>
          <label style={setupLabelStyle}>Station ID</label>
          <input data-mouse-input="true" value={stationId} onChange={(e) => setStationId(e.target.value)} style={setupInputStyle} />
          <button data-mouse-input="true" type="submit" style={setupSubmitStyle}>Continue</button>
          {infoMessage && (
            <p style={{ marginTop: 12, fontSize: 13, color: infoType === 'error' ? colors.red : infoType === 'success' ? colors.green : colors.textDim }}>
              {infoMessage}
            </p>
          )}
        </form>

        <div style={{ ...setupCardStyle, width: 320, marginTop: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: colors.text, marginBottom: 12 }}>Hardware Test</div>

          <label style={setupLabelStyle}>Paper size (mm)</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              data-mouse-input="true"
              type="number"
              min="1"
              value={paperWidthMm}
              onChange={(e) => setPaperWidthMm(Number(e.target.value))}
              style={{ ...setupInputStyle, marginBottom: 0 }}
              aria-label="Paper width (mm)"
            />
            <span style={{ color: colors.textDim, alignSelf: 'center' }}>x</span>
            <input
              data-mouse-input="true"
              type="number"
              min="1"
              value={paperHeightMm}
              onChange={(e) => setPaperHeightMm(Number(e.target.value))}
              style={{ ...setupInputStyle, marginBottom: 0 }}
              aria-label="Paper height (mm)"
            />
          </div>

          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={handleTestPrint} style={{ ...setupSubmitStyle, marginBottom: 12 }}>
            Test Print
          </button>

          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={startHardwareCheck} style={{ ...setupSubmitStyle, marginBottom: 8 }}>
            Check Hardware
          </button>
          {hwCheckStatus === 'awaiting_scan' && (
            <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: colors.textDim }}>
              Printed <strong>{hwCheckCode}</strong> — scan it below to confirm.
            </p>
          )}
          {hwCheckStatus === 'pass' && (
            <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: colors.green }}>
              ✅ Hardware ready — printer and scanner both confirmed.
            </p>
          )}
          {hwCheckStatus === 'fail' && (
            <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: colors.red }}>
              ❌ Scanned value didn't match the printed barcode. Scan CHECK_HW to retry.
            </p>
          )}

          <label style={setupLabelStyle}>Scan here (or scan TEST_PRINT / CHECK_HW — no mouse needed)</label>
          <input
            ref={testScanInputRef}
            value={testScanValue}
            onChange={(e) => setTestScanValue(e.target.value)}
            onKeyDown={handleTestScan}
            onBlur={() => testScanInputRef.current && testScanInputRef.current.focus()}
            placeholder="Scan or type, then press Enter"
            style={setupInputStyle}
          />
          {lastTestScan !== null && (
            <p style={{ marginTop: 8, fontSize: 13, color: colors.green }}>
              Last scanned: <strong>{lastTestScan}</strong>
            </p>
          )}
        </div>

        <iframe ref={printFrameRef} title="label-print" style={{ display: 'none' }} />
      </div>
    );
  }

  const guidance = getGuidance();
  // The item-scan list only makes sense while actively scanning a real
  // order — paused, no order, or any transitional status (awaiting label
  // scan, finishing up, flagged, etc.) all fall through to the single
  // unified ActionMessageCard instead.
  const showItemScan = !paused && mode === 'packing' && state && state.session.status === 'IN_PROGRESS' && state.items.length > 0;

  return (
    <div style={{ width: '100%', minHeight: '100vh', boxSizing: 'border-box', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, background: colors.bg, textAlign: 'left', fontFamily: 'var(--sans)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)', color: colors.text }}>
            {mode === 'shipping' ? 'Shipping Mode' : 'Packing Station'}
          </div>
          <div style={{ fontSize: 12, color: colors.textDim }}>{stationId}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
            {operatorName || 'Not logged in'}{paused ? ' (PAUSED)' : ''}
          </div>
          {operatorName && (
            <button
              onClick={handleLogout}
              style={{ fontSize: 11, padding: '3px 10px', marginTop: 4, background: colors.cardAlt, border: `1px solid ${colors.border}`, color: colors.text, borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--sans)' }}
            >
              Logout
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {mode === 'shipping' ? (
          <div style={{ ...card(), flex: 1 }}>
            <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 14, lineHeight: 1.5 }}>
              Scan each packed label's barcode as the courier takes it — confirms pickup and clears it from the Ready to Pickup pool. Independent of whatever the packing side is doing.
            </div>
            {pickupLog.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textFaint, fontSize: 13 }}>Belum ada pickup dikonfirmasi sesi ini.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {pickupLog.map((entry) => (
                  <div key={`${entry.order_sn}-${entry.at}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
                    <span style={{ fontFamily: 'monospace', color: colors.green }}>{entry.order_sn}</span>
                    <span style={{ color: colors.textDim }}>{formatTime(entry.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : showItemScan ? (
          <ItemScanCard order={state.order} receivedAt={state.order.created_at} items={state.items} flash={flash} />
        ) : (
          <ActionMessageCard
            order={state?.order}
            receivedAt={state?.order?.created_at}
            type={busy ? 'info' : guidance.type}
            message={
              <>
                {busy ? (<><span className="kelper-spinner" />{busyLabel}</>) : guidance.text}
                {!busy && state && ['AWAITING_LABEL_SCAN', 'READY_FOR_PICKUP'].includes(state.session.status) && (
                  <div style={{ marginTop: 16 }}>
                    <a
                      href={`${API_BASE}/packing/label/${state.session.id}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: colors.blue, fontSize: 13, fontWeight: 500 }}
                    >
                      Lihat label {state.order.order_sn.startsWith('MOCK-') ? 'mock' : 'Shopee'} PDF (resi: {state.session.tracking_no})
                    </a>
                  </div>
                )}
              </>
            }
          />
        )}
      </div>

      <ScanFeedbackBar
        inputRef={inputRef}
        value={scanValue}
        onChange={(e) => setScanValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleScanSubmit(e); }}
        onBlur={() => inputRef.current && inputRef.current.focus()}
        message={infoMessage}
        type={infoType}
      />

      <style>{`
        @keyframes kelper-spin { to { transform: rotate(360deg); } }
        .kelper-spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid ${colors.textFaint};
          border-top-color: ${colors.text};
          border-radius: 50%;
          animation: kelper-spin 0.7s linear infinite;
          margin-right: 8px;
          vertical-align: middle;
        }
        @keyframes kelper-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        .kelper-pulse { animation: kelper-pulse 1.4s ease-in-out infinite; }
        /* No mouse on the real station once setup is done — this rule only
           exists in the DOM while this screen is mounted, so Station Setup
           (rendered separately, before stationReady) keeps the normal cursor.
           !important overrides the browser's own default cursor on inputs/
           buttons (text caret, pointer), which plain inheritance can't. */
        *, *::before, *::after { cursor: none !important; }
      `}</style>

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

export default PackingStation;
