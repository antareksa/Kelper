// Style/layout preview only — numbers below are sample data, not wired to
// anything real. Most of these metrics are blocked per the tech doc (HPP,
// ads access, visitor count aren't available yet) or simply not built yet.
// This exists to nail down the visual direction before wiring real data in.

import { colors, card } from './theme';

const KPI_CARDS = [
  { label: 'Omzet Hari Ini', value: 'Rp 17.285.894', trend: '-17.96% dari kemarin', trendType: 'down', accent: colors.red },
  { label: 'Laba Bersih Hari Ini', value: 'Rp 413.326', trend: '-33.75% dari kemarin', trendType: 'down', accent: colors.red },
  { label: 'Total Order', value: '271', trend: '-23.23% dari kemarin', trendType: 'down', accent: colors.red },
  { label: 'Pengunjung', value: '4.494', trend: '+46.77% dari kemarin', trendType: 'up', accent: colors.blue },
  { label: 'Persentase Profit', value: '5.01%', trend: '-0.99% dari kemarin', trendType: 'down', accent: colors.textDim },
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
  { label: 'Biaya per Pesanan', pct: '2%', value: 'Rp 340.000', color: '#3f3f4d' },
];

function KpiCard({ label, value, trend, trendType, accent }) {
  return (
    <div style={{ ...card(), borderLeft: `3px solid ${accent}`, flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 12, color: colors.textDim, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colors.text }}>{value}</div>
      <div style={{ fontSize: 12, marginTop: 4, color: trendType === 'up' ? colors.green : colors.red }}>
        {trendType === 'up' ? '▲' : '▼'} {trend}
      </div>
    </div>
  );
}

function ProfitFunnel() {
  return (
    <div style={card({ flex: 1 })}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Profit Funnel</div>
      <div style={{ display: 'flex', gap: 2 }}>
        {FUNNEL_STEPS.map((s) => (
          <div key={s.label} style={{ flex: 1, background: s.color, borderRadius: 4, padding: '10px 8px', color: '#fff' }}>
            <div style={{ fontSize: 11, opacity: 0.9 }}>{s.label}</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChartPlaceholder() {
  return (
    <div style={card({ flex: 1 })}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Omzet vs Laba Hari Ini</div>
      <svg viewBox="0 0 300 100" style={{ width: '100%', height: 100 }}>
        <polyline points="0,80 60,30 120,45 180,55 240,60 300,70" fill="none" stroke={colors.blue} strokeWidth="2" />
        <polyline points="0,90 60,75 120,80 180,82 240,85 300,88" fill="none" stroke={colors.green} strokeWidth="2" />
      </svg>
    </div>
  );
}

function ProductList() {
  return (
    <div style={card({ flex: 1 })}>
      <div style={{ fontWeight: 600, marginBottom: 12, color: colors.orange }}>▲ Produk Paling Menguntungkan</div>
      {PRODUCTS.map((p) => (
        <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
          <div>
            <div style={{ color: colors.text }}>{p.name}</div>
            <div style={{ color: colors.textDim, fontSize: 11 }}>{p.sku}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div>{p.price}</div>
            <div style={{ color: colors.green, fontSize: 11 }}>{p.change}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CostBreakdown() {
  return (
    <div style={card({ flex: 1 })}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Biaya Terbesar</div>
      {COSTS.map((c) => (
        <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: c.color, display: 'inline-block' }} />
          <span style={{ flex: 1, color: colors.textDim }}>{c.label} <span style={{ opacity: 0.6 }}>{c.pct}</span></span>
          <span style={{ color: colors.text }}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

function BocorList() {
  return (
    <div style={card({ flex: 1 })}>
      <div style={{ fontWeight: 600, marginBottom: 12, color: colors.red }}>● Bottom 5 Produk Bocor</div>
      <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>
        Tidak ada produk bocor — semua produk berada dalam kontrol baik.
      </div>
    </div>
  );
}

function MainDashboard() {
  return (
    <div style={{ background: colors.bg, color: colors.text, padding: 20, borderRadius: 8 }}>
      <div style={{ background: '#2a2410', border: `1px solid ${colors.orange}`, color: '#f0c674', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 16 }}>
        Style/layout preview only — sample numbers, not connected to real data yet.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Performa Hari Ini</div>
          <div style={{ fontSize: 12, color: colors.textDim }}>Kelper Official Store — last update 17:23</div>
        </div>
        <button style={{ background: colors.cardAlt, border: `1px solid ${colors.border}`, color: colors.text, padding: '6px 12px', borderRadius: 6 }}>
          ↻ Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {KPI_CARDS.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProfitFunnel />
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
