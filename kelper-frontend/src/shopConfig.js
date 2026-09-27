// Single source of truth for the connected Shopee shop id. Previously
// duplicated as `const SHOP_ID = 227886187` in 6 separate files — moving it
// here meant updating one place instead of six.
//
// Client-confirmed (2026-09-27): this app only ever supports one Shopee
// shop, by design — there's no shop picker anywhere in the UI, and there
// never needs to be. That's fine. What's NOT fine is the id itself being a
// literal baked into the source code, since reconnecting under a different
// shop id (e.g. after a full disconnect/reconnect) would otherwise require
// a code change and a redeploy just to update one number. VITE_SHOP_ID lets
// that be a build-time config value instead — set it in
// kelper-frontend/.env.production on the VM to override; the literal below
// is only the fallback for local dev, where no such file exists.
export const SHOP_ID = Number(import.meta.env.VITE_SHOP_ID) || 227886187;
