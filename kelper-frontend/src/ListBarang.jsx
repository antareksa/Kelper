// Wired to the local Shopee catalog cache (synced on demand via the Refresh
// button, not fetched live on every page load — see /products/sync-shopee).
// Trend and Omset Ini/Lalu need order-history aggregation, a separate,
// bigger feature not built yet — shown as "—" rather than faked, same rule
// the tech doc sets for HPP: an unknown number is never presented as zero.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colors, card } from './theme';
import { IconSearch, IconRefresh, IconUpload, IconStore, IconHistory, IconChevronDown } from './Icons';
import { useShopName } from './useShopName';

// A production build is served from the same origin as the API (Caddy
// proxies both from one hostname), so relative paths just work and http://
// would break under HTTPS as mixed content anyway. Dev still needs the
// explicit cross-origin call since Vite's dev server (5173) and the backend
// (3001) really are different origins there.
const API_BASE = import.meta.env.PROD ? '' : `http://${window.location.hostname}:3001`;
const SHOP_ID = 227886187;

function formatRupiah(value) {
  if (value == null) return '—';
  return `Rp${Number(value).toLocaleString('id-ID')}`;
}

const TABLE_GRID = '32px minmax(220px,2fr) 90px 100px 90px 100px 90px 130px 130px 44px';
const SUB_GRID = '110px 1fr 90px 110px 100px 150px 100px 90px 80px 80px 120px 120px 90px';

function SummaryCard({ label, value, accent }) {
  return (
    <div style={{ ...card(), flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent || colors.text, fontFamily: 'var(--num)' }}>{value}</div>
    </div>
  );
}

// null = no order-history data to compute a trend from yet (not the same as
// a real 0% trend, so it renders distinctly rather than looking like "flat").
function TrendBadge({ value }) {
  if (value == null) {
    return <span style={{ fontSize: 12.5, color: colors.textFaint, fontFamily: 'var(--num)' }}>—</span>;
  }
  if (!value) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: colors.textFaint, fontSize: 12.5, fontFamily: 'var(--num)' }}>
        <span style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${colors.border}` }} />
        0%
      </span>
    );
  }
  const up = value > 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: up ? colors.green : colors.red, fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--num)' }}>
      <span style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${up ? colors.green : colors.red}` }} />
      {up ? '+' : ''}{value}%
    </span>
  );
}

// Average profit % across variants that actually have an HPP entry; null
// (shown as "—") when none of them do, rather than presenting 0%.
function avgProfitPct(variants) {
  const withHpp = variants.filter((v) => v.profitPct != null);
  if (withHpp.length === 0) return null;
  const sum = withHpp.reduce((acc, v) => acc + v.profitPct, 0);
  return Math.round((sum / withHpp.length) * 10) / 10;
}

// Same small thumbnail + hover-preview behavior as the item-level photo, but
// reusable per variant row. Falls back to a plain placeholder box (no
// initials — a variant has no short code worth abbreviating) when there's
// no image at all, which the catalog endpoint already tries to avoid by
// falling back to the item's own photo before this ever renders.
function VariantThumb({ image }) {
  const ref = useRef(null);
  const [hovering, setHovering] = useState(false);

  if (!image) {
    return <div style={{ width: 28, height: 28, borderRadius: 6, background: colors.cardAlt, flexShrink: 0 }} />;
  }

  return (
    <div ref={ref} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} style={{ flexShrink: 0 }}>
      <img src={image} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover', display: 'block' }} />
      {hovering && <ImageHoverPreview src={image} anchorRect={ref.current?.getBoundingClientRect()} />}
    </div>
  );
}

// Renders into document.body via a portal, positioned from the thumbnail's
// own bounding rect, so the big preview can never get clipped by an
// ancestor's overflow:hidden/auto (the table wrapper and card both have
// one) the way a normal absolutely-positioned tooltip would be.
function ImageHoverPreview({ src, anchorRect }) {
  if (!anchorRect) return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: anchorRect.top + anchorRect.height / 2,
        left: anchorRect.right + 10,
        transform: 'translateY(-50%)',
        zIndex: 1000,
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }}
    >
      <img src={src} alt="" style={{ width: 220, height: 220, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
    </div>,
    document.body
  );
}

// Manually-entered stock, separate from Shopee's own "Stok" column — see
// db.js's migration comment for why the client wants these to be able to
// disagree. Saves on blur/Enter rather than per-keystroke; an empty field
// clears it back to null (unknown), not 0.
function StockInput({ sku, value, onSaved }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value == null ? '' : String(value));
  }, [value]);

  async function save() {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next === value) return;
    if (next != null && (!Number.isInteger(next) || next < 0)) {
      setDraft(value == null ? '' : String(value));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/products/${encodeURIComponent(sku)}/stock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: next }),
      });
      if (res.ok) onSaved(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      min="0"
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder="—"
      disabled={saving}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: colors.cardAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        color: colors.text,
        fontFamily: 'var(--num)',
        fontSize: 12.5,
        padding: '4px 6px',
        opacity: saving ? 0.6 : 1,
      }}
    />
  );
}

function ProductRow({ product, expanded, onToggle, onStockSaved }) {
  const initials = product.sku.slice(0, 2);
  const profitPct = avgProfitPct(product.variants);
  const thumbRef = useRef(null);
  const [hovering, setHovering] = useState(false);

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}` }}>
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: TABLE_GRID,
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: colors.textDim }}>
          <IconChevronDown size={12} />
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div
            ref={thumbRef}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            style={{ flexShrink: 0 }}
          >
            {product.image ? (
              <img src={product.image} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', display: 'block' }} />
            ) : (
              <div style={{ width: 36, height: 36, borderRadius: 8, background: colors.cardAlt, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: colors.textDim }}>
                {initials}
              </div>
            )}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {product.name}
            </div>
            <div style={{ fontSize: 11, color: colors.textDim }}>{product.variants.length} varian</div>
          </div>
          {hovering && product.image && (
            <ImageHoverPreview src={product.image} anchorRect={thumbRef.current?.getBoundingClientRect()} />
          )}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {product.status !== 'NORMAL' && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: colors.textDim, background: colors.cardAlt, padding: '3px 8px', borderRadius: 999 }}>
              {product.status === 'BANNED' ? 'DIBANNED' : 'DIARSIPKAN'}
            </span>
          )}
          {product.soldOut && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: colors.red, background: colors.redDim, padding: '3px 8px', borderRadius: 999 }}>
              ● SOLD OUT
            </span>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: colors.blue, fontFamily: 'ui-monospace, monospace' }}>{product.sku}</div>

        <TrendBadge value={null} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: colors.text, fontFamily: 'var(--num)' }}>
          {product.minPurchase ?? '—'}
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 600, color: profitPct == null ? colors.textFaint : profitPct < 0 ? colors.red : colors.green, fontFamily: 'var(--num)' }}>
          {profitPct == null ? '—' : `${profitPct}%`}
        </div>

        <div style={{ fontSize: 12.5, color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>
        <div style={{ fontSize: 12.5, color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>

        <button style={{ background: 'none', border: 'none', color: colors.textDim, cursor: 'pointer', padding: 4 }}>
          <IconHistory size={14} />
        </button>
      </div>

      {expanded && (
        <div style={{ background: colors.bg, padding: '4px 12px 14px 44px' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 900 }}>
              <div style={{ display: 'grid', gridTemplateColumns: SUB_GRID, gap: 10, padding: '8px 10px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                <div>Varian</div>
                <div>Nama Varian</div>
                <div>Stok</div>
                <div>HPP</div>
                <div>Code</div>
                <div>Harga</div>
                <div>Est Profit</div>
                <div>Est % Profit</div>
                <div>Qty Ini</div>
                <div>Qty Lalu</div>
                <div>Omset Ini</div>
                <div>Omset Lalu</div>
                <div>Aksi</div>
              </div>
              {product.variants.map((v) => (
                <div
                  key={v.model_id}
                  style={{ display: 'grid', gridTemplateColumns: SUB_GRID, gap: 10, alignItems: 'center', padding: '10px 10px', background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10, fontSize: 12.5, marginBottom: 6 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <VariantThumb image={v.image} />
                    <span style={{ color: colors.text, fontFamily: 'ui-monospace, monospace' }}>{v.sku}</span>
                  </div>
                  <div style={{ color: colors.text }}>{v.name}</div>
                  <div>
                    <StockInput sku={v.sku} value={v.dashboardStock} onSaved={(next) => onStockSaved(v.sku, next)} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: v.hpp == null ? colors.textFaint : colors.text, fontFamily: 'var(--num)' }}>
                    {formatRupiah(v.hpp)}
                  </div>
                  <div style={{ color: v.barcode == null ? colors.textFaint : colors.text, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {v.barcode ?? '—'}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: colors.text, fontFamily: 'var(--num)' }}>
                      {formatRupiah(v.price)}
                    </div>
                  </div>
                  <div style={{ color: v.profit == null ? colors.textFaint : colors.text, fontFamily: 'var(--num)' }}>{formatRupiah(v.profit)}</div>
                  <div style={{ color: v.profitPct == null ? colors.textFaint : colors.green, fontWeight: 600, fontFamily: 'var(--num)' }}>
                    {v.profitPct == null ? '—' : `${v.profitPct}%`}
                  </div>
                  <div style={{ color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>
                  <div style={{ color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>
                  <div style={{ color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>
                  <div style={{ color: colors.textFaint, fontFamily: 'var(--num)' }}>—</div>
                  <div />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ListBarang() {
  const [expandedSku, setExpandedSku] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active | archived | all
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [uploadMessageType, setUploadMessageType] = useState('info'); // info | error | success
  const shopName = useShopName();
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadCatalog();
  }, []);

  async function loadCatalog() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/products/catalog`);
      setCatalog(await res.json());
    } finally {
      setLoading(false);
    }
  }

  // Updates the just-saved variant's dashboardStock in place rather than a
  // full loadCatalog() round-trip — the PUT already confirmed it saved.
  function handleStockSaved(sku, next) {
    setCatalog((prev) => prev.map((p) => ({
      ...p,
      variants: p.variants.map((v) => (v.sku === sku ? { ...v, dashboardStock: next } : v)),
    })));
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/products/sync-shopee?shop_id=${SHOP_ID}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      await loadCatalog();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  // Imports HPP + Code (barcode) from the client's Excel sheet (Nama, SKU,
  // Modal, Barcode) and assigns them onto the matching product by SKU — the
  // join happens server-side in /products/catalog, so reloading it here is
  // enough to reflect the new HPP/Code values against the Shopee variants.
  async function handleFileChange(e) {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file to re-import after a fix
    if (!file) return;

    setUploading(true);
    setUploadMessage(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`${API_BASE}/products/import-hpp`, { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);

      const skippedNote = data.skippedRows.length > 0 ? ` (${data.skippedRows.length} baris dilewati — SKU kosong)` : '';
      setUploadMessage(`Berhasil impor HPP untuk ${data.imported} SKU.${skippedNote}`);
      setUploadMessageType('success');
      await loadCatalog();
    } catch (err) {
      setUploadMessage(err.message);
      setUploadMessageType('error');
    } finally {
      setUploading(false);
    }
  }

  // Shopee marks a product the seller archives as "UNLIST" (and "BANNED" for
  // one taken down by Shopee) — neither is "NORMAL" anymore, but the item
  // doesn't disappear from Shopee's own records, so it wouldn't disappear
  // from ours either without this filter. Default to hiding both, since an
  // archived product isn't something you're actively selling.
  const statusFiltered = catalog.filter((p) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'archived') return p.status !== 'NORMAL';
    return p.status === 'NORMAL';
  });

  const filtered = statusFiltered.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.variants.some((v) => v.sku.toLowerCase().includes(q));
  });

  const allVariants = statusFiltered.flatMap((p) => p.variants);
  const skuKosong = allVariants.filter((v) => v.hpp == null).length;
  const avgMargin = avgProfitPct(allVariants);

  const summary = [
    { label: 'Total SKU', value: String(allVariants.length) },
    { label: 'SKU Kosong (Tanpa HPP)', value: String(skuKosong), accent: skuKosong > 0 ? colors.red : undefined },
    { label: 'Rata-rata Margin', value: avgMargin == null ? '—' : `${avgMargin}%`, accent: avgMargin != null ? colors.green : undefined },
  ];

  return (
    <div style={{ color: colors.text }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ ...pillStyle, gap: 8, cursor: 'default' }}>
          <IconStore size={15} />
          {shopName || 'Toko belum terhubung'}
        </div>

        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: colors.textFaint }}>
            <IconSearch size={14} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari produk / SKU..."
            style={{ ...inputStyle, paddingLeft: 32 }}
          />
        </div>

        <div style={{ display: 'flex', border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
          {[
            { key: 'active', label: 'Aktif' },
            { key: 'archived', label: 'Diarsipkan' },
            { key: 'all', label: 'Semua' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              style={{
                padding: '0 12px',
                height: 34,
                border: 'none',
                background: statusFilter === key ? colors.cardAlt : colors.card,
                color: statusFilter === key ? colors.text : colors.textDim,
                fontSize: 13,
                fontWeight: statusFilter === key ? 600 : 400,
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={handleSync}
          disabled={syncing}
          style={{ ...pillStyle, width: 34, justifyContent: 'center', padding: 0, opacity: syncing ? 0.6 : 1 }}
          title="Sync dari Shopee"
        >
          <IconRefresh size={15} />
        </button>

        <input ref={fileInputRef} type="file" accept=".xlsx" onChange={handleFileChange} style={{ display: 'none' }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{ ...pillStyle, gap: 8, opacity: uploading ? 0.6 : 1 }}
          title="Impor HPP & Code dari Excel (Nama, SKU, Modal, Barcode)"
        >
          <IconUpload size={15} />
          {uploading ? 'Mengimpor...' : 'Upload HPP'}
        </button>
      </div>

      {error && <p style={{ color: colors.red, fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {uploadMessage && (
        <p style={{ color: uploadMessageType === 'error' ? colors.red : colors.green, fontSize: 13, marginBottom: 12 }}>
          {uploadMessage}
        </p>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {summary.map((s) => <SummaryCard key={s.label} {...s} />)}
      </div>

      <div style={{ ...card({ padding: 0 }), overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Memuat produk...</p>
        ) : catalog.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>
            Belum ada produk. Klik tombol sync ({'↻'}) di atas untuk mengambil data dari Shopee.
          </p>
        ) : filtered.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Tidak ada produk yang cocok dengan filter ini.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 900 }}>
                <div style={{ display: 'grid', gridTemplateColumns: TABLE_GRID, gap: 10, padding: '10px 12px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${colors.border}` }}>
                  <div />
                  <div>Item SKU</div>
                  <div />
                  <div>SKU Induk</div>
                  <div>Trend</div>
                  <div>Min. Pembelian</div>
                  <div>Est % Profit</div>
                  <div>Omset Bulan Ini</div>
                  <div>Omset Bulan Lalu</div>
                  <div>Aksi</div>
                </div>

                {filtered.map((p) => (
                  <ProductRow
                    key={p.item_id}
                    product={p}
                    expanded={expandedSku === p.sku}
                    onToggle={() => setExpandedSku(expandedSku === p.sku ? null : p.sku)}
                    onStockSaved={handleStockSaved}
                  />
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '12px 16px', fontSize: 12.5, color: colors.textDim }}>
              Menampilkan {filtered.length} dari {statusFiltered.length} produk
              {statusFiltered.length !== catalog.length && ` (${catalog.length - statusFiltered.length} disembunyikan oleh filter status)`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const pillStyle = {
  display: 'flex',
  alignItems: 'center',
  height: 34,
  padding: '0 12px',
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.card,
  color: colors.text,
  fontSize: 13,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
  whiteSpace: 'nowrap',
};

const inputStyle = {
  width: '100%',
  height: 34,
  boxSizing: 'border-box',
  padding: '0 10px',
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  color: colors.text,
  fontFamily: 'var(--sans)',
  fontSize: 13,
};

export default ListBarang;
