import { useState } from 'react';
import { colors, card } from './theme';
import {
  formatRupiah,
  CardHeader,
  KpiCard,
  ProfitFunnel,
  ProductList,
  CostBreakdown,
  StockList,
  BocorList,
  PriceDiffList,
} from './MainDashboard';

// STAGING PREVIEW (2026-11-04): the Main / Shopee / TikTok Dashboard layout,
// filled with made-up numbers so the layout can be checked before the real
// data exists. Nothing here comes from the backend or from any real shop.
// Only reachable on staging hostnames (see Dashboard.jsx's IS_STAGING).
//
// Main is always computed from the two marketplace blocks below, the same way
// the real one must be: amounts are added, percentages are recomputed from the
// totals (never added or averaged).

const TEMP = {
  shopee: {
    orderCount: 412,
    omzet: 48650000,
    laba: 14120000,
    layanan: 1946000,
    biayaPesanan: 5352000,
    iklan: 2430000,
    affiliasi: 864000,
    pageViews: 8430,
    prev: { orderCount: 389, omzet: 45210000, laba: 13050000 },
    series: {
      orderCount: [352, 371, 398, 365, 402, 389, 412],
      omzet: [41200000, 43400000, 46900000, 42800000, 47300000, 45210000, 48650000],
      laba: [11800000, 12500000, 13600000, 12200000, 13800000, 13050000, 14120000],
    },
    topProducts: [
      { sku: 'CONTOH-001', name: 'Produk Contoh A', qty: 96, revenue: 11520000, profit: 3840000 },
      { sku: 'CONTOH-002', name: 'Produk Contoh B', qty: 74, revenue: 8880000, profit: 2590000 },
      { sku: 'CONTOH-003', name: 'Produk Contoh C', qty: 58, revenue: 6090000, profit: 1740000 },
      { sku: 'CONTOH-004', name: 'Produk Contoh D', qty: 41, revenue: 4510000, profit: null },
    ],
    leaking: [{ platform: 'shopee', sku: 'CONTOH-007', name: 'Produk Contoh G', price: 42000, hpp: 45500 }],
    priceDiffs: [
      { platform: 'shopee', sku: 'CONTOH-002', name: 'Produk Contoh B', snapshotPrice: 115000, currentPrice: 120000, priceDiff: 5000, snapshotHpp: null, currentHpp: null, hppDiff: null },
    ],
    feeDetailTitle: 'Rincian Biaya Shopee',
    feeDetail: [
      { label: 'Biaya Administrasi', value: 3160000 },
      { label: 'Gratis Ongkir XTRA', value: 1420000 },
      { label: 'Biaya Proses Pesanan', value: 412000 },
      { label: 'PPh 22', value: 360000 },
      { label: 'Promo XTRA (Layanan)', value: 1946000 },
    ],
  },
  tiktok: {
    orderCount: 187,
    omzet: 19320000,
    laba: 5410000,
    layanan: 483000,
    biayaPesanan: 2318000,
    iklan: null, // not in the TikTok Shop API, see docs/FEATURE-tiktok-integration.md
    affiliasi: 1159000,
    pageViews: 3120,
    prev: { orderCount: 171, omzet: 17640000, laba: 4930000 },
    series: {
      orderCount: [128, 142, 165, 149, 176, 171, 187],
      omzet: [13200000, 14700000, 17100000, 15300000, 18200000, 17640000, 19320000],
      laba: [3700000, 4100000, 4800000, 4300000, 5100000, 4930000, 5410000],
    },
    topProducts: [
      { sku: 'CONTOH-002', name: 'Produk Contoh B', qty: 52, revenue: 6240000, profit: 1820000 },
      { sku: 'CONTOH-005', name: 'Produk Contoh E', qty: 38, revenue: 3610000, profit: 1140000 },
      { sku: 'CONTOH-001', name: 'Produk Contoh A', qty: 21, revenue: 2520000, profit: 840000 },
      { sku: 'CONTOH-006', name: 'Produk Contoh F', qty: 17, revenue: 1530000, profit: 410000 },
    ],
    leaking: [{ platform: 'tiktok', sku: 'CONTOH-008', name: 'Produk Contoh H', price: 38000, hpp: 39000 }],
    priceDiffs: [
      { platform: 'tiktok', sku: 'CONTOH-005', name: 'Produk Contoh E', snapshotPrice: null, currentPrice: null, priceDiff: null, snapshotHpp: 62000, currentHpp: 65000, hppDiff: 3000 },
    ],
    feeDetailTitle: 'Rincian Biaya TikTok',
    feeDetail: [
      { label: 'Komisi Platform', value: 1352000 },
      { label: 'Biaya Transaksi', value: 580000 },
      { label: 'Seller Free Shipping', value: 386000 },
      { label: 'Voucher Xtra (Layanan)', value: 483000 },
    ],
    gmvSources: [
      { label: 'Video', value: 8110000 },
      { label: 'LIVE', value: 6760000 },
      { label: 'Kartu Produk', value: 4450000 },
    ],
    gmvMax: [
      { label: 'Non-GMV Max', value: 14700000 },
      { label: 'GMV Max', value: 4620000 },
    ],
  },
};

const STOCK = {
  most: [
    { sku: 'CONTOH-003', name: 'Produk Contoh C', stock: 840 },
    { sku: 'CONTOH-001', name: 'Produk Contoh A', stock: 615 },
    { sku: 'CONTOH-005', name: 'Produk Contoh E', stock: 402 },
    { sku: 'CONTOH-002', name: 'Produk Contoh B', stock: 288 },
    { sku: 'CONTOH-006', name: 'Produk Contoh F', stock: 176 },
  ],
  least: [
    { sku: 'CONTOH-008', name: 'Produk Contoh H', stock: 3 },
    { sku: 'CONTOH-007', name: 'Produk Contoh G', stock: 9 },
    { sku: 'CONTOH-004', name: 'Produk Contoh D', stock: 14 },
    { sku: 'CONTOH-009', name: 'Produk Contoh I', stock: 22 },
    { sku: 'CONTOH-010', name: 'Produk Contoh J', stock: 31 },
  ],
};

const addArrays = (a, b) => a.map((v, i) => v + b[i]);

// Adds per SKU, the way a combined product list has to work.
function mergeProducts(a, b) {
  const bySku = new Map();
  for (const p of [...a, ...b]) {
    const cur = bySku.get(p.sku);
    if (!cur) {
      bySku.set(p.sku, { ...p });
    } else {
      cur.qty += p.qty;
      cur.revenue += p.revenue;
      cur.profit = cur.profit == null || p.profit == null ? null : cur.profit + p.profit;
    }
  }
  return [...bySku.values()].sort((x, y) => y.revenue - x.revenue).slice(0, 5);
}

function combined() {
  const s = TEMP.shopee;
  const t = TEMP.tiktok;
  return {
    orderCount: s.orderCount + t.orderCount,
    omzet: s.omzet + t.omzet,
    laba: s.laba + t.laba,
    layanan: s.layanan + t.layanan,
    biayaPesanan: s.biayaPesanan + t.biayaPesanan,
    iklan: s.iklan, // Shopee only for now
    affiliasi: s.affiliasi + t.affiliasi,
    prev: {
      orderCount: s.prev.orderCount + t.prev.orderCount,
      omzet: s.prev.omzet + t.prev.omzet,
      laba: s.prev.laba + t.prev.laba,
    },
    series: {
      orderCount: addArrays(s.series.orderCount, t.series.orderCount),
      omzet: addArrays(s.series.omzet, t.series.omzet),
      laba: addArrays(s.series.laba, t.series.laba),
    },
    topProducts: mergeProducts(s.topProducts, t.topProducts),
    leaking: [...s.leaking, ...t.leaking],
    priceDiffs: [...s.priceDiffs, ...t.priceDiffs],
  };
}

const pct = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);
const labaBersihOf = (d) => d.laba - d.layanan - d.biayaPesanan - (d.iklan ?? 0) - d.affiliasi;
const profitPctOf = (d) => (d.omzet ? Math.round((labaBersihOf(d) / d.omzet) * 1000) / 10 : null);

// Real page uses dd/mm/yyyy; this preview's date inputs change nothing.
function todayWIB(offsetDays = 0) {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000 + offsetDays * 86400000);
  return wib.toISOString().slice(0, 10);
}

function TempBanner() {
  return (
    <div style={{ background: colors.cardAlt, border: `1px dashed ${colors.orange}`, color: colors.orange, borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
      DATA CONTOH (TEMP): semua angka di halaman ini hanya contoh untuk mengecek tampilan, bukan data toko.
    </div>
  );
}

// New on Main: what each marketplace contributed.
function MarketplaceSplit() {
  const s = TEMP.shopee;
  const t = TEMP.tiktok;
  const total = s.omzet + t.omzet;
  const rows = [
    { label: 'Shopee', color: colors.orange, d: s },
    { label: 'TikTok', color: colors.blue, d: t },
  ];
  const cell = { padding: '8px 6px', textAlign: 'right', fontFamily: 'var(--num)', whiteSpace: 'nowrap' };
  const head = { ...cell, color: colors.textDim, fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 400 };
  return (
    <div style={card({ flex: 1, overflowX: 'auto' })}>
      <CardHeader label="Kontribusi per Marketplace" />
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, color: colors.text }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
            <th style={{ ...head, textAlign: 'left' }}>Marketplace</th>
            <th style={head}>Order</th>
            <th style={head}>Omzet</th>
            <th style={head}>Laba Kotor</th>
            <th style={head}>Porsi Omzet</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, color, d }) => (
            <tr key={label} style={{ borderBottom: `1px solid ${colors.border}` }}>
              <td style={{ ...cell, textAlign: 'left', fontFamily: 'var(--sans)' }}><span style={{ color }}>●</span> {label}</td>
              <td style={cell}>{d.orderCount}</td>
              <td style={cell}>{formatRupiah(d.omzet)}</td>
              <td style={cell}>{formatRupiah(d.laba)}</td>
              <td style={cell}>{Math.round((d.omzet / total) * 1000) / 10}%</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700 }}>
            <td style={{ ...cell, textAlign: 'left', fontFamily: 'var(--sans)' }}>Total</td>
            <td style={cell}>{s.orderCount + t.orderCount}</td>
            <td style={cell}>{formatRupiah(total)}</td>
            <td style={cell}>{formatRupiah(s.laba + t.laba)}</td>
            <td style={cell}>100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Main shows the two figures next to each other: they are measured differently
// on each marketplace, so a single total would mislead.
function PageViewsSplit() {
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
      <CardHeader label="Jumlah Pengunjung" />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: colors.textDim }}>Shopee</span>
        <span style={{ color: colors.text, fontWeight: 700, fontFamily: 'var(--num)' }}>{TEMP.shopee.pageViews.toLocaleString('id-ID')}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span style={{ color: colors.textDim }}>TikTok</span>
        <span style={{ color: colors.text, fontWeight: 700, fontFamily: 'var(--num)' }}>{TEMP.tiktok.pageViews.toLocaleString('id-ID')}</span>
      </div>
      <div style={{ fontSize: 11.5, color: colors.textFaint, lineHeight: 1.4 }}>Dihitung berbeda, jadi tidak dijumlahkan</div>
    </div>
  );
}

function PageViewsSingle({ value }) {
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
      <CardHeader label="Jumlah Pengunjung" />
      <div className="kp-kpi-value" style={{ fontSize: 24, fontWeight: 700, color: colors.text, letterSpacing: -0.5, fontFamily: 'var(--num)' }}>
        {value.toLocaleString('id-ID')}
      </div>
      <div style={{ fontSize: 11.5, marginTop: 4, color: colors.textFaint }}>Total halaman produk dilihat</div>
    </div>
  );
}

function BreakdownCard({ title, rows, barColor = colors.orange }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label={title} />
      {rows.map((r) => (
        <div key={r.label} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: colors.text }}>{r.label}</span>
            <span style={{ color: colors.text, fontFamily: 'var(--num)' }}>{formatRupiah(r.value)}</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: colors.cardAlt, overflow: 'hidden' }}>
            <div style={{ width: `${(r.value / total) * 100}%`, height: '100%', background: barColor }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Omzet vs Laba, one pair of bars per day. colors.green is too light to read as
// a chart fill on this dark card, so Laba uses the next darker green (checked
// with the dataviz palette validator, together with colors.blue).
const BAR_BLUE = colors.blue;
const BAR_GREEN = '#16a34a';
const CHART_HEIGHT = 170;

function shortRupiah(value) {
  if (value >= 1000000000) return `${Math.round((value / 1000000000) * 10) / 10}M`;
  if (value >= 1000000) return `${Math.round(value / 1000000)}jt`;
  if (value >= 1000) return `${Math.round(value / 1000)}rb`;
  return String(value);
}

// A round top for the axis, so the gridlines land on readable numbers.
function niceMax(value) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  const step = [1, 2, 2.5, 5, 10].find((m) => (m * magnitude) >= value / 4) * magnitude;
  return step * 4;
}

function lastSevenDays(endDate) {
  const end = new Date(`${endDate}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(end.getTime() - (6 - i) * 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function SevenDayBars({ omzet, laba, endDate }) {
  const [active, setActive] = useState(null);
  const days = lastSevenDays(endDate);
  const top = niceMax(Math.max(...omzet, ...laba));
  const ticks = [4, 3, 2, 1, 0].map((n) => (top / 4) * n);
  const heightOf = (v) => `${(v / top) * 100}%`;
  const swatch = (color) => <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, marginRight: 5 }} />;

  return (
    <div style={card({ flex: 1, minWidth: 0 })}>
      <CardHeader label="Omzet vs Laba 7 Hari Terakhir" />
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ position: 'relative', width: 34, height: CHART_HEIGHT, flexShrink: 0 }}>
          {ticks.map((t) => (
            <span key={t} style={{ position: 'absolute', right: 0, top: `${100 - (t / top) * 100}%`, transform: 'translateY(-50%)', fontSize: 10.5, color: colors.textDim, fontFamily: 'var(--num)' }}>
              {t === 0 ? '0' : shortRupiah(t)}
            </span>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <div style={{ position: 'relative', height: CHART_HEIGHT }}>
            {ticks.map((t) => (
              <div key={t} style={{ position: 'absolute', left: 0, right: 0, top: `${100 - (t / top) * 100}%`, height: 1, background: colors.border }} />
            ))}
            <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
              {days.map((day, i) => (
                <div
                  key={day}
                  tabIndex={0}
                  role="img"
                  aria-label={`${day}: Omzet ${formatRupiah(omzet[i])}, Laba ${formatRupiah(laba[i])}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(i)}
                  style={{ position: 'relative', flex: 1, minWidth: 0, padding: '0 4px', boxSizing: 'border-box', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, cursor: 'default', outline: 'none', background: active === i ? colors.cardAlt : 'transparent', borderRadius: 6 }}
                >
                  <div style={{ flex: 1, maxWidth: 24, height: heightOf(omzet[i]), background: BAR_BLUE, borderRadius: '4px 4px 0 0' }} />
                  <div style={{ flex: 1, maxWidth: 24, height: heightOf(laba[i]), background: BAR_GREEN, borderRadius: '4px 4px 0 0' }} />
                </div>
              ))}
            </div>
            {active != null && (
              <div
                style={{
                  position: 'absolute',
                  top: 4,
                  ...(active < 4 ? { left: `${((active + 1) / 7) * 100}%`, marginLeft: 6 } : { right: `${((7 - active) / 7) * 100}%`, marginRight: 6 }),
                  background: colors.bg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  color: colors.text,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 2,
                }}
              >
                <div style={{ color: colors.textDim, marginBottom: 4 }}>{days[active]}</div>
                <div>{swatch(BAR_BLUE)}<strong style={{ fontFamily: 'var(--num)' }}>{formatRupiah(omzet[active])}</strong> <span style={{ color: colors.textDim }}>Omzet</span></div>
                <div style={{ marginTop: 2 }}>{swatch(BAR_GREEN)}<strong style={{ fontFamily: 'var(--num)' }}>{formatRupiah(laba[active])}</strong> <span style={{ color: colors.textDim }}>Laba</span></div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', marginTop: 6 }}>
            {days.map((day) => (
              <div key={day} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 10.5, color: colors.textDim, fontFamily: 'var(--num)' }}>{day}</div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: colors.textDim, marginTop: 10 }}>
        <span>{swatch(BAR_BLUE)}Omzet</span>
        <span>{swatch(BAR_GREEN)}Laba</span>
      </div>
    </div>
  );
}

const TITLES = { main: 'Main (Gabungan Shopee + TikTok)', shopee: 'Shopee', tiktok: 'TikTok' };

function DashboardPreview({ view }) {
  const [startDate, setStartDate] = useState(todayWIB(-1));
  const [endDate, setEndDate] = useState(todayWIB(-1));

  const d = view === 'main' ? combined() : TEMP[view];
  const trendText = { suffix: '% dari hari sebelumnya', emptyText: 'Tidak ada pembanding' };
  const dateLabel = startDate === endDate ? startDate.split('-').reverse().join('/') : `${startDate.split('-').reverse().join('/')} - ${endDate.split('-').reverse().join('/')}`;
  // Main's Iklan is Shopee's alone, and TikTok has none at all: both make Laba Bersih incomplete.
  const netNote = view === 'shopee' ? null : 'Belum termasuk iklan TikTok';
  const iklanLabel = view === 'main' ? 'Iklan (Shopee saja)' : 'Iklan';

  return (
    <div style={{ color: colors.text }}>
      <TempBanner />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)' }}>Performa {dateLabel}</div>
          <div style={{ fontSize: 12, color: colors.textDim }}>{TITLES[view]}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" aria-label="Tanggal Mulai" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} style={dateInputStyle} />
          <span style={{ color: colors.textDim, fontSize: 13 }}>s/d</span>
          <input type="date" aria-label="Tanggal Selesai" value={endDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} style={dateInputStyle} />
        </div>
      </div>

      <div className="kp-kpis" style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <KpiCard label="Total Order" value={String(d.orderCount)} trend={{ pct: pct(d.orderCount, d.prev.orderCount), ...trendText }} spark={d.series.orderCount} />
        <KpiCard label="Omzet" value={formatRupiah(d.omzet)} trend={{ pct: pct(d.omzet, d.prev.omzet), ...trendText }} spark={d.series.omzet} />
        <KpiCard label="Laba Kotor" value={formatRupiah(d.laba)} trend={{ pct: pct(d.laba, d.prev.laba), ...trendText }} spark={d.series.laba} />
        <KpiCard label="Laba Bersih" value={formatRupiah(labaBersihOf(d))} note={netNote} />
        <KpiCard label="Persentase Profit" value={`${profitPctOf(d)}%`} note={netNote} />
        {view === 'main' ? <PageViewsSplit /> : <PageViewsSingle value={d.pageViews} />}
      </div>

      {view === 'main' && (
        <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <MarketplaceSplit />
        </div>
      )}

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProfitFunnel laba={d.laba} layanan={d.layanan} biayaPesanan={d.biayaPesanan} iklan={d.iklan} affiliasi={{ commission: d.affiliasi }} iklanLabel={iklanLabel} />
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <SevenDayBars omzet={d.series.omzet} laba={d.series.laba} endDate={endDate} />
      </div>

      {view !== 'main' && (
        <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <BreakdownCard title={d.feeDetailTitle} rows={d.feeDetail} />
          {view === 'tiktok' && <BreakdownCard title="GMV per Sumber" rows={d.gmvSources} barColor={colors.blue} />}
          {view === 'tiktok' && <BreakdownCard title="GMV Max vs Non-GMV Max" rows={d.gmvMax} barColor={colors.green} />}
        </div>
      )}

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProductList products={d.topProducts} dateLabel={dateLabel} />
        <CostBreakdown iklan={d.iklan} layanan={d.layanan} biayaPesanan={d.biayaPesanan} affiliasiCommission={d.affiliasi} dateLabel={dateLabel} iklanLabel={iklanLabel} />
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <StockList label="5 Stok Dashboard Terbanyak" items={STOCK.most} />
        <StockList label="5 Stok Dashboard Tersedikit" items={STOCK.least} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <BocorList leaking={d.leaking} />
      </div>

      <PriceDiffList diffs={d.priceDiffs} />
    </div>
  );
}

const dateInputStyle = {
  background: colors.cardAlt,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  padding: '6px 12px',
  borderRadius: 8,
  fontFamily: 'var(--sans)',
  cursor: 'pointer',
};

export default DashboardPreview;
