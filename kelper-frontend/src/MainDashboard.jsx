// Style/layout preview only — numbers below are sample data, not wired to
// anything real. Most of these metrics are blocked per the tech doc (HPP,
// ads access, visitor count aren't available yet) or simply not built yet.
// This exists to nail down the visual direction before wiring real data in.

import { colors, card } from './theme';
import { Sparkline } from './Sparkline';
import { IconArrowUpRight } from './Icons';
import { useShopName } from './useShopName';

const KPI_CARDS = [
  { label: 'Omzet Hari Ini', value: 'Rp 17.285.894', trendPct: '-17.96%', trendType: 'down', spark: [22, 19, 17, 18, 15, 13, 12] },
  { label: 'Laba Bersih Hari Ini', value: 'Rp 413.326', trendPct: '-33.75%', trendType: 'down', spark: [9, 8.6, 8, 7.2, 6.5, 5.8, 5.3] },
  { label: 'Total Order', value: '271', trendPct: '-23.23%', trendType: 'down', spark: [340, 320, 300, 295, 280, 275, 271] },
  { label: 'Pengunjung', value: '4.494', trendPct: '+46.77%', trendType: 'up', spark: [2800, 3100, 3400, 3600, 3900, 4200, 4494] },
  { label: 'Persentase Profit', value: '5.01%', trendPct: '-0.99%', trendType: 'down', spark: [6.1, 5.9, 5.7, 5.6, 5.4, 5.2, 5.01] },
];

const FUNNEL_STEPS = [
  { label: 'Margin', value: 'Rp 9.497.997', color: colors.green },
  { label: 'Iklan', value: 'Rp 3.670.892', color: colors.blue },
  { label: 'Layanan', value: 'Rp 4.622.423', color: colors.blue },
  { label: 'Biaya Pesanan', value: 'Rp 338.750', color: colors.orange },
  { label: 'Affiliasi', value: 'Rp 452.606', color: colors.orange },
];

const PRODUCTS = [
  { name: 'Kelper Sikat Lantai 2 in 1 Gagang Panjang', sku: 'KEL-37', price: 'Rp 339.887', change: '+41%' },
  { name: 'Kelper Twist Mop Pel Putar Microfiber', sku: 'KEL-43', price: 'Rp 172.586', change: '+37%' },
  { name: 'Kelper Pembersih Kaca Jendela Teleskopik', sku: 'KEL-40', price: 'Rp 177.080', change: '+30%' },
  { name: 'KELPER 4 in 1 Sapu Pengki Sikat Slaber', sku: 'KEL-08', price: 'Rp 54.547', change: '+27%' },
];

const COSTS = [
  { label: 'Iklan', pct: '18.9%', value: 'Rp 3.670.892', color: colors.blue },
  { label: 'Layanan', pct: '26.7%', value: 'Rp 4.638.863', color: colors.orange },
  { label: 'Affiliasi', pct: '2.6%', value: 'Rp 452.606', color: colors.green },
  { label: 'Biaya per Pesanan', pct: '2%', value: 'Rp 340.000', color: colors.textFaint },
];

function CardHeader({ label }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: colors.textDim }}>{label}</div>
      <IconArrowUpRight size={13} color={colors.textFaint} />
    </div>
  );
}

function KpiCard({ label, value, trendPct, trendType, spark }) {
  const sparkColor = trendType === 'up' ? colors.green : colors.red;
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
      <CardHeader label={label} />
      <div style={{ fontSize: 24, fontWeight: 700, color: colors.text, letterSpacing: -0.5, fontFamily: 'var(--num)' }}>{value}</div>
      <div style={{ fontSize: 12, marginTop: 4, marginBottom: 12, color: trendType === 'up' ? colors.green : colors.red }}>
        {trendType === 'up' ? '▲' : '▼'} <span style={{ fontFamily: 'var(--num)' }}>{trendPct}</span> dari kemarin
      </div>
      <Sparkline data={spark} color={sparkColor} height={30} />
    </div>
  );
}

function ProfitFunnel() {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Profit Funnel" />
      <div style={{ display: 'flex', gap: 8 }}>
        {FUNNEL_STEPS.map((s) => (
          <div
            key={s.label}
            style={{
              flex: 1,
              aspectRatio: '2 / 1',
              background: s.color,
              borderRadius: 10,
              padding: '14px 14px',
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ fontSize: 14, opacity: 0.9 }}>{s.label}</div>
            <div style={{ fontSize: 19, fontWeight: 700, fontFamily: 'var(--num)' }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChartPlaceholder() {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Omzet vs Laba Hari Ini" />
      <div style={{ position: 'relative' }}>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" style={{ width: '100%', height: 140, display: 'block' }}>
          <line x1="0" y1="92" x2="300" y2="92" stroke={colors.border} strokeWidth="1" strokeDasharray="2 4" />
          <polyline points="0,80 60,30 120,45 180,55 240,60 300,70" fill="none" stroke={colors.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="0,90 60,75 120,80 180,82 240,85 300,88" fill="none" stroke={colors.green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {/* plain circular dots — the svg above is stretched non-uniformly (preserveAspectRatio="none"), which would turn <circle> into an ellipse */}
        <span style={{ position: 'absolute', left: '100%', top: '70%', transform: 'translate(-50%, -50%)', width: 7, height: 7, borderRadius: '50%', background: colors.blue }} />
        <span style={{ position: 'absolute', left: '100%', top: '88%', transform: 'translate(-50%, -50%)', width: 7, height: 7, borderRadius: '50%', background: colors.green }} />
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: colors.textDim, marginTop: 4 }}>
        <span><span style={{ color: colors.blue }}>●</span> Omzet</span>
        <span><span style={{ color: colors.green }}>●</span> Laba</span>
      </div>
    </div>
  );
}

function ProductList() {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Produk Paling Menguntungkan" />
      {PRODUCTS.map((p) => (
        <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
          <div>
            <div style={{ color: colors.text }}>{p.name}</div>
            <div style={{ color: colors.textDim, fontSize: 11 }}>{p.sku}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{p.price}</div>
            <div style={{ color: colors.green, fontSize: 11, fontFamily: 'var(--num)' }}>{p.change}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CostBreakdown() {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Biaya Terbesar" />
      {COSTS.map((c) => (
        <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: c.color, display: 'inline-block' }} />
          <span style={{ flex: 1, color: colors.textDim }}>{c.label} <span style={{ opacity: 0.6, fontFamily: 'var(--num)' }}>{c.pct}</span></span>
          <span style={{ color: colors.text, fontFamily: 'var(--num)' }}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

function BocorList() {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Bottom 5 Produk Bocor" />
      <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>
        Tidak ada produk bocor — semua produk berada dalam kontrol baik.
      </div>
    </div>
  );
}

function MainDashboard() {
  const shopName = useShopName();

  return (
    <div style={{ color: colors.text }}>
      <div style={{ background: colors.orangeDim, border: `1px solid ${colors.orange}`, color: '#f0c674', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginBottom: 16 }}>
        Style/layout preview only — sample numbers, not connected to real data yet.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)' }}>Performa Hari Ini</div>
          <div style={{ fontSize: 12, color: colors.textDim }}>{shopName || 'Toko belum terhubung'} — last update 17:23</div>
        </div>
        <button
          style={{
            background: colors.cardAlt,
            border: `1px solid ${colors.border}`,
            color: colors.text,
            padding: '6px 12px',
            borderRadius: 8,
            fontFamily: 'var(--sans)',
            cursor: 'pointer',
          }}
        >
          ↻ Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        {KPI_CARDS.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProfitFunnel />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <LineChartPlaceholder />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProductList />
        <CostBreakdown />
      </div>

      <BocorList />
    </div>
  );
}

export default MainDashboard;
