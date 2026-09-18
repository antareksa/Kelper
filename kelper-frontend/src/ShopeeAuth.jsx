import { useShopeeConnection } from './useShopeeConnection';

// Compact Shopee connection status, meant to sit inline (in the Dashboard's
// sidebar) rather than be its own screen — shows either a connected badge or
// a Login Shopee button. See useShopeeConnection for the actual check; the
// Dashboard's first-login connect prompt shares the same hook so both stay
// in sync without duplicating the fetch logic.
function ShopeeAuth() {
  const { checking, connected, shopName, loginShopee, logoutShopee } = useShopeeConnection();

  function handleLogout() {
    if (!window.confirm('Logout dari Shopee? Sinkronisasi pesanan akan berhenti sampai login lagi.')) return;
    logoutShopee();
  }

  if (checking) {
    return <span style={{ fontSize: 12, opacity: 0.6 }}>Checking Shopee...</span>;
  }

  if (connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#2e7d32' }}>
          ✓ Shopee Connected{shopName ? ` — ${shopName}` : ''}
        </span>
        <button onClick={handleLogout} style={{ fontSize: 11, padding: '2px 8px', opacity: 0.75 }}>
          Logout
        </button>
      </div>
    );
  }

  return (
    <button onClick={loginShopee} style={{ fontSize: 12, padding: '4px 10px' }}>
      Login Shopee
    </button>
  );
}

export default ShopeeAuth;
