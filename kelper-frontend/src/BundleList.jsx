// Bundle menu (client-requested 2026-10-03): every bundle listing with its
// name and SKU, and the single products inside it. The items are filled from
// the barcode sheet (List Barang's "Unggah Barcode") and can be corrected or
// completed here -- bundles the sheet doesn't cover start empty.

import { useEffect, useMemo, useState } from 'react';
import { colors, card } from './theme';
import { IconSearch, IconChevronDown, IconEdit } from './Icons';
import { API_BASE, apiFetch } from './apiBase';

const ROW_GRID = '28px minmax(240px,2fr) 150px 110px 90px';
const ITEM_GRID = '130px minmax(200px,2fr) 150px 80px';

const inputStyle = {
  height: 30,
  borderRadius: 6,
  border: `1px solid ${colors.border}`,
  background: colors.bg,
  color: colors.text,
  fontSize: 13,
  padding: '0 8px',
  fontFamily: 'var(--sans)',
  boxSizing: 'border-box',
};

const buttonStyle = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: `1px solid ${colors.border}`,
  background: colors.card,
  color: colors.text,
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'var(--sans)',
};

function BundleRow({ bundle, singles, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const empty = bundle.items.length === 0;

  function startEdit() {
    setDraft(bundle.items.map((i) => ({ sku: i.sku, qty: i.qty })));
    setPick('');
    setError(null);
    setEditing(true);
    setExpanded(true);
  }

  function addComponent() {
    if (!pick || draft.some((d) => d.sku === pick)) return;
    setDraft([...draft, { sku: pick, qty: 1 }]);
    setPick('');
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`${API_BASE}/bundles/${encodeURIComponent(bundle.sku)}/items`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error);
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const nameOf = (sku) => singles.find((s) => s.sku === sku)?.name || sku;
  const addable = singles.filter((s) => !draft.some((d) => d.sku === s.sku));

  return (
    <div style={{ borderBottom: `1px solid ${colors.border}` }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'grid', gridTemplateColumns: ROW_GRID, gap: 10, padding: '12px', alignItems: 'center', cursor: 'pointer', fontSize: 13.5 }}
      >
        <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none', color: colors.textDim }}>
          <IconChevronDown size={12} />
        </span>
        <div style={{ fontWeight: 600 }}>{bundle.name}</div>
        <div style={{ fontFamily: 'var(--num)', color: colors.textDim }}>{bundle.sku}</div>
        <div style={{ color: empty ? colors.orange : colors.text }}>
          {empty ? 'Belum ada isi' : `${bundle.items.length} produk`}
        </div>
        <div style={{ fontFamily: 'var(--num)', color: colors.textDim }}>
          {bundle.stock == null ? '—' : `Stok ${bundle.stock}`}
        </div>
      </div>

      {expanded && (
        <div style={{ background: colors.bg, padding: '8px 12px 14px 50px' }}>
          {!editing ? (
            <>
              {empty ? (
                <p style={{ margin: '6px 0 10px', fontSize: 13, color: colors.textDim }}>
                  Isi bundle ini belum diisi (tidak ada di file barcode). Klik Ubah isi untuk menambahkannya.
                </p>
              ) : (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: ITEM_GRID, gap: 10, padding: '6px 4px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    <div>SKU</div>
                    <div>Nama Produk</div>
                    <div>Barcode</div>
                    <div>Jumlah</div>
                  </div>
                  {bundle.items.map((i) => (
                    <div key={i.sku} style={{ display: 'grid', gridTemplateColumns: ITEM_GRID, gap: 10, padding: '6px 4px', fontSize: 13 }}>
                      <div style={{ fontFamily: 'var(--num)' }}>{i.sku}</div>
                      <div>{i.name || '—'}</div>
                      <div style={{ fontFamily: 'var(--num)', color: i.barcode ? colors.text : colors.red }}>{i.barcode || 'belum ada'}</div>
                      <div style={{ fontFamily: 'var(--num)' }}>× {i.qty}</div>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={startEdit} style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <IconEdit size={12} /> Ubah isi
              </button>
            </>
          ) : (
            <>
              {draft.map((d) => (
                <div key={d.sku} style={{ display: 'grid', gridTemplateColumns: `${ITEM_GRID} 80px`, gap: 10, padding: '4px', alignItems: 'center', fontSize: 13 }}>
                  <div style={{ fontFamily: 'var(--num)' }}>{d.sku}</div>
                  <div>{nameOf(d.sku)}</div>
                  <div />
                  <input
                    type="number"
                    min={1}
                    value={d.qty}
                    onChange={(e) => setDraft(draft.map((x) => (x.sku === d.sku ? { ...x, qty: Number(e.target.value) } : x)))}
                    style={{ ...inputStyle, width: 70 }}
                  />
                  <button onClick={() => setDraft(draft.filter((x) => x.sku !== d.sku))} style={{ ...buttonStyle, color: colors.red }}>
                    Hapus
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...inputStyle, minWidth: 280, maxWidth: '100%' }}>
                  <option value="">Pilih produk untuk ditambahkan…</option>
                  {addable.map((s) => (
                    <option key={s.sku} value={s.sku}>{s.sku} — {s.name}</option>
                  ))}
                </select>
                <button onClick={addComponent} disabled={!pick} style={{ ...buttonStyle, opacity: pick ? 1 : 0.5 }}>Tambah</button>
              </div>
              {error && <p style={{ color: colors.red, fontSize: 13, margin: '6px 0' }}>{error}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={save} disabled={saving} style={{ ...buttonStyle, background: colors.green, color: '#000', border: 'none', fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Menyimpan…' : 'Simpan'}
                </button>
                <button onClick={() => setEditing(false)} disabled={saving} style={buttonStyle}>Batal</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function BundleList() {
  const [data, setData] = useState({ bundles: [], singles: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/bundles`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error);
      setData(body);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.bundles;
    return data.bundles.filter(
      (b) => b.name.toLowerCase().includes(q) || b.sku.toLowerCase().includes(q) || b.items.some((i) => i.sku.toLowerCase().includes(q) || (i.name || '').toLowerCase().includes(q)),
    );
  }, [data.bundles, search]);

  const emptyCount = data.bundles.filter((b) => b.items.length === 0).length;

  return (
    <div style={{ color: colors.text }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 360 }}>
          <span style={{ position: 'absolute', left: 10, top: 9, color: colors.textDim }}><IconSearch size={15} /></span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari bundle, SKU, atau isi…"
            style={{ ...inputStyle, width: '100%', height: 34, paddingLeft: 32 }}
          />
        </div>
        <span style={{ fontSize: 13, color: colors.textDim }}>
          {data.bundles.length} bundle{emptyCount > 0 ? ` · ${emptyCount} belum ada isi` : ''}
        </span>
      </div>

      {error && <p style={{ color: colors.red, fontSize: 13, marginBottom: 12 }}>{error}</p>}

      <div style={{ ...card({ padding: 0 }), overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Memuat bundle...</p>
        ) : data.bundles.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>
            Belum ada bundle. Sync produk di List Barang dulu; bundle adalah produk dengan SKU berawalan KELPER.
          </p>
        ) : filtered.length === 0 ? (
          <p style={{ padding: 20, color: colors.textDim, margin: 0 }}>Tidak ada bundle yang cocok.</p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: ROW_GRID, gap: 10, padding: '10px 12px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${colors.border}` }}>
              <div />
              <div>Nama Bundle</div>
              <div>SKU</div>
              <div>Isi</div>
              <div />
            </div>
            {filtered.map((b) => (
              <BundleRow key={b.sku} bundle={b} singles={data.singles} onSaved={load} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
