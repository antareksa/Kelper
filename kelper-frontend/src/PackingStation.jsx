import { useEffect, useRef, useState } from 'react';
import { colors, card } from './theme';
import { IconMonitor } from './Icons';
import { renderCode39Svg } from './Barcode';
import { SHOP_ID } from './shopConfig';
import { API_BASE } from './apiBase';

// orders.created_at / packing_sessions.completed_at are unix SECONDS
// (server-side, see shopeeSync.js's now()), not the millisecond timestamps
// Date.now() would give client-side.
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

// One item row in the active scan list. Steady-state only now — the
// transient red/green scan feedback lives on the two big panels instead
// (see ItemScanCard's `panelState`), not per row. `isCurrent` just gives the
// next-expected item (the one shown big on the left) a subtle highlight
// here on the right so the two panels visibly agree on what's up next.
function ItemRow({ item, isCurrent }) {
  const done = item.scanned_qty >= item.qty;
  const bg = done ? colors.greenDim : isCurrent ? colors.cardHover : 'transparent';
  const border = done ? colors.green : isCurrent ? colors.textDim : colors.border;

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

// Both big panels share one color state, driven from the same place:
//   - 'success' (green, permanent): every item on the order is done.
//   - 'success'/'error' (temporary, ~3s): right after a scan, correct or
//     rejected — set by PackingStation's flashPanel, cleared automatically.
//   - 'active' (yellow): the steady "scanning in progress" state otherwise.
const PANEL_COLORS = {
  active: { bg: colors.yellowDim, border: colors.yellow },
  success: { bg: colors.greenDim, border: colors.green },
  error: { bg: colors.redDim, border: colors.red },
};

// The item-scan screen — shown while actively scanning (IN_PROGRESS with
// item data) and, briefly, right after finishing a Pack Besok order
// (DEFERRED_READY) while its temp barcode label prints — see
// `waitingMessage`. Left: a single big image of the current item to scan
// (the next one not yet fully scanned) — sized 2:1 against the list on the
// right, matching the wireframe (the list only needs to show short rows,
// the image is the whole point of this screen). Right: the full item list,
// fully-scanned rows sunk to the bottom (stable within each group) so the
// operator never has to scroll past done items to see what's left.
function ItemScanCard({ order, receivedAt, items, flash, allComplete, waitingMessage }) {
  const remaining = items.filter((it) => it.scanned_qty < it.qty);
  const done = items.filter((it) => it.scanned_qty >= it.qty);
  const current = remaining[0];

  const panelState = allComplete ? 'success' : flash?.type || 'active';
  const { bg: panelBg, border: panelBorder } = PANEL_COLORS[panelState];
  const panelStyle = {
    ...card(),
    background: panelBg,
    border: `2px solid ${panelBorder}`,
    transition: 'background 0.2s ease, border-color 0.2s ease',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
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

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ ...panelStyle, flex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px' }}>
          {current ? (
            <>
              <ItemThumb imageUrl={current.image_url} sku={current.sku} size={320} />
              <div style={{ marginTop: 24, fontSize: 22, fontWeight: 700, color: colors.text }}>{current.sku}</div>
              <div style={{ fontSize: 15, color: colors.textDim, marginTop: 4 }}>{current.product_name}</div>
              <div style={{ fontSize: 36, fontWeight: 700, fontFamily: 'var(--num)', color: colors.text, marginTop: 20 }}>
                {current.scanned_qty}/{current.qty}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.green, lineHeight: 1.5, maxWidth: 420 }}>
              {waitingMessage || 'Semua item sudah discan'}
            </div>
          )}
        </div>

        <div style={{ ...panelStyle, flex: 1, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
          {[...remaining, ...done].map((it) => (
            <ItemRow key={it.sku} item={it} isCurrent={current?.sku === it.sku} />
          ))}
        </div>
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
    <div style={card({ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 })}>
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

      {/* flex:1 + centered both axes — this is the "main" section of the
          kiosk's header/main/footer layout (client-requested 2026-09-27),
          filling all remaining space instead of sitting as a small card at
          the top with the rest of the screen empty. */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '28px 12px', fontSize: 16, fontWeight: 600, color: accent, lineHeight: 1.5 }}>
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
  { cmd: 'NEXT_ORDER', desc: 'Start processing the next available fresh order — automatically picks the highest-priority one (Instant first). Does not resume Pack Besok leftovers; scan that specific order\'s BESOK- barcode instead.' },
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

// Client-requested (2026-09-28): record video of the operator packing, as
// evidence for customer complaints. Local storage only for now (no cloud
// upload yet — see the project_webcam_video_evidence_feature memory for the
// full design).
//
// Saves via a plain browser download rather than the File System Access
// API's folder-picker — that was tried first, but its permission grant only
// lasts the current Chrome process, so it silently reset (re-prompting the
// operator) on every relaunch of start-packing-station.bat, making it
// useless for a kiosk that's meant to be set up once. Chrome's own download
// location IS a genuinely persistent profile setting, so
// setup-video-download-dir.ps1 (run by the .bat, before Chrome starts)
// silently points this profile's downloads at .packing-videos with no
// dialog — meaning a plain `<a download>` click here just works, forever,
// with zero in-app setup step at all.
//
// No resolution constraint here originally meant Chrome negotiated whatever
// low-res default the camera offered first (confirmed against the real JETE
// W9: came out 640x480 despite the camera supporting real 1080p) — `ideal`
// (not `min`/exact) asks for the camera's actual native resolution without
// throwing if it genuinely can't do it.
const VIDEO_CONSTRAINTS = { width: { ideal: 1920 }, height: { ideal: 1080 } };

function downloadPackingVideo(orderSn, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${orderSn}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const [lastPickup, setLastPickup] = useState(null); // { order_sn, created_at, picked_up_at } — most recent Shipping Mode confirmation
  const [state, setState] = useState(null); // { session, order, items, allComplete, tracking_no, internal_barcode }
  const [lastSku, setLastSku] = useState(null);
  const [infoMessage, setInfoMessage] = useState('');
  const [infoType, setInfoType] = useState('info'); // info | error | success
  const [scanValue, setScanValue] = useState('');
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  // Which color the two big scan panels (image + list) flash right after a
  // scan, and for how long — cleared automatically so it falls back to the
  // steady yellow "active" state before the next scan.
  const [flash, setFlash] = useState(null); // { type: 'success' | 'error' }
  const inputRef = useRef(null);
  const testScanInputRef = useRef(null);
  const submittingRef = useRef(false); // reentrancy guard — a real scanner can fire faster than a request round-trips
  const printFrameRef = useRef(null);

  // Packing-video recording (see the module-level comment above) — refs
  // rather than state, since none of this should ever trigger a re-render.
  const [cameraReady, setCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const videoPreviewRef = useRef(null);
  const videoStreamRef = useRef(null);
  const videoRecorderRef = useRef(null);
  const videoChunksRef = useRef([]);
  const recordingSessionIdRef = useRef(null);
  const recordingOrderSnRef = useRef(null);

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

  // Silently checks whether camera permission was already granted in a
  // previous session on this same dedicated profile — avoids showing "Setup
  // Kamera" as still-needed every launch once it's actually been done once.
  useEffect(() => {
    if (!navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: 'camera' })
      .then((status) => setCameraReady(status.state === 'granted'))
      .catch(() => {});
  }, []);

  // Starts/stops packing-video recording in step with the session actually
  // being worked on. Client-requested (2026-09-28): recording now spans
  // through the label-scan confirmation too, not just item-scanning — ends
  // once the real label is scanned back (READY_FOR_PICKUP), not the moment
  // the last item is scanned (AWAITING_LABEL_SCAN), so the recording also
  // proves the right label got attached to the right box. DEFERRED_READY
  // (no real label yet — waits for next work hour, possibly next day) still
  // ends recording immediately; that wait shouldn't be captured. Session id
  // (not just status) is checked so this doesn't restart on every scan while
  // status stays the same for the same order; only a genuine session change
  // re-triggers it.
  const RECORDING_ACTIVE_STATUSES = ['IN_PROGRESS', 'AWAITING_LABEL_SCAN'];
  useEffect(() => {
    const sessionId = state?.session?.id ?? null;
    const status = state?.session?.status;
    const orderSn = state?.order?.order_sn;
    const shouldRecord = RECORDING_ACTIVE_STATUSES.includes(status);

    if (shouldRecord && sessionId !== recordingSessionIdRef.current) {
      startPackingVideo(sessionId, orderSn);
    } else if (!shouldRecord && recordingSessionIdRef.current !== null) {
      stopPackingVideo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.session?.id, state?.session?.status]);

  // Covers the operator hitting "← Back"/logging out mid-scan — same
  // reasoning as the check-out effect below, just for an in-progress
  // recording that would otherwise never get saved.
  useEffect(() => {
    return () => {
      if (recordingSessionIdRef.current !== null) stopPackingVideo();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wires the live camera stream into the preview <video> once recording
  // actually starts (can't do this at mount time — the stream doesn't exist
  // until getUserMedia resolves, which happens well after this element first
  // renders). Client-requested (2026-09-28): visible during packing only.
  useEffect(() => {
    if (isRecording && videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = videoStreamRef.current;
    }
  }, [isRecording]);

  // Best-effort throughout — a webcam problem (denied/missing/busy device)
  // never blocks packing itself, per the client's own call: no recording
  // that one time beats stopping the operator from working.
  async function startPackingVideo(sessionId, orderSn) {
    recordingSessionIdRef.current = sessionId;
    recordingOrderSnRef.current = orderSn;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
      videoStreamRef.current = stream;
      videoChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { videoBitsPerSecond: 1_000_000 });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) videoChunksRef.current.push(e.data);
      };
      recorder.start();
      videoRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.warn(`[packing-video] camera unavailable for ${orderSn}, continuing without recording:`, err.message);
    }
  }

  async function stopPackingVideo() {
    const recorder = videoRecorderRef.current;
    const orderSn = recordingOrderSnRef.current;
    recordingSessionIdRef.current = null;
    recordingOrderSnRef.current = null;
    videoRecorderRef.current = null;
    setIsRecording(false);

    videoStreamRef.current?.getTracks().forEach((t) => t.stop());
    videoStreamRef.current = null;
    if (!recorder || recorder.state === 'inactive') return;

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(videoChunksRef.current, { type: 'video/webm' }));
      recorder.stop();
    });
    videoChunksRef.current = [];
    await savePackingVideo(orderSn, blob);
  }

  function savePackingVideo(orderSn, blob) {
    if (!orderSn) return;
    try {
      downloadPackingVideo(orderSn, blob);
    } catch (err) {
      console.warn(`[packing-video] failed to save video for ${orderSn}:`, err.message);
    }
  }

  // One-time real permission grant (replaces the --use-fake-ui-for-media-
  // stream flag, which triggered a permanent Chrome warning banner — see
  // start-packing-station.bat). Opens the camera just long enough to trigger
  // the "Allow" prompt, then immediately releases it — recording itself
  // opens its own stream later, per order.
  async function setupCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: false });
      stream.getTracks().forEach((t) => t.stop());
      setCameraReady(true);
      notify('Kamera siap.', 'success');
    } catch (err) {
      setCameraReady(false);
      notify(`Kamera tidak tersedia: ${err.message}`, 'error');
    }
  }

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
  // required to actually get the next order. 3s rather than something
  // closer to the server's own 30s sync interval — this only ever hits our
  // own already-synced database (GET /packing/next-order), never Shopee
  // directly, so there's no rate limit or cost to checking often.
  useEffect(() => {
    if (!operatorName || paused || mode !== 'packing' || state || busy) return;
    const interval = setInterval(() => grabNextOrder(), 3000);
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

  // Briefly colors both scan panels green (correct scan) or red (rejected
  // scan) for 3s, then falls back to the steady yellow "active" state.
  function flashPanel(type) {
    setFlash({ type });
    setTimeout(() => setFlash((f) => (f?.type === type ? null : f)), 3000);
  }

  // The "what to do next" bar is always derived from current state — never
  // set imperatively — so it can't drift out of sync with what's actually true.
  function getGuidance() {
    if (!operatorName) return { text: 'Scan your operator barcode to log in.', type: 'info' };
    if (mode === 'shipping') return { text: 'Shipping Mode — scan a packed label to confirm pickup. Scan PACKING_MODE to go back.', type: 'info' };
    if (paused) return { text: 'Station paused. Scan RESUME to continue.', type: 'info' };
    if (!state) return { text: 'Menunggu orderan masuk...', type: 'info' };
    const { session, allComplete } = state;

    if (session.status === 'DONE') return { text: 'Order done! Grabbing next order...', type: 'success' };
    // Client-requested (2026-09-23): "Ready to Check" auto-assigns a labeled
    // Pack Besok order to this station (see /next-order), but the operator
    // still has to physically confirm they have the right box by scanning
    // its own temp barcode before anything prints — this state is that
    // wait. Items are already done (that's why it's a leftover at all), so
    // this deliberately isn't the item-scan screen.
    if (session.status === 'RESUMING') {
      return { text: `Order ${state.order.order_sn} sudah siap diproses. Scan barcode sementara ${session.internal_barcode} untuk melanjutkan.`, type: 'info' };
    }
    if (session.status === 'DEFERRED_READY') {
      // Normally shown inside ItemScanCard instead (see `waitingMessage` in
      // the main render) — this is only a fallback for the rare case where
      // item data isn't available and ItemScanCard can't render.
      return state.withinWorkHour
        ? { text: 'Mohon tunggu label resi. Scan label resi jika sudah di tempel', type: 'success' }
        : { text: 'Mohon tunggu label barcode sementara. Scan label resi sementara jika sudah di tempel', type: 'success' };
    }
    if (session.status === 'EXCEPTION') {
      return { text: 'Order flagged as a problem (MASALAH) — needs manual resolution.', type: 'error' };
    }
    if (session.status === 'AWAITING_LABEL_SCAN') {
      // Never claim "printed" here — a browser has no way to know whether a
      // physical page actually came out (no print-completion callback
      // exists), and asserting success when we don't know it is exactly
      // what left operators stuck staring at "scan to confirm" with nothing
      // in hand. The scan itself is the only real confirmation there is.
      return { text: `Printing label for ${state.order.order_sn} — scan its barcode once it's out to confirm. If nothing comes out, scan REPRINT.`, type: 'info' };
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
      // This only ever fires once per order, the moment it's first set
      // aside because it has no real label yet (see finalizeCompletedOrder)
      // — resuming it once labeled moves it straight to AWAITING_LABEL_SCAN
      // instead, so there's no risk of printing this a second time. 3s
      // (not the old 1.2s) so the operator actually has time to read the
      // "wait for the label, scan it once attached" message (see
      // ItemScanCard's waitingMessage) and see the temp barcode print
      // before the station moves on to the next order.
      printBesokLabel(data.session, data.order);
      setTimeout(() => grabNextOrder(), 3000);
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
      // If this order was ever deferred, printBesokLabel already set srcdoc
      // on this exact iframe element for its temp barcode — srcdoc always
      // takes precedence over src per spec, so without clearing it first,
      // the assignment below is silently ignored and the iframe keeps
      // showing the old temp barcode forever, never loading (or printing)
      // the real label. Confirmed against production: a fresh order's
      // label printed fine (srcdoc was never set for it), a resumed Pack
      // Besok order's real label never printed (srcdoc was already set by
      // its own earlier defer step).
      iframe.removeAttribute('srcdoc');
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

  // Prints a physical Code 39 barcode label for a Pack Besok order's
  // internal_barcode (BESOK-XXXX), so there's something real to stick on the
  // parked package and scan back tomorrow — RESUME_BESOK already looks this
  // exact value up (see handleScanSubmit's `value.startsWith('BESOK-')`
  // branch), it just had nothing physical printed for it until now.
  function printBesokLabel(session, order) {
    const iframe = printFrameRef.current;
    if (!iframe || !session?.internal_barcode) return;
    // srcdoc always wins over src per spec, so this isn't strictly needed
    // for THIS assignment to take effect — but clearing it keeps the iframe
    // from holding a stale blob: reference from a previous autoPrintLabel
    // call once this session's real label eventually gets reprinted later.
    iframe.removeAttribute('src');
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
          <h2>PACK BESOK</h2>
          ${renderCode39Svg(session.internal_barcode)}
          <p style="letter-spacing: 2px;">${session.internal_barcode}</p>
          <p style="font-size: 11px;">Order: ${order?.order_sn ?? '—'}</p>
          <p style="font-size: 11px;">Tempel di paket, scan besok untuk lanjutkan.</p>
        </body>
      </html>
    `;
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
      // Otherwise a still-ticking flash from the order that just finished
      // (e.g. the permanent green "all complete" state) would visibly bleed
      // onto this freshly loaded order for whatever's left of its timer.
      setFlash(null);
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
        setLastPickup({ order_sn: data.order_sn, created_at: data.created_at, picked_up_at: data.picked_up_at });
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

      // RESUMING: this order was auto-assigned to the station (see
      // /next-order's leftover pool) but nothing's printed yet — the
      // operator must scan this exact session's own temp barcode first, to
      // physically confirm they have the right box, before the real label
      // gets printed. Same /resume-besok endpoint a manual barcode lookup
      // uses; it now accepts an already-assigned RESUMING session too.
      if (state.session.status === 'RESUMING') {
        const data = await post('/packing/resume-besok', { internal_barcode: value });
        return applyState(data);
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
          // Which item actually incremented — the scanned value can be a
          // barcode, not the SKU itself, so this can't just check `value`
          // directly; diffing against the pre-scan counts finds the real one.
          const grown = data.items.find((it) => {
            const before = state.items.find((b) => b.sku === it.sku);
            return before && it.scanned_qty > before.scanned_qty;
          });
          if (grown) {
            flashPanel('success');
            notify(`${grown.product_name} scanned (${grown.scanned_qty}/${grown.qty})`, 'success');
          }
          return applyState(data);
        } catch (err) {
          // Any rejected scan (wrong item, already fully scanned, or not
          // part of this order at all) flashes both panels red.
          flashPanel('error');
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

          <button
            data-mouse-input="true"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={setupCamera}
            style={{ ...setupSubmitStyle, marginBottom: 8 }}
          >
            {cameraReady ? 'Kamera Siap ✅' : 'Setup Kamera'}
          </button>
          <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: colors.textDim }}>
            Video packing tersimpan otomatis ke folder ".packing-videos" (diatur oleh start-packing-station.bat) — tidak perlu pengaturan lain.
          </p>

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
  // scan, flagged, etc.) all fall through to the single unified
  // ActionMessageCard instead. DEFERRED_READY is included on purpose: right
  // after a Pack Besok order finishes, it briefly shows the same two-panel
  // layout with a "please wait for the label" message instead of the
  // current item (see ItemScanCard's `waitingMessage`), matching the
  // wireframe rather than switching to a different single-panel screen.
  const showItemScan = !paused && mode === 'packing' && state && ['IN_PROGRESS', 'DEFERRED_READY'].includes(state.session.status) && state.items.length > 0;

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

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
        {isRecording && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 10,
              width: 160,
              borderRadius: 10,
              overflow: 'hidden',
              border: `2px solid ${colors.red}`,
              boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
            }}
          >
            <video ref={videoPreviewRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', height: 'auto' }} />
            <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,0,0,0.55)', padding: '2px 8px', borderRadius: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: colors.red }} className="kelper-pulse" />
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>REC</span>
            </div>
          </div>
        )}
        {mode === 'shipping' ? (
          lastPickup ? (
            <ActionMessageCard
              order={{ order_sn: lastPickup.order_sn }}
              receivedAt={lastPickup.created_at}
              type="info"
              message={`DIPICKUP EKSPEDISI - ${formatReceivedAt(lastPickup.picked_up_at)}`}
            />
          ) : (
            <ActionMessageCard type="info" message="Scan label resi untuk mulai proses pickup order oleh ekpedisi" />
          )
        ) : showItemScan ? (
          <ItemScanCard
            order={state.order}
            receivedAt={state.order.created_at}
            items={state.items}
            flash={flash}
            allComplete={state.allComplete}
            waitingMessage={
              state.session.status === 'DEFERRED_READY'
                ? state.withinWorkHour
                  ? 'Mohon tunggu label resi. Scan label resi jika sudah di tempel'
                  : 'Mohon tunggu label barcode sementara. Scan label resi sementara jika sudah di tempel'
                : null
            }
          />
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
