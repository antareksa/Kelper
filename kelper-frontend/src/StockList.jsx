// List Barang as a Packing Station admin sees it (client-requested
// 2026-10-04): stock and nothing else. No HPP, Harga, barcode, profit or sales
// -- the server's /products/stock-list never sends them to this login, so this
// page could not show them even if it tried. The one thing it can change is a
// SKU's own stock number (same StockInput List Barang uses), plus the stock
// sheet upload, which also only writes stock.

import { useEffect, useMemo, useRef, useState } from 'react';
import { colors, card } from './theme';
import { IconSearch, IconUpload } from './Icons';
import { API_BASE, apiFetch } from './apiBase';
import { StockInput, VariantThumb } from './ListBarang';

const GRID = '56px minmax(120px,1fr) minmax(220px,3fr) 110px 150px';

const inputStyle = {
  height: 34,
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.card,
  color: colors.text,
  fontSize: 13,
  padding: '0 10px',
  fontFamily: 'var(--sans)',
  boxSizing: 'border-box',
};

const pillStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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

export default function StockList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active | archived | all
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const [messageType, setMessageType] = useState('info');
  const fileRef = useRef(null);

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/products/stock-list`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setItems(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Same hiding rule as List Barang: an archived or banned listing isn't
  // something being sold, so it is hidden unless asked for.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((p) => (statusFilter === 'all' ? true : statusFilter === 'archived' ? p.status !== 'NORMAL' : p.status === 'NORMAL'))
      .flatMap((p) => p.variants.map((v) => ({ ...v, productName: p.name, status: p.status, isBundle: p.isBundle })))
      .filter((v) => !q || v.sku.toLowerCase().includes(q) || (v.productName || '').toLowerCase().includes(q) || (v.name || '').toLowerCase().includes(q));
  }, [items, search, statusFilter]);

  function handleStockSaved(sku, next) {
    setItems((list) =>
      list.map((p) => ({ ...p, variants: p.variants.map((v) => (v.sku === sku ? { ...v, dashboardStock: next } : v)) }))
    );
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    e.target.value = ''; // lets the same file be picked again after a fix
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch(`${API_BASE}/products/import-stock`, { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      const notes = [];
      if (data.unmatched?.length > 0) notes.push(`Nama tidak cocok dengan produk: ${data.unmatched.join('; ')}`);
      if (data.unreadable?.length > 0) notes.push(`Nilai kosong/tidak terbaca (tidak diubah): ${data.unreadable.join('; ')}`);
      setMessage(`Berhasil impor stok untuk ${data.imported} SKU.${notes.length ? ` ${notes.join('. ')}.` : ''}`);
      setMessageType(notes.length ? 'info' : 'success');
      await load();
    } catch (err) {
      setMessage(err.message);
      setMessageType('error');
    } finally {
      setUploading(false);
    }
  }

  const filters = [
    { key: 'active', label: 'Aktif' },
    { key: 'archived', label: 'Diarsipkan' },
    { key: 'all', label: 'Semua' },
  ];

  return (
    <div style={{ color: colors.text }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 10, top: 9, color: colors.textDim }}><IconSearch size={15} /></span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari SKU atau nama produk…"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {filters.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              style={{
                ...pillStyle,
                background: statusFilter === key ? colors.cardAlt : colors.card,
                color: statusFilter === key ? colors.text : colors.textDim,
                fontWeight: statusFilter === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <input ref={fileRef} type="file" accept=".xlsx" onChange={handleFile} style={{ display: 'none' }} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{ ...pillStyle, opacity: uploading ? 0.6 : 1 }}
          title="Impor stok dari Excel (kolom STOK AKHIR)"
        >
          <IconUpload size={15} />
          {uploading ? 'Mengimpor...' : 'Unggah Stok'}
        </button>
      </div>

      {error && <p style={{ color: colors.red, fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {message && (
        <p style={{ color: messageType === 'error' ? colors.red : messageType === 'info' ? colors.text : colors.green, fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
          {message}
        </p>
      )}

      <div style={{ ...card({ padding: 0 }), overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Memuat produk...</p>
        ) : items.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Belum ada produk. Hubungi admin utama untuk menyinkronkan produk dari Shopee.</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Tidak ada produk yang cocok dengan filter ini.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 640 }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 12px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${colors.border}` }}>
                <div />
                <div>SKU</div>
                <div>Produk</div>
                <div>Stok Shopee</div>
                <div>Stok Dashboard</div>
              </div>
              {rows.map((v) => (
                <div
                  key={`${v.sku}-${v.model_id}`}
                  style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}
                >
                  <VariantThumb image={v.image} />
                  <div style={{ fontFamily: 'ui-monospace, monospace', color: colors.blue }}>{v.sku}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {v.isBundle && (
                        <span title="Produk bundle" style={{ fontSize: 10, fontWeight: 600, color: colors.blue, background: 'rgba(59, 130, 246, 0.14)', padding: '2px 7px', borderRadius: 999, marginRight: 8 }}>BUNDLE</span>
                      )}
                      {v.productName}
                    </div>
                    {v.name && v.name !== v.productName && <div style={{ fontSize: 11.5, color: colors.textDim }}>{v.name}</div>}
                  </div>
                  <div style={{ fontFamily: 'var(--num)', color: colors.textDim }}>{v.shopeeStock ?? '—'}</div>
                  <div>
                    <StockInput sku={v.sku} value={v.dashboardStock} onSaved={(next) => handleStockSaved(v.sku, next)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div style={{ padding: '10px 16px', fontSize: 12.5, color: colors.textDim, textAlign: 'right' }}>{rows.length} SKU</div>
        )}
      </div>
    </div>
  );
}
