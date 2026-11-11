import { useEffect, useState } from 'react';
import { API_BASE, apiFetch } from './apiBase';
import { SHOP_ID } from './shopConfig';
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

// The Main / Shopee / TikTok Dashboard (2026-11-04, real data since 2026-11-10).
// Each view reads /dashboard/summary with ?platform= all / shopee / tiktok (see
// routes/dashboard.js). Shown on staging, and on any server with TikTok set up
// (Dashboard.jsx's marketplaceViews); otherwise MainDashboard.jsx is shown.
//
// Main is computed by the server the way it must be: amounts are added,
// percentages recomputed from the totals (never added or averaged).

const PLATFORM_OF_VIEW = { main: 'all', shopee: 'shopee', tiktok: 'tiktok' };

function todayWIB(offsetDays = 0) {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000 + offsetDays * 86400000);
  return wib.toISOString().slice(0, 10);
}

function Notice({ children }) {
  return (
    <div style={{ background: colors.cardAlt, border: `1px dashed ${colors.border}`, color: colors.textDim, borderRadius: 10, padding: '10px 14px', fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

// New on Main: what each marketplace contributed.
function MarketplaceSplit({ byPlatform }) {
  const s = byPlatform.shopee;
  const t = byPlatform.tiktok;
  const total = s.omzet + t.omzet;
  const rows = [
    { label: 'Shopee', color: colors.orange, d: s },
    { label: 'TikTok / Tokopedia', color: colors.blue, d: t },
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
              <td style={cell}>{total ? `${Math.round((d.omzet / total) * 1000) / 10}%` : '—'}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700 }}>
            <td style={{ ...cell, textAlign: 'left', fontFamily: 'var(--sans)' }}>Total</td>
            <td style={cell}>{s.orderCount + t.orderCount}</td>
            <td style={cell}>{formatRupiah(total)}</td>
            <td style={cell}>{formatRupiah(s.laba + t.laba)}</td>
            <td style={cell}>{total ? '100%' : '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Page views exist for Shopee only: TikTok's need the analytics API scope,
// which the app doesn't have (see docs/FEATURE-tiktok-integration.md).
function PageViewsCard({ shopee, showTiktok }) {
  const fmt = (v) => (v == null ? 'Belum ada data' : v.toLocaleString('id-ID'));
  const row = (label, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
      <span style={{ color: colors.textDim }}>{label}</span>
      <span style={{ color: colors.text, fontWeight: 700, fontFamily: 'var(--num)' }}>{value}</span>
    </div>
  );
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
      <CardHeader label="Jumlah Pengunjung" />
      {shopee !== undefined && row('Shopee', fmt(shopee))}
      {showTiktok && row('TikTok', 'Belum tersedia')}
      <div style={{ fontSize: 11.5, color: colors.textFaint, lineHeight: 1.4 }}>Halaman produk dilihat. TikTok belum tersedia lewat API.</div>
    </div>
  );
}

function BreakdownCard({ title, rows, barColor = colors.orange, emptyText }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label={title} />
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: colors.textDim, padding: '8px 0' }}>{emptyText}</div>}
      {rows.map((r) => (
        <div key={r.label} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: colors.text }}>{r.label}</span>
            <span style={{ color: colors.text, fontFamily: 'var(--num)' }}>{formatRupiah(r.value)}</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: colors.cardAlt, overflow: 'hidden' }}>
            <div style={{ width: `${total ? (r.value / total) * 100 : 0}%`, height: '100%', background: barColor }} />
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

const TITLES = { main: 'Main (Gabungan Shopee + TikTok/Tokopedia)', shopee: 'Shopee', tiktok: 'TikTok / Tokopedia' };

// { label: amount } -> rows for BreakdownCard, largest first, zeros dropped.
const feeRows = (detail) => Object.entries(detail || {}).filter(([, v]) => v).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

function DashboardPreview({ view }) {
  const [startDate, setStartDate] = useState(todayWIB(0));
  const [endDate, setEndDate] = useState(todayWIB(0));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await apiFetch(`${API_BASE}/dashboard/summary?shop_id=${SHOP_ID}&platform=${PLATFORM_OF_VIEW[view]}&start=${startDate}&end=${endDate}`);
        const body = await res.json();
        if (cancelled) return;
        if (res.ok) {
          setData(body);
          setError(null);
        } else {
          setError(view === 'shopee' && body.error === 'shop_id_required' ? 'Shopee belum terhubung di server ini.' : body.message || body.error);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    setData(null);
    load();
    const interval = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [view, startDate, endDate]);

  const trendText = { suffix: '% dari periode sebelumnya', emptyText: 'Tidak ada pembanding' };
  const dateLabel = startDate === endDate ? startDate.split('-').reverse().join('/') : `${startDate.split('-').reverse().join('/')} - ${endDate.split('-').reverse().join('/')}`;
  // Main's Iklan is Shopee's alone, and TikTok has none at all: both make Laba Bersih incomplete.
  const netNote = view === 'shopee' ? null : 'Belum termasuk iklan TikTok';
  const iklanLabel = view === 'main' ? 'Iklan (Shopee saja)' : 'Iklan';

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)' }}>Performa {dateLabel}</div>
        <div style={{ fontSize: 12, color: colors.textDim }}>{TITLES[view]}{loading ? ' · memuat...' : ''}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" aria-label="Tanggal Mulai" value={startDate} max={endDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} style={dateInputStyle} />
        <span style={{ color: colors.textDim, fontSize: 13 }}>s/d</span>
        <input type="date" aria-label="Tanggal Selesai" value={endDate} min={startDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} style={dateInputStyle} />
      </div>
    </div>
  );

  if (error) return <div style={{ color: colors.text }}>{header}<Notice>{error}</Notice></div>;
  if (!data) return <div style={{ color: colors.text }}>{header}</div>;

  const t = data.today;
  const affiliasi = data.affiliasi?.commission ?? null;
  const tiktokFees = feeRows(data.feeDetail?.tiktok);
  const shopeeFees = feeRows(data.feeDetail?.shopee);

  return (
    <div style={{ color: colors.text }}>
      {header}
      {view !== 'shopee' && (
        <Notice>
          TikTok/Tokopedia: Omzet dan Laba Kotor memakai harga katalog x jumlah, sama seperti Shopee. Biaya, Layanan dan Affiliasi TikTok baru masuk setelah TikTok menyelesaikan pembayaran (settlement) order itu, biasanya beberapa hari setelah diterima pembeli.
        </Notice>
      )}

      <div className="kp-kpis" style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <KpiCard label="Total Order" value={String(t.orderCount)} trend={{ pct: data.trend.orderCountPct, ...trendText }} spark={data.series.orderCount} />
        <KpiCard label="Omzet" value={formatRupiah(t.omzet)} trend={{ pct: data.trend.omzetPct, ...trendText }} spark={data.series.omzet} />
        <KpiCard label="Laba Kotor" value={formatRupiah(t.laba)} trend={{ pct: data.trend.labaPct, ...trendText }} spark={data.series.laba} />
        <KpiCard label="Laba Bersih" value={formatRupiah(t.labaBersih)} note={netNote} />
        <KpiCard label="Persentase Profit" value={t.marginPct == null ? '—' : `${t.marginPct}%`} note={netNote} />
        <PageViewsCard shopee={view === 'tiktok' ? undefined : data.pageViews?.pageViews ?? null} showTiktok={view !== 'shopee'} />
      </div>

      {view === 'main' && data.byPlatform && (
        <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <MarketplaceSplit byPlatform={data.byPlatform} />
        </div>
      )}

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProfitFunnel laba={t.laba} layanan={t.layanan} biayaPesanan={t.biayaPesanan} iklan={t.iklan} affiliasi={{ commission: affiliasi }} iklanLabel={iklanLabel} />
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <SevenDayBars omzet={data.series.omzet.slice(-7)} laba={data.series.laba.slice(-7)} endDate={endDate} />
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        {view !== 'tiktok' && <BreakdownCard title="Rincian Biaya Shopee" rows={shopeeFees} emptyText="Belum ada order Shopee yang sudah settle di periode ini." />}
        {view !== 'shopee' && <BreakdownCard title="Rincian Biaya TikTok / Tokopedia" rows={tiktokFees} barColor={colors.blue} emptyText="Belum ada order TikTok/Tokopedia yang sudah settle di periode ini." />}
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProductList products={data.topProducts} dateLabel={dateLabel} />
        <CostBreakdown iklan={t.iklan} layanan={t.layanan} biayaPesanan={t.biayaPesanan} affiliasiCommission={affiliasi} dateLabel={dateLabel} iklanLabel={iklanLabel} />
      </div>

      <div className="kp-stack" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <StockList label="5 Stok Dashboard Terbanyak" items={data.mostStock} />
        <StockList label="5 Stok Dashboard Tersedikit" items={data.leastStock} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <BocorList leaking={data.leaking} />
      </div>

      <PriceDiffList diffs={data.priceDiffs} />
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
