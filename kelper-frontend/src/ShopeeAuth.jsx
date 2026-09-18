import { useShopeeConnection } from './useShopeeConnection';

// Compact Shopee connection status, meant to sit inline (in the Dashboard's
// sidebar) rather than be its own screen — shows either a connected badge or
// a Login Shopee button. See useShopeeConnection for the actual check; the
// Dashboard's first-login connect prompt shares the same hook so both stay
// in sync without duplicating the fetch logic.
function ShopeeAuth() {
  const { checking, connected, shopName, loginShopee } = useShopeeConnection();

  if (checking) {
    return <span style={{ fontSize: 12, opacity: 0.6 }}>Checking Shopee...</span>;
  }

  if (connected) {
    return (
      <span style={{ fontSize: 12, color: '#2e7d32' }}>
        ✓ Shopee Connected{shopName ? ` — ${shopName}` : ''}
      </span>
    );
  }

  return (
    <button onClick={loginShopee} style={{ fontSize: 12, padding: '4px 10px' }}>
      Login Shopee
    </button>
  );
}

export default ShopeeAuth;
