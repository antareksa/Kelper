// Where the backend API lives — previously duplicated as
// `const API_BASE = import.meta.env.PROD ? '' : ...` in 9 separate files.
//
// On the real production VM, Caddy serves both frontend and backend from
// one origin (dashboard.kelper.co.id / packing.kelper.co.id), so a relative
// path just works. `npm run dev` needs the explicit cross-origin call since
// Vite's dev server (5173) and the backend (3001) are different origins.
//
// A THIRD case (client-requested 2026-09-26): a "local" Packing Station —
// this exact production build, served from that station's own machine
// instead of the real VM (see start-local-packing-station.bat), because
// that location can't reliably reach the public URL but should still use
// real production data, not a separate local database. Serving the build
// locally means there's no shared origin with the backend, so a relative
// path would 404 — this falls back to the real backend's public URL
// instead, whenever a PROD build is running on localhost. CORS is already
// wide open (server.js sets Access-Control-Allow-Origin: *), so no backend
// change is needed for this to work.
const PRODUCTION_API_BASE = 'https://packing.kelper.co.id';
const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

export const API_BASE = import.meta.env.PROD
  ? (isLocalHost ? PRODUCTION_API_BASE : '')
  : `http://${window.location.hostname}:3001`;

// Real admin session token (security fix, 2026-09-26) — until now,
// /admin/login only gated the frontend's own React state, with every admin
// API route reachable by anyone who found the public URL, logged in or not.
// See the backend's adminSession.js for the other half of this.
const TOKEN_KEY = 'kelper_admin_token';

export function getAdminToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private browsing / blocked storage — just means "no token"
  }
}

export function setAdminToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore — same as above, this only degrades to "not logged in"
  }
}

export function clearAdminToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
  } catch {
    // ignore
  }
}

// Which kind of dashboard login this is: 'admin' (everything) or 'packing'
// (Packing Station Dashboard + Order only). Kept next to the token so the
// sidebar can render the right menu instantly on reload; it is only a cache
// of what the server said at login -- the page re-asks /admin/me, and the
// server enforces the role on every request regardless, so editing this in
// the browser changes nothing but which buttons are drawn. Anything unknown
// reads as 'admin': a login from before roles existed was always a full admin.
const ROLE_KEY = 'kelper_admin_role';

export function getAdminRole() {
  try {
    return localStorage.getItem(ROLE_KEY) === 'packing' ? 'packing' : 'admin';
  } catch {
    return 'admin';
  }
}

export function setAdminRole(role) {
  try {
    localStorage.setItem(ROLE_KEY, role === 'packing' ? 'packing' : 'admin');
  } catch {
    // ignore
  }
}

// Drop-in replacement for fetch() that attaches the admin token when one
// exists. Safe to use everywhere, including calls made before login or to
// routes that don't require it (e.g. /auth/check, which the pre-login
// landing page's Shopee badge calls) — with no token stored, this behaves
// exactly like plain fetch, and an unprotected route ignores the header
// either way.
export function apiFetch(input, init = {}) {
  const token = getAdminToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
