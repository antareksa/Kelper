// Stock Opname (client-requested 2026-10-16), a List Barang submenu: per SKU
// over a date range, Stok Awal + Masuk - Keluar = Stok Akhir. Read-only; the
// numbers come from the stock log (see the backend's stockLog.js and
// products.js /stock-opname). Recording began at deploy; for a range that
// reaches back before it, the backend assumes nothing came in then and flags
// the figures as an estimate.

import { useEffect, useMemo, useState } from 'react';
import { colors, card } from './theme';
import { IconSearch } from './Icons';
import { API_BASE, apiFetch } from './apiBase';

const GRID = 'minmax(110px,1fr) minmax(220px,3fr) 100px 100px 100px 100px';

function wibDateString(daysAgo) {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  wib.setUTCDate(wib.getUTCDate() - daysAgo);
  return wib.toISOString().slice(0, 10);
}

function formatDateDDMMYYYY(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatTimestamp(ts) {
  const wib = new Date(ts * 1000 + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(wib.getUTCDate())}/${pad(wib.getUTCMonth() + 1)}/${wib.getUTCFullYear()} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}`;
}

const num = (v) => (v == null ? '—' : v.toLocaleString('id-ID'));

const buttonStyle = {
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

function StockOpname() {
  const today = wibDateString(0);
  // Both ends yesterday by default: the latest complete day.
  const [startDate, setStartDate] = useState(wibDateString(1));
  const [endDate, setEndDate] = useState(wibDateString(1));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [movedOnly, setMovedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`${API_BASE}/products/stock-opname?start=${startDate}&end=${endDate}`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const body = await res.json();
        if (!cancelled) setData(body);
      })
      .catch(() => { if (!cancelled) setError('Gagal memuat data stock opname.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) =>
      (!movedOnly || r.keluar > 0 || r.masuk > 0) &&
      (!q || r.sku.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)));
  }, [data, search, movedOnly]);

  const totals = useMemo(() => ({
    masuk: rows.reduce((t, r) => t + r.masuk, 0),
    keluar: rows.reduce((t, r) => t + r.keluar, 0),
  }), [rows]);
  const est = data?.estimate ? '≈ ' : ''; // figures that assume no stock came in before recording began

  // Downloads the always-current stock template (client-requested 2026-10-17):
  // every SKU in the Shopee catalog cache, SKU | Name | Stock -- Stock blank
  // to fill in and re-upload via List Barang's Item Stok importer
  // (/products/import-stock). Built live on each request (see
  // /products/stock-template), so a SKU the catalog sync just added shows up
  // the next time this is clicked, with nothing to maintain by hand.
  async function handleDownloadTemplate() {
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/products/stock-template`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Gagal mengunduh template');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'item-stok-template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)', marginBottom: 4 }}>Stock Opname</div>
      <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 16 }}>
        Stok Awal + Masuk − Keluar = Stok Akhir, per item. Keluar = terjual (scan pickup) dan pengurangan manual;
        Masuk = unggah Item Stok dan penambahan manual.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="date"
          aria-label="Tanggal Mulai"
          value={startDate}
          max={today}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            setStartDate(v);
            if (v > endDate) setEndDate(v);
          }}
          style={inputStyle}
        />
        <span style={{ color: colors.textDim, fontSize: 13 }}>s/d</span>
        <input
          type="date"
          aria-label="Tanggal Selesai"
          value={endDate}
          max={today}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            setEndDate(v);
            if (v < startDate) setStartDate(v);
          }}
          style={inputStyle}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
          <span style={{ position: 'absolute', left: 10, top: 9, color: colors.textDim }}><IconSearch size={15} /></span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari SKU atau nama produk…"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32 }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: colors.textDim, cursor: 'pointer' }}>
          <input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
          Hanya yang bergerak
        </label>
        <button
          onClick={handleDownloadTemplate}
          style={buttonStyle}
          title="Unduh template Item Stok (semua SKU terbaru, kolom Stock kosong untuk diisi lalu diunggah di List Barang)"
        >
          Unduh Template Stok
        </button>
      </div>

      {data?.estimate && data.logStartedAt && (
        <p style={{ fontSize: 12.5, color: colors.orange, margin: '0 0 12px', lineHeight: 1.5 }}>
          Estimasi (≈): pencatatan stok masuk dimulai {formatTimestamp(data.logStartedAt)}. Untuk waktu sebelum itu,
          stok masuk dianggap 0 (unggah Item Stok atau ubah manual saat itu tidak tercatat); Keluar dihitung dari penjualan.
          Angka tepat bila saat itu tidak ada stok masuk.
        </p>
      )}
      {error && <p style={{ color: colors.red, fontSize: 13, marginBottom: 12 }}>{error}</p>}

      <div style={{ ...card({ padding: 0 }), overflow: 'hidden' }}>
        {loading && !data ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Memuat...</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Tidak ada item untuk periode / filter ini.</p>
        ) : (
          <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
            <div style={{ minWidth: 720 }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 12px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${colors.border}` }}>
                <div>SKU</div>
                <div>Produk</div>
                <div style={{ textAlign: 'right' }}>Stok Awal</div>
                <div style={{ textAlign: 'right' }}>Masuk</div>
                <div style={{ textAlign: 'right' }}>Keluar</div>
                <div style={{ textAlign: 'right' }}>Stok Akhir</div>
              </div>
              {rows.map((r) => (
                <div key={r.sku} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
                  <div style={{ fontFamily: 'ui-monospace, monospace', color: colors.blue }}>{r.sku}</div>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name || '—'}</div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--num)', color: colors.textDim }}>{r.awal == null ? '—' : est + num(r.awal)}</div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--num)', color: r.masuk > 0 ? colors.green : colors.textDim }}>
                    {est}{r.masuk > 0 ? `+${num(r.masuk)}` : num(r.masuk)}
                  </div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--num)', color: r.keluar > 0 ? colors.red : colors.textDim }}>
                    {r.keluar > 0 ? `−${num(r.keluar)}` : '0'}
                  </div>
                  <div style={{ textAlign: 'right', fontFamily: 'var(--num)', fontWeight: 600 }}>{r.akhir == null ? '—' : est + num(r.akhir)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: 12.5, color: colors.textDim, flexWrap: 'wrap', gap: 8 }}>
            <span>
              {data.start === data.end ? formatDateDDMMYYYY(data.start) : `${formatDateDDMMYYYY(data.start)} - ${formatDateDDMMYYYY(data.end)}`}
              {' · '}{rows.length} SKU
            </span>
            <span style={{ fontFamily: 'var(--num)' }}>
              Total masuk {est}+{num(totals.masuk)} · Total keluar −{num(totals.keluar)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default StockOpname;
