// Single source of truth for the connected Shopee shop id. Previously
// duplicated as `const SHOP_ID = 227886187` in 6 separate files — moving it
// here means updating one place instead of six if the shop is ever
// reconnected under a different id. This is still a single hardcoded value,
// not real multi-shop support (there's no shop picker anywhere in the UI);
// it just removes the duplication for whenever that becomes worth building.
export const SHOP_ID = 227886187;
