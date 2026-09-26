import { useEffect, useState } from 'react';
import { SHOP_ID } from './shopConfig';
import { API_BASE, apiFetch } from './apiBase';

// Shared Shopee-connection check — used by both the sidebar's compact status
// (ShopeeAuth) and the Dashboard's first-login connect prompt, so there's
// only one place that knows how to ask the backend "is Shopee connected".
// `enabled` lets a caller defer the check (e.g. until the admin is actually
// logged in) instead of firing on mount unconditionally.
//
// `variant` picks which Shopee app this checks: 'main' (order sync, default)
// or 'brand' (the separate Brand Portal app — see ShopeeBrandAuth). They
// hit entirely separate backend routes/tokens, so connecting or
// disconnecting one can never affect the other. The brand variant skips the
// shop-name lookup — /shop/info is a main-app-credentialed call, and Brand
// Portal's own equivalent isn't wired up, so there's nothing to show there
// beyond connected/not.
export function useShopeeConnection(enabled = true, variant = 'main') {
  const authPrefix = variant === 'brand' ? '/auth/brand' : '/auth';
  const [checking, setChecking] = useState(true);
  const [connected, setConnected] = useState(false);
  const [shopName, setShopName] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setChecking(true);
    fetch(`${API_BASE}${authPrefix}/check?shop_id=${SHOP_ID}`)
      .then((res) => res.json())
      .then(async (data) => {
        if (cancelled) return;
        setConnected(!!data.connected);
        if (data.connected && variant === 'main') {
          const infoRes = await apiFetch(`${API_BASE}/shop/info?shop_id=${SHOP_ID}`);
          const infoData = await infoRes.json();
          if (!cancelled && infoRes.ok) setShopName(infoData.shop_name);
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, authPrefix, variant]);

  function loginShopee() {
    window.location.href = `${API_BASE}${authPrefix}/login`;
  }

  // Only forgets the token on KELPER's own side (see the backend route) —
  // re-checks afterward instead of just assuming it worked, same as any
  // other state change here.
  async function logoutShopee() {
    await fetch(`${API_BASE}${authPrefix}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop_id: SHOP_ID }),
    });
    setConnected(false);
    setShopName(null);
  }

  return { checking, connected, shopName, loginShopee, logoutShopee };
}
