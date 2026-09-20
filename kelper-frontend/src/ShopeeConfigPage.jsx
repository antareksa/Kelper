import ShopeeAuth from './ShopeeAuth';
import ShopeeBrandAuth from './ShopeeBrandAuth';
import { colors, card } from './theme';

// Dedicated page for both Shopee connections (main app for order sync,
// Brand Portal app for Affiliasi/Pengunjung) — moved here from the sidebar's
// bottom-left so checking/managing them doesn't take up permanent space in
// every other screen; this is purely a status/control page, nothing else.
function ShopeeConfigPage() {
  return (
    <div style={{ color: colors.text }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--heading)', marginBottom: 16 }}>
        Konfigurasi Shopee
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card(), flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Koneksi Utama (Order Sync)</div>
          <ShopeeAuth />
        </div>

        <div style={{ ...card(), flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 12 }}>Brand Portal (Affiliasi/Pengunjung)</div>
          <ShopeeBrandAuth />
        </div>
      </div>
    </div>
  );
}

export default ShopeeConfigPage;
