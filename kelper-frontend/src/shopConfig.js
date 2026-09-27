import { API_BASE } from './apiBase';

// Fallback for local dev and for the brief window before
// initActiveShopId() resolves. Also the value SHOP_ID stays at if the
// backend is unreachable or genuinely nothing is connected yet.
const FALLBACK_SHOP_ID = Number(import.meta.env.VITE_SHOP_ID) || 227886187;

// Client-requested (2026-09-27): used to be frozen at build time
// (VITE_SHOP_ID) — connecting a genuinely different shop via Settings
// stored its token correctly (see /auth/exchange), but nothing in the app
// ever pointed at it, since every request kept using the old build-time
// id. Now resolved at runtime from the backend instead (see
// initActiveShopId below), so reconnecting under a different shop takes
// effect without a rebuild/redeploy. This is a `let`, not a `const` — ES
// module named exports are live bindings, so every file that does
// `import { SHOP_ID } from './shopConfig'` sees the update automatically
// the next time it reads SHOP_ID, no context or prop drilling needed.
export let SHOP_ID = FALLBACK_SHOP_ID;

let initPromise = null;

async function fetchAndApplyActiveShopId() {
  try {
    const res = await fetch(`${API_BASE}/auth/status`);
    if (res.ok) {
      const rows = await res.json();
      // /auth/status is ordered most-recently-connected first. This app
      // only ever supports one active shop at a time (see the note this
      // constant used to carry), so row 0 is "the" shop. An empty list
      // (nothing connected yet) leaves SHOP_ID at its current/fallback
      // value rather than clearing it — there's nothing useful to switch
      // to, and the UI's own connected-state check (useShopeeConnection)
      // is what actually decides whether to show "connected".
      if (rows.length > 0) SHOP_ID = rows[0].shop_id;
    }
  } catch {
    // Backend unreachable at startup — keep the fallback rather than
    // blocking the app from rendering at all.
  }
  return SHOP_ID;
}

// Called once from App.jsx before anything else renders, so no component
// ever reads the stale fallback. Memoized — later callers (there aren't
// any today besides App.jsx) get the same in-flight/resolved result
// instead of firing a duplicate request.
export function initActiveShopId() {
  if (!initPromise) initPromise = fetchAndApplyActiveShopId();
  return initPromise;
}

// Unlike initActiveShopId, always re-fetches — called right after a
// successful main-app Shopee connection (see ShopeeCallback.jsx) so a
// newly-connected shop becomes "active" immediately, without needing a
// page reload.
export function refreshActiveShopId() {
  initPromise = fetchAndApplyActiveShopId();
  return initPromise;
}
