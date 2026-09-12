// Style/layout preview only — mock product data, not wired to the Shopee
// Product API yet. Built to check the expand-row interaction works before
// wiring up real SKU/variant data.

import { useState } from 'react';
import { colors, card } from './theme';
import { IconSearch, IconRefresh, IconEdit, IconStore, IconHistory, IconChevronDown } from './Icons';
import { useShopName } from './useShopName';

const SUMMARY = [
  { label: 'Total SKU', value: '49' },
  { label: 'SKU Kosong', value: '18', accent: colors.red },
  { label: 'Fee Layanan', value: '26.85%' },
  { label: 'Rata-rata Margin', value: '21.98%', accent: colors.green },
  { label: 'Omset Bulan Ini', value: 'Rp 312.485.000' },
  { label: 'Omset Bulan Lalu', value: 'Rp 289.940.500' },
];

const PRODUCTS = [
  { sku: 'ADDITION-01', name: 'Extra Bubble Wrap Untuk Tambahan Prot...', variants: 1, soldOut: false, trend: 0, minBeli: 1, profitPct: -136, omsetIni: 'Rp 1.240.000', omsetLalu: 'Rp 1.480.000' },
  { sku: 'KEL-01', name: 'Kelper Spin Mop Lantai Stainless Steel Pel Putar P...', variants: 1, soldOut: false, trend: 192, minBeli: 1, profitPct: 23, omsetIni: 'Rp 65.641.255', omsetLalu: 'Rp 53.284.224' },
  { sku: 'KEL-02', name: 'Kelper Spray Mop Alat Pel Semprot Microfiber Se...', variants: 1, soldOut: false, trend: 0, minBeli: 1, profitPct: 25, omsetIni: 'Rp 18.320.000', omsetLalu: 'Rp 17.905.000' },
  { sku: 'KEL-03', name: 'Kelper Sapu Pengki Tekuk Estetik Sweep B...', variants: 1, soldOut: true, trend: 0, minBeli: 1, profitPct: 25, omsetIni: 'Rp 0', omsetLalu: 'Rp 6.120.000' },
  { sku: 'KEL-04', name: 'Kelper Spin Mop Deluxe Pel Putar Spin Mop...', variants: 1, soldOut: true, trend: 0, minBeli: 1, profitPct: 30, omsetIni: 'Rp 0', omsetLalu: 'Rp 9.870.000' },
  { sku: 'KEL-05', name: 'Kelper Flat Mop Lantai Microfiber Pel Segi', variants: 1, soldOut: true, trend: 0, minBeli: 1, profitPct: 36, omsetIni: 'Rp 0', omsetLalu: 'Rp 4.550.000' },
  { sku: 'KEL-06', name: 'Kelper - Spin Mop Handle Alat Pel Tongkat Pel Tan...', variants: 1, soldOut: false, trend: 0, minBeli: 1, profitPct: 28, omsetIni: 'Rp 12.680.000', omsetLalu: 'Rp 11.230.000' },
  { sku: 'KEL-07', name: 'Kelper Refill Spin Mop Pel Putar', variants: 1, soldOut: false, trend: 0, minBeli: 1, profitPct: 34, omsetIni: 'Rp 22.410.000', omsetLalu: 'Rp 19.860.000' },
  { sku: 'KEL-08', name: 'Kelper 4 in 1 Sapu Pengki Sikat Slaber Pake...', variants: 1, soldOut: false, trend: 0, minBeli: 1, profitPct: 27, omsetIni: 'Rp 9.150.000', omsetLalu: 'Rp 8.400.000' },
  { sku: 'KEL-09', name: 'Kelper X Mop Super Praktis Alat Pel', variants: 1, soldOut: true, trend: 0, minBeli: 1, profitPct: 23, omsetIni: 'Rp 0', omsetLalu: 'Rp 5.640.000' },
];

const VARIANT_DEMO = {
  sku: 'KEL-01',
  stok: 28,
  hpp: 'Rp 100.783',
  harga: 'Rp 208.829',
  hargaSistem: 'Rp 208.829 (0%)', // Shopee's live listed price
  estProfit: 'Rp 48.324',
  estProfitPct: '23%',
  qtyIni: 324,
  qtyLalu: 265,
  omsetIni: 'Rp 65.641.255',
  omsetLalu: 'Rp 53.284.224',
};

const TABLE_GRID = '32px minmax(220px,2fr) 90px 100px 90px 100px 90px 130px 130px 44px';
const SUB_GRID = '110px 1fr 60px 110px 150px 100px 90px 80px 80px 120px 120px 90px';

function Toggle({ on, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        border: 'none',
        background: on ? colors.green : colors.cardAlt,
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
        }}
      />
    </button>
  );
}

function SummaryCard({ label, value, accent }) {
  return (
    <div style={{ ...card(), flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent || colors.text, fontFamily: 'var(--num)' }}>{value}</div>
    </div>
  );
}

function TrendBadge({ value }) {
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

function ProductRow({ product, expanded, onToggle }) {
  const [manual, setManual] = useState(false);
  const initials = product.sku.slice(0, 2);

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
          <div style={{ width: 36, height: 36, borderRadius: 8, background: colors.cardAlt, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: colors.textDim }}>
            {initials}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {product.name}
            </div>
            <div style={{ fontSize: 11, color: colors.textDim }}>{product.variants} varian</div>
          </div>
        </div>

        <div>
          {product.soldOut && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: colors.red, background: colors.redDim, padding: '3px 8px', borderRadius: 999 }}>
              ● SOLD OUT
            </span>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: colors.blue, fontFamily: 'ui-monospace, monospace' }}>{product.sku}</div>

        <TrendBadge value={product.trend} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: colors.text, fontFamily: 'var(--num)' }}>
          {product.minBeli}
          <IconEdit size={11} />
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 600, color: product.profitPct < 0 ? colors.red : colors.green, fontFamily: 'var(--num)' }}>
          {product.profitPct}%
        </div>

        <div style={{ fontSize: 12.5, color: colors.text, fontFamily: 'var(--num)' }}>{product.omsetIni}</div>
        <div style={{ fontSize: 12.5, color: colors.text, fontFamily: 'var(--num)' }}>{product.omsetLalu}</div>

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
                <div>Harga</div>
                <div>Est Profit</div>
                <div>Est % Profit</div>
                <div>Qty Ini</div>
                <div>Qty Lalu</div>
                <div>Omset Ini</div>
                <div>Omset Lalu</div>
                <div>Aksi</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: SUB_GRID, gap: 10, alignItems: 'center', padding: '10px 10px', background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10, fontSize: 12.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: colors.cardAlt, flexShrink: 0 }} />
                  <span style={{ color: colors.text }}>{VARIANT_DEMO.sku}</span>
                </div>
                <div style={{ color: colors.text }}>{VARIANT_DEMO.sku}</div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.stok}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: colors.text, fontFamily: 'var(--num)' }}>
                  {VARIANT_DEMO.hpp} <IconEdit size={11} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: colors.text, fontFamily: 'var(--num)' }}>
                    {VARIANT_DEMO.harga} <IconEdit size={11} />
                  </div>
                  <div style={{ fontSize: 10.5, color: colors.textFaint }}>
                    Sistem: <span style={{ fontFamily: 'var(--num)' }}>{VARIANT_DEMO.hargaSistem}</span>
                  </div>
                </div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.estProfit}</div>
                <div style={{ color: colors.green, fontWeight: 600, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.estProfitPct}</div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.qtyIni}</div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.qtyLalu}</div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.omsetIni}</div>
                <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{VARIANT_DEMO.omsetLalu}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: colors.textDim }}>Manual</span>
                  <Toggle on={manual} onToggle={() => setManual((v) => !v)} />
                </div>
              </div>
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
  const [page, setPage] = useState(1);
  const shopName = useShopName();

  return (
    <div style={{ color: colors.text }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button style={{ ...pillStyle, gap: 8 }}>
          <IconStore size={15} />
          {shopName || 'Toko belum terhubung'}
          <IconChevronDown size={11} />
        </button>

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

        <button style={{ ...pillStyle, width: 34, justifyContent: 'center', padding: 0 }}>
          <IconRefresh size={15} />
        </button>

        <button style={{ ...pillStyle, gap: 8, background: colors.blue + '22', color: colors.blue, borderColor: 'transparent' }}>
          FEE SETTING <strong style={{ fontFamily: 'var(--num)' }}>28%</strong>
          <IconEdit size={11} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {SUMMARY.map((s) => <SummaryCard key={s.label} {...s} />)}
      </div>

      <div style={{ ...card({ padding: 0 }), overflow: 'hidden' }}>
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

            {PRODUCTS.map((p) => (
              <ProductRow
                key={p.sku}
                product={p}
                expanded={expandedSku === p.sku}
                onToggle={() => setExpandedSku(expandedSku === p.sku ? null : p.sku)}
              />
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, padding: '12px 16px', fontSize: 12.5, color: colors.textDim }}>
          <span>Showing 1 – 10 of 49</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Rows
            <select style={{ background: colors.cardAlt, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '4px 6px', fontFamily: 'var(--num)' }}>
              <option>10</option>
              <option>25</option>
              <option>50</option>
            </select>
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            <PageBtn label="«" />
            <PageBtn label="‹" />
            {[1, 2, 3, 4, 5].map((n) => (
              <PageBtn key={n} label={n} active={page === n} onClick={() => setPage(n)} />
            ))}
            <PageBtn label="›" />
            <PageBtn label="»" />
          </span>
        </div>
      </div>
    </div>
  );
}

function PageBtn({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        minWidth: 26,
        height: 26,
        borderRadius: 6,
        border: `1px solid ${active ? colors.blue : colors.border}`,
        background: active ? colors.blue : 'transparent',
        color: active ? '#fff' : colors.textDim,
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'var(--num)',
      }}
    >
      {label}
    </button>
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
