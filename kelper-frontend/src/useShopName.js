import { useEffect, useState } from 'react';

const API_BASE = 'http://localhost:3001';

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
