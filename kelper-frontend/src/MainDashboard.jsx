import { useEffect, useState } from 'react';
import { colors, card } from './theme';
import { Sparkline } from './Sparkline';
import { IconArrowUpRight } from './Icons';
import { useShopName } from './useShopName';
import { SHOP_ID } from './shopConfig';
import { API_BASE, apiFetch } from './apiBase';

const REFRESH_MS = 60000;

function formatRupiah(value) {
  if (value == null) return '—';
  return `Rp${Math.round(value).toLocaleString('id-ID')}`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// pct is a plain percentage-change number (e.g. 12.3 or -4.5); suffix lets
// the margin card (a percentage-POINT delta, not a percentage change) read
// correctly instead of implying a second layer of percent-of-percent math.
function trendLabel(pct, suffix = '% dari kemarin') {
  if (pct == null) return 'Belum ada data kemarin';
  return `${pct > 0 ? '+' : ''}${pct}${suffix}`;
}

function trendType(pct) {
  if (pct == null) return null;
  return pct >= 0 ? 'up' : 'down';
}

function CardHeader({ label }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: colors.textDim }}>{label}</div>
      <IconArrowUpRight size={13} color={colors.textFaint} />
    </div>
  );
}

function KpiCard({ label, value, trend, spark }) {
  const type = trendType(trend?.pct);
  const sparkColor = type === 'up' ? colors.green : type === 'down' ? colors.red : colors.textFaint;
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column' }}>
      <CardHeader label={label} />
      <div style={{ fontSize: 24, fontWeight: 700, color: colors.text, letterSpacing: -0.5, fontFamily: 'var(--num)' }}>{value}</div>
      <div style={{ fontSize: 12, marginTop: 4, marginBottom: 12, color: type === 'up' ? colors.green : type === 'down' ? colors.red : colors.textFaint }}>
        {type === 'up' ? '▲' : type === 'down' ? '▼' : '—'}{' '}
        <span style={{ fontFamily: 'var(--num)' }}>{trend ? trendLabel(trend.pct, trend.suffix) : 'Belum ada data kemarin'}</span>
      </div>
      {spark && spark.length >= 2 ? <Sparkline data={spark} color={sparkColor} height={30} /> : <div style={{ height: 30 }} />}
    </div>
  );
}

function BlockedCard({ label, note }) {
  return (
    <div style={{ ...card(), flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', opacity: 0.65 }}>
      <CardHeader label={label} />
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.textFaint, marginBottom: 6 }}>Belum terhubung</div>
      <div style={{ fontSize: 11.5, color: colors.textFaint, lineHeight: 1.4 }}>{note}</div>
    </div>
  );
}

// All five funnel steps are real now. Affiliasi comes from a separate
// source (Brand Portal, fetched once daily) with its own 1-day reporting
// lag, so it's never "today" — the label says which day it actually is.
// Iklan is genuinely today's spend so far (refetched every few minutes —
// see shopeeSync.js's fetchAdsPerformance), same as Margin/Layanan/Biaya
// Pesanan. `blocked` only fires transiently, before the first fetch has
// happened yet (e.g. right after connecting Brand Portal, or right after
// server startup for Iklan).
function ProfitFunnel({ laba, layanan, biayaPesanan, iklan, affiliasi }) {
  const steps = [
    { label: 'Margin (Estimasi)', value: formatRupiah(laba), color: colors.green, blocked: false },
    { label: 'Iklan', value: iklan != null ? formatRupiah(iklan) : null, color: colors.blue, blocked: iklan == null },
    { label: 'Layanan', value: formatRupiah(layanan), color: colors.blue, blocked: false },
    { label: 'Biaya Pesanan', value: formatRupiah(biayaPesanan), color: colors.orange, blocked: false },
    {
      label: affiliasi ? `Affiliasi (${affiliasi.date})` : 'Affiliasi',
      value: affiliasi ? formatRupiah(affiliasi.salesConfirmed) : null,
      color: colors.orange,
      blocked: !affiliasi,
    },
  ];
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Profit Funnel" />
      <div style={{ display: 'flex', gap: 8 }}>
        {steps.map((s) => (
          <div
            key={s.label}
            style={{
              flex: 1,
              aspectRatio: '2 / 1',
              background: s.blocked ? colors.cardAlt : s.color,
              border: s.blocked ? `1px dashed ${colors.border}` : 'none',
              borderRadius: 10,
              padding: '14px 14px',
              color: s.blocked ? colors.textFaint : '#fff',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ fontSize: 14, opacity: 0.9 }}>{s.label}</div>
            <div style={{ fontSize: s.blocked ? 11.5 : 19, fontWeight: 700, fontFamily: 'var(--num)' }}>
              {s.blocked ? 'Belum tersedia' : s.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Real intraday cumulative Omzet/Laba for today, bucketed by WIB hour —
// replaces the old hardcoded placeholder curve.
function LineChart({ omzetSeries, labaSeries }) {
  if (!omzetSeries || omzetSeries.length === 0) {
    return (
      <div style={card({ flex: 1 })}>
        <CardHeader label="Omzet vs Laba Hari Ini (Estimasi, per jam)" />
        <div style={{ padding: '30px 0', textAlign: 'center', color: colors.textDim, fontSize: 13 }}>Belum ada order hari ini.</div>
      </div>
    );
  }

  const max = Math.max(1, ...omzetSeries, ...labaSeries);
  const toCoords = (series) => series.map((v, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * 300 : 0;
    const y = 92 - (v / max) * 82;
    return [x, y];
  });
  const omzetCoords = toCoords(omzetSeries);
  const labaCoords = toCoords(labaSeries);
  const [lastOmzetX, lastOmzetY] = omzetCoords[omzetCoords.length - 1];
  const [lastLabaX, lastLabaY] = labaCoords[labaCoords.length - 1];

  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Omzet vs Laba Hari Ini (Estimasi, per jam)" />
      <div style={{ position: 'relative' }}>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" style={{ width: '100%', height: 140, display: 'block' }}>
          <line x1="0" y1="92" x2="300" y2="92" stroke={colors.border} strokeWidth="1" strokeDasharray="2 4" />
          <polyline points={omzetCoords.map((p) => p.join(',')).join(' ')} fill="none" stroke={colors.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={labaCoords.map((p) => p.join(',')).join(' ')} fill="none" stroke={colors.green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {/* plain circular dots — the svg above is stretched non-uniformly (preserveAspectRatio="none"), which would turn <circle> into an ellipse */}
        <span style={{ position: 'absolute', left: `${(lastOmzetX / 300) * 100}%`, top: `${lastOmzetY}%`, transform: 'translate(-50%, -50%)', width: 7, height: 7, borderRadius: '50%', background: colors.blue }} />
        <span style={{ position: 'absolute', left: `${(lastLabaX / 300) * 100}%`, top: `${lastLabaY}%`, transform: 'translate(-50%, -50%)', width: 7, height: 7, borderRadius: '50%', background: colors.green }} />
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: colors.textDim, marginTop: 4 }}>
        <span><span style={{ color: colors.blue }}>●</span> Omzet</span>
        <span><span style={{ color: colors.green }}>●</span> Laba</span>
      </div>
    </div>
  );
}

function ProductList({ products }) {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Produk Paling Menguntungkan (30 Hari Terakhir)" />
      {products.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>Belum ada data penjualan.</div>
      ) : (
        products.map((p) => (
          <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
            <div>
              <div style={{ color: colors.text }}>{p.name}</div>
              <div style={{ color: colors.textDim, fontSize: 11 }}>{p.sku} · {p.qty} terjual</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>{formatRupiah(p.revenue)}</div>
              <div style={{ color: p.profit == null ? colors.textFaint : colors.green, fontSize: 11, fontFamily: 'var(--num)' }}>
                {p.profit == null ? 'HPP belum diisi' : `Profit ${formatRupiah(p.profit)}`}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// Ranks today's cost figures against each other — all three now have a real
// data source (see ProfitFunnel), so this went from a permanent "not
// connected" placeholder to an actual breakdown.
function CostBreakdown({ iklan, layanan, biayaPesanan }) {
  const costs = [
    { label: 'Iklan', value: iklan },
    { label: 'Layanan', value: layanan },
    { label: 'Biaya Pesanan', value: biayaPesanan },
  ]
    .filter((c) => c.value != null)
    .sort((a, b) => b.value - a.value);
  const total = costs.reduce((sum, c) => sum + c.value, 0);

  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Biaya Terbesar Hari Ini" />
      {costs.length === 0 || total === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>Belum ada biaya tercatat hari ini.</div>
      ) : (
        costs.map((c) => (
          <div key={c.label} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: colors.text }}>{c.label}</span>
              <span style={{ color: colors.text, fontFamily: 'var(--num)' }}>{formatRupiah(c.value)}</span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: colors.cardAlt, overflow: 'hidden' }}>
              <div style={{ width: `${(c.value / total) * 100}%`, height: '100%', background: colors.orange }} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// Ranked on the client's own manually-entered dashboard stock (products.stock),
// not Shopee's live stock — see the backend's stockRankSelect for why. Only
// SKUs with a value show up at all, so an unfilled stock never masquerades
// as "0, least in stock".
function StockList({ label, items }) {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label={label} />
      {items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>
          Belum ada produk dengan Stok Dashboard terisi.
        </div>
      ) : (
        items.map((p) => (
          <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
            <div>
              <div style={{ color: colors.text }}>{p.name}</div>
              <div style={{ color: colors.textDim, fontSize: 11 }}>{p.sku}</div>
            </div>
            <div style={{ color: colors.text, fontFamily: 'var(--num)', fontWeight: 600 }}>{p.stock}</div>
          </div>
        ))
      )}
    </div>
  );
}

function BocorList({ leaking }) {
  return (
    <div style={card({ flex: 1 })}>
      <CardHeader label="Produk Bocor (Harga ≤ HPP)" />
      {leaking.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: colors.textDim, fontSize: 13 }}>
          Tidak ada produk bocor — semua produk berada dalam kontrol baik.
        </div>
      ) : (
        leaking.map((p) => (
          <div key={p.sku} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13 }}>
            <div>
              <div style={{ color: colors.text }}>{p.name}</div>
              <div style={{ color: colors.textDim, fontSize: 11 }}>{p.sku}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: colors.text, fontFamily: 'var(--num)' }}>Harga {formatRupiah(p.price)}</div>
              <div style={{ color: colors.red, fontSize: 11, fontFamily: 'var(--num)' }}>
                HPP {formatRupiah(p.hpp)} (rugi {formatRupiah(p.hpp - p.price)}/pcs)
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function MainDashboard() {
  const shopName = useShopName();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);

  async function load() {
    try {
      const res = await apiFetch(`${API_BASE}/dashboard/summary?shop_id=${SHOP_ID}`);
      if (res.ok) {
        setData(await res.json());
        setLastRefreshAt(Date.now());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return <div style={{ color: colors.textDim, padding: 40, textAlign: 'center' }}>Memuat data dashboard...</div>;
  }
  if (!data) {
    return <div style={{ color: colors.red, padding: 40, textAlign: 'center' }}>Gagal memuat data dashboard.</div>;
  }

  return (
    <div style={{ color: colors.text }}>
      <div style={{ background: colors.orangeDim, border: `1px solid ${colors.orange}`, color: '#f0c674', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
        Omzet &amp; Laba di bawah ini adalah <strong>estimasi</strong> untuk order yang belum dikirim (harga katalog saat ini × qty terjual, karena Shopee belum menyediakan harga per-order untuk toko ini) dan <strong>data riil Shopee</strong> untuk order yang sudah dikirim.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)' }}>Performa Hari Ini</div>
          <div style={{ fontSize: 12, color: colors.textDim }}>{shopName || 'Toko belum terhubung'} — last update {formatTime(lastRefreshAt)}</div>
        </div>
        <button
          onClick={load}
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
        <KpiCard label="Total Order Hari Ini" value={String(data.today.orderCount)} trend={{ pct: data.trend.orderCountPct }} spark={data.series.orderCount} />
        <KpiCard label="Omzet Hari Ini (Estimasi)" value={formatRupiah(data.today.omzet)} trend={{ pct: data.trend.omzetPct }} spark={data.series.omzet} />
        <KpiCard label="Laba Kotor Hari Ini (Estimasi)" value={formatRupiah(data.today.laba)} trend={{ pct: data.trend.labaPct }} spark={data.series.laba} />
        <KpiCard
          label="Persentase Profit (Estimasi)"
          value={data.today.marginPct != null ? `${data.today.marginPct}%` : '—'}
          trend={{ pct: data.trend.marginPctDelta, suffix: ' poin dari kemarin' }}
        />
        {data.pengunjung ? (
          <KpiCard label={`Pengunjung (${data.pengunjung.date})`} value={String(data.pengunjung.uniqueVisitors)} />
        ) : (
          <BlockedCard label="Pengunjung" note="Belum ada data — menunggu fetch harian pertama dari Brand Portal." />
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProfitFunnel laba={data.today.laba} layanan={data.today.layanan} biayaPesanan={data.today.biayaPesanan} iklan={data.today.iklan} affiliasi={data.affiliasi} />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <LineChart omzetSeries={data.todayHourly.omzet} labaSeries={data.todayHourly.laba} />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <ProductList products={data.topProducts} />
        <CostBreakdown iklan={data.today.iklan} layanan={data.today.layanan} biayaPesanan={data.today.biayaPesanan} />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <StockList label="5 Stok Dashboard Terbanyak" items={data.mostStock} />
        <StockList label="5 Stok Dashboard Tersedikit" items={data.leastStock} />
      </div>

      <BocorList leaking={data.leaking} />
    </div>
  );
}

export default MainDashboard;
