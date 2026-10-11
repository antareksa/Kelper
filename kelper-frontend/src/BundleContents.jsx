// What is inside a bundle, shown and edited in List Barang's expanded row
// (client-requested 2026-10-12; this replaces the old List Bundle page). The
// contents normally arrive with the Item Data upload; this is for correcting
// or completing them by hand. Saving replaces the whole list through
// PUT /bundles/:sku/items, which refuses a bundle inside a bundle, an unknown
// SKU, a duplicate or a quantity below 1.

import { useState } from 'react';
import { colors } from './theme';
import { IconEdit } from './Icons';
import { API_BASE, apiFetch } from './apiBase';

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

// product: a catalog entry with isBundle / bundleItems. singles: the products
// a bundle can be made of ({ sku, name }), already without bundles.
export default function BundleContents({ product, singles, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const items = product.bundleItems || [];
  const empty = items.length === 0;
  const nameOf = (sku) => singles.find((s) => s.sku === sku)?.name || items.find((i) => i.sku === sku)?.name || sku;
  const addable = singles.filter((s) => s.sku !== product.sku && !draft.some((d) => d.sku === s.sku));

  function startEdit() {
    setDraft(items.map((i) => ({ sku: i.sku, qty: i.qty })));
    setPick('');
    setError(null);
    setEditing(true);
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
      const res = await apiFetch(`${API_BASE}/bundles/${encodeURIComponent(product.sku)}/items`, {
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

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '10px 14px 12px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.text }}>Isi Bundle</span>
        <span style={{ fontSize: 12, color: empty ? colors.orange : colors.textDim }}>
          {empty ? 'Belum ada isi' : `${items.length} produk`}
        </span>
        {!editing && (
          <button onClick={startEdit} style={{ ...buttonStyle, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconEdit size={12} /> Ubah isi
          </button>
        )}
      </div>

      {!editing ? (
        empty ? (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: colors.textDim }}>
            Isi bundle ini belum diisi. Unggah Item Data, atau klik Ubah isi untuk menambahkannya.
          </p>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: ITEM_GRID, gap: 10, padding: '4px', fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              <div>SKU</div>
              <div>Nama Produk</div>
              <div>Barcode</div>
              <div>Jumlah</div>
            </div>
            {items.map((i) => (
              <div key={i.sku} style={{ display: 'grid', gridTemplateColumns: ITEM_GRID, gap: 10, padding: '4px', fontSize: 13 }}>
                <div style={{ fontFamily: 'var(--num)' }}>{i.sku}</div>
                <div>{i.name || '—'}</div>
                <div style={{ fontFamily: 'var(--num)', color: i.barcode ? colors.text : colors.red }}>{i.barcode || 'belum ada'}</div>
                <div style={{ fontFamily: 'var(--num)' }}>× {i.qty}</div>
              </div>
            ))}
          </div>
        )
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
  );
}
