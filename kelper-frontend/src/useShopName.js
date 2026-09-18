import { useEffect, useState } from 'react';

// A production build is served from the same origin as the API (Caddy
// proxies both from one hostname), so relative paths just work and http://
// would break under HTTPS as mixed content anyway. Dev still needs the
// explicit cross-origin call since Vite's dev server (5173) and the backend
// (3001) really are different origins there.
const API_BASE = import.meta.env.PROD ? '' : `http://${window.location.hostname}:3001`;

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
