import { useState } from 'react';
import { colors, card } from './theme';
import { IconSearch } from './Icons';
import { API_BASE, apiFetch } from './apiBase';

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
  DEFERRED_READY: 'Ready to Process Tomorrow',
  READY_FOR_PICKUP: 'Ready to Pickup',
  EXCEPTION: 'Problem Order',
};

function StatusBadge({ label, accent = colors.text }) {
  return (
    <span style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${accent}`, color: accent, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

// New "Order" menu (client-requested 2026-09-27): a plain search-by-order-ID
// lookup, deliberately DB-only — no live Shopee calls — see routes/orders.js
// /search. Top of the page is only the search bar; the result card only
// appears once a search has actually run.
export default function OrderSearch() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    const orderSn = query.trim();
    if (!orderSn) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch(`${API_BASE}/orders/search?order_sn=${encodeURIComponent(orderSn)}`);
      if (res.status === 404) {
        setError('Order tidak ditemukan di database.');
        return;
      }
      if (!res.ok) throw new Error('Gagal mengambil data order.');
      setResult(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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

      {result && (
        <div style={card()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: colors.text, fontFamily: 'var(--heading)' }}>{result.order_sn}</div>
              <div style={{ fontSize: 12.5, color: colors.textDim, marginTop: 4 }}>{result.buyer_name || '—'}</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 12.5, color: colors.textDim }}>
              <div>DITERIMA - {formatDateTime(result.created_at)}</div>
              <div>SHIPPING - {result.shipping_carrier || '—'}{result.is_instant ? ' (Instant)' : ''}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatusBadge label={result.status} />
            {result.session && (
              <StatusBadge label={SESSION_STATUS_LABEL[result.session.status] || result.session.status} accent={colors.blue} />
            )}
            {result.needs_retry_ship && <StatusBadge label="Perlu Retry Ship" accent={colors.red} />}
            {result.tracking_no && <StatusBadge label={`AWB: ${result.tracking_no}`} />}
            {result.session?.forced && <StatusBadge label="FORCED" accent={colors.orange} />}
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
      )}
    </div>
  );
}
