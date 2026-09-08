import { useEffect, useState } from 'react';

const API_BASE = 'http://localhost:3001';
const SHOP_ID = 227886187;

// Compact Shopee connection status, meant to sit in a page corner rather than
// be its own screen — checks connectivity on mount and shows either a
// connected badge or a Login Shopee button.
function ShopeeAuth() {
  const [checking, setChecking] = useState(true);
  const [connected, setConnected] = useState(false);
  const [shopName, setShopName] = useState(null);

  useEffect(() => {
    checkConnection();
  }, []);

  async function checkConnection() {
    setChecking(true);
    try {
      const res = await fetch(`${API_BASE}/auth/check?shop_id=${SHOP_ID}`);
      const data = await res.json();
      setConnected(data.connected);
      if (data.connected) {
        const infoRes = await fetch(`${API_BASE}/shop/info?shop_id=${SHOP_ID}`);
        const infoData = await infoRes.json();
        if (infoRes.ok) setShopName(infoData.shop_name);
      }
    } catch {
      setConnected(false);
    } finally {
      setChecking(false);
    }
  }

  function handleLogin() {
    window.location.href = `${API_BASE}/auth/login`;
  }

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
    <button onClick={handleLogin} style={{ fontSize: 12, padding: '4px 10px' }}>
      Login Shopee
    </button>
  );
}

export default ShopeeAuth;
