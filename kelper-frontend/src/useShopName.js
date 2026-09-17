import { useEffect, useState } from 'react';

// Resolves relative to whatever host served this page — a station on
// another machine loads this over the LAN (e.g. http://192.168.1.50:5173),
// so the API must be reached at that same address, not the station's own
// localhost, which has nothing running on port 3001.
const API_BASE = `http://${window.location.hostname}:3001`;

export function useShopName() {
  const [shopName, setShopName] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/shop/info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.shop_name) setShopName(data.shop_name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return shopName;
}
