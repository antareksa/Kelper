import { useShopeeConnection } from './useShopeeConnection';

// Brand Portal connection status — same shape as ShopeeAuth, but for the
// separate Brand Portal Shopee app (its own Partner ID/Key and OAuth
// callback, see App.jsx/useShopeeConnection). Kept as its own component
// rather than a prop on ShopeeAuth since the two connections are
// independent: one can be connected while the other isn't, and nothing
// about the main Shopee connection (order sync) depends on this one.
function ShopeeBrandAuth() {
  const { checking, connected, loginShopee, logoutShopee } = useShopeeConnection(true, 'brand');

  function handleDisconnect() {
    if (!window.confirm('Putuskan koneksi Brand Portal? Affiliasi & Pengunjung akan berhenti tersedia sampai terhubung lagi.')) return;
    logoutShopee();
  }

  if (checking) {
    return <span style={{ fontSize: 12, opacity: 0.6 }}>Checking Brand Portal...</span>;
  }

  if (connected) {
    return (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#2e7d32', lineHeight: 1.4 }}>✓ Brand Portal Connected</div>
        <button onClick={handleDisconnect} style={{ fontSize: 11, padding: '2px 8px', opacity: 0.75, marginTop: 6 }}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button onClick={loginShopee} style={{ fontSize: 12, padding: '4px 10px' }}>
      Connect
    </button>
  );
}

export default ShopeeBrandAuth;
