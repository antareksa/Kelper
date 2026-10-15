import { useCallback, useEffect, useState } from 'react';
import { colors, card } from './theme';
import { IconSearch } from './Icons';
import { API_BASE, apiFetch } from './apiBase';
import { SHOP_ID } from './shopConfig';

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())} ${pad(d.getMonth() + 1)} ${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const SESSION_STATUS_LABEL = {
  IN_PROGRESS: 'Sedang Dikerjakan',
  RESUMING: 'Sedang Dikerjakan',
  AWAITING_LABEL_SCAN: 'Menunggu Scan Label',
  DEFERRED_READY: 'Diproses Besok',
  READY_FOR_PICKUP: 'Siap Diambil',
  EXCEPTION: 'Order Bermasalah',
  DONE: 'Selesai (Diambil Kurir)',
};

function StatusBadge({ label, accent = colors.text }) {
  return (
    <span style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${accent}`, color: accent, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function OrderDetailCard({ result }) {
  return (
    <div style={card()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: colors.text, fontFamily: 'var(--heading)' }}>{result.order_sn}</div>
          <div style={{ fontSize: 12.5, color: colors.textDim, marginTop: 4 }}>{result.buyer_name || '—'}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12.5, color: colors.textDim }}>
          <div>DITERIMA - {formatDateTime(result.created_at)}</div>
          <div>PENGIRIMAN - {result.shipping_carrier || '—'}{result.is_instant ? ' (Instant)' : ''}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatusBadge label={SESSION_STATUS_LABEL[result.status] || result.status} />
        {result.session && result.session.status !== result.status && (
          <StatusBadge label={SESSION_STATUS_LABEL[result.session.status] || result.session.status} accent={colors.blue} />
        )}
        {result.needs_retry_ship && <StatusBadge label="Perlu Retry Ship" accent={colors.red} />}
        {result.tracking_no && <StatusBadge label={`AWB: ${result.tracking_no}`} />}
        {result.session?.forced && <StatusBadge label="DIPAKSA" accent={colors.orange} />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: result.session ? 16 : 0 }}>
        {result.items.length === 0 ? (
          <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Belum ada data item.</p>
        ) : (
          result.items.map((it) => (
            <div
              key={it.sku}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12.5 }}
            >
              <div>
                <div style={{ color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{it.sku}</div>
                <div style={{ color: colors.textDim, fontSize: 11 }}>{it.product_name}</div>
              </div>
              <div style={{ color: colors.text, fontFamily: 'var(--num)', fontWeight: 600 }}>{it.scanned_qty}/{it.qty}</div>
            </div>
          ))
        )}
      </div>

      {result.session && (
        <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}`, fontSize: 12.5, color: colors.textDim, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div>Station: <span style={{ color: colors.text }}>{result.session.station_id}</span></div>
          <div>Operator: <span style={{ color: colors.text }}>{result.session.operator_name || '—'}</span></div>
          <div>Mulai: <span style={{ color: colors.text }}>{formatDateTime(result.session.started_at)}</span></div>
          <div>Selesai: <span style={{ color: colors.text }}>{formatDateTime(result.session.completed_at)}</span></div>
        </div>
      )}
    </div>
  );
}

// One order's detail, the same way the search gets it. Returns { result } or { error }.
async function fetchOrder(orderSn) {
  const res = await apiFetch(`${API_BASE}/orders/search?order_sn=${encodeURIComponent(orderSn)}`);
  if (res.status === 404) return { error: 'Order tidak ditemukan di database.' };
  if (!res.ok) return { error: 'Gagal mengambil data order.' };
  return { result: await res.json() };
}

function OrderPopup({ onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 720, position: 'relative' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: -32, right: 0, background: 'transparent', border: 'none', color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--sans)' }}
        >
          Tutup ✕
        </button>
        {children}
      </div>
    </div>
  );
}

// <input type="datetime-local"> value for a Date, in the browser's own time.
function toInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRupiah(value) {
  if (value == null) return '—';
  return `Rp${Math.round(Number(value)).toLocaleString('id-ID')}`;
}

const LIST_GRID = 'minmax(150px,1.2fr) 150px minmax(110px,1fr) minmax(110px,1fr) minmax(130px,1fr) 50px 110px minmax(150px,1.2fr)';

// Order list (client-requested 2026-10-15): the orders a Packing Station
// processed between two date-times (backend routes/orders.js /list). A row opens
// the same detail as the search, in a popup.
function OrderList({ onOpen }) {
  const [from, setFrom] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return toInputValue(d); });
  const [to, setTo] = useState(() => { const d = new Date(); d.setHours(23, 59, 0, 0); return toInputValue(d); });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hovered, setHovered] = useState(null);

  async function load() {
    const fromTs = Math.floor(new Date(from).getTime() / 1000);
    const toTs = Math.floor(new Date(to).getTime() / 1000) + 60; // "Sampai" includes that whole minute
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      setError('Rentang waktu tidak valid.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/orders/list?shop_id=${SHOP_ID}&from=${fromTs}&to=${toTs}`);
      if (!res.ok) throw new Error('Gagal memuat daftar order.');
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- today on open; later loads via "Tampilkan"

  const showTotal = !!data?.orders.some((o) => o.total !== undefined);
  const inputStyle = { padding: '8px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.cardAlt, color: colors.text, fontSize: 13, fontFamily: 'var(--sans)', colorScheme: 'dark' };

  return (
    <div style={card({ padding: 0 })}>
      <div style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.text, fontFamily: 'var(--heading)', marginRight: 'auto', alignSelf: 'center' }}>Daftar Order</div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.textDim }}>
          Dari
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.textDim }}>
          Sampai
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
        </label>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: '9px 18px', borderRadius: 6, border: 'none', background: colors.text, color: colors.bg, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Memuat...' : 'Tampilkan'}
        </button>
      </div>

      {error && <p style={{ color: colors.red, fontSize: 13, margin: 16 }}>{error}</p>}

      {data && (
        <>
          <div style={{ padding: '10px 16px', fontSize: 12.5, color: colors.textDim, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span><b style={{ color: colors.text }}>{data.orders.length}</b> order</span>
            {showTotal && <span>Total <b style={{ color: colors.text }}>{formatRupiah(data.orders.reduce((sum, o) => sum + (o.total || 0), 0))}</b></span>}
            {data.truncated && <span style={{ color: colors.orange }}>Hanya 2000 order terbaru yang ditampilkan: persempit rentang waktunya.</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 980 }}>
              <div style={{ display: 'grid', gridTemplateColumns: LIST_GRID, gap: 10, padding: '8px 16px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderTop: `1px solid ${colors.border}`, borderBottom: `1px solid ${colors.border}` }}>
                <span>Order ID</span>
                <span>Diproses</span>
                <span>Operator</span>
                <span>Ekspedisi</span>
                <span>Resi</span>
                <span>Item</span>
                <span>{showTotal ? 'Total' : ''}</span>
                <span>Status</span>
              </div>
              {data.orders.length === 0 ? (
                <div style={{ padding: 16, fontSize: 12.5, color: colors.textFaint }}>Tidak ada order yang diproses di rentang waktu ini.</div>
              ) : (
                data.orders.map((o) => (
                  <div
                    key={o.order_sn}
                    onClick={() => onOpen(o.order_sn)}
                    onMouseEnter={() => setHovered(o.order_sn)}
                    onMouseLeave={() => setHovered(null)}
                    style={{ display: 'grid', gridTemplateColumns: LIST_GRID, gap: 10, alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, fontSize: 12.5, cursor: 'pointer', color: colors.text, background: hovered === o.order_sn ? colors.cardHover : 'transparent' }}
                  >
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>
                      {o.order_sn}
                      {o.is_instant && <span style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 700, color: colors.bg, background: colors.orange, padding: '1px 5px', borderRadius: 4 }}>INSTANT</span>}
                    </span>
                    <span style={{ color: colors.textDim }}>{formatDateTime(o.started_at)}</span>
                    <span>{o.operator_name || '—'}</span>
                    <span style={{ textTransform: 'uppercase' }}>{o.shipping_carrier || '—'}</span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: colors.textDim }}>{o.tracking_no || '—'}</span>
                    <span style={{ fontFamily: 'var(--num)' }}>{o.item_qty}</span>
                    <span style={{ fontFamily: 'var(--num)' }}>{showTotal ? formatRupiah(o.total) : ''}</span>
                    <span style={{ color: o.session_status === 'DONE' ? colors.green : o.session_status === 'EXCEPTION' ? colors.red : colors.textDim }}>
                      {SESSION_STATUS_LABEL[o.session_status] || o.session_status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// New "Order" menu (client-requested 2026-09-27): a plain search-by-order-ID
// lookup, deliberately DB-only — no live Shopee calls — see routes/orders.js
// /search. Top of the page is the search bar; the result card only appears once
// a search has actually run. Below it, the order list (OrderList, 2026-10-15).
export default function OrderSearch() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [popup, setPopup] = useState(null); // { loading } | { result } | { error } for an order opened from the list
  const closePopup = useCallback(() => setPopup(null), []);

  async function handleSearch(e) {
    e.preventDefault();
    const orderSn = query.trim();
    if (!orderSn) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const found = await fetchOrder(orderSn);
      if (found.error) setError(found.error);
      else setResult(found.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function openFromList(orderSn) {
    setPopup({ loading: true });
    try {
      setPopup(await fetchOrder(orderSn));
    } catch (err) {
      setPopup({ error: err.message });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: colors.textDim, display: 'flex' }}>
            <IconSearch size={15} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari Order ID..."
            style={{
              width: '100%',
              padding: '12px 14px 12px 36px',
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              background: colors.cardAlt,
              color: colors.text,
              fontSize: 14,
              fontFamily: 'var(--sans)',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: '12px 22px',
            borderRadius: 8,
            border: 'none',
            background: colors.text,
            color: colors.bg,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'var(--sans)',
            opacity: loading ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          {loading ? 'Mencari...' : 'Cari'}
        </button>
      </form>

      {error && <p style={{ color: colors.red, fontSize: 13.5, margin: 0 }}>{error}</p>}

      {result && <OrderDetailCard result={result} />}

      <OrderList onOpen={openFromList} />

      {popup && (
        <OrderPopup onClose={closePopup}>
          {popup.loading ? <p style={{ color: colors.textDim, fontSize: 13, margin: 0 }}>Memuat...</p>
            : popup.error ? <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{popup.error}</p>
            : <OrderDetailCard result={popup.result} />}
        </OrderPopup>
      )}
    </div>
  );
}
