const crypto = require('crypto');
const { signPublic, signShop } = require('./sign');

const {
  SHOPEE_PARTNER_ID,
  SHOPEE_PARTNER_KEY,
  SHOPEE_REDIRECT_URI,
  SHOPEE_BRAND_PARTNER_ID,
  SHOPEE_BRAND_PARTNER_KEY,
  SHOPEE_BRAND_REDIRECT_URI,
  SHOPEE_BRAND_AUTH_BASE,
  SHOPEE_BRAND_AUTH_TYPE,
  SHOPEE_AUTH_BASE,
  SHOPEE_API_BASE,
} = process.env;

// The Brand Portal integration is a second, separate Shopee app (its own
// Partner ID/Key/redirect URI on the same Shopee environment) — buildAuthUrl/
// exchangeToken/refreshToken below take a credentials set instead of always
// reading the main app's env vars, so the same OAuth logic works for either
// app without duplicating it. Existing callers are unaffected: the default
// is exactly the main app's credentials, i.e. today's behavior.
//
// authBase/authType: where the authorization link points and which kind of
// authorization it asks for. Shopee's authorization page supports several
// kinds, each with its own login system (read from its public page: shop,
// user, supplier and principal, among others) -- `principal` is the Brand
// Portal kind, with a different login than the seller sign-in `seller` (a
// shop authorization) opens. A Brand Portal account sent through the seller
// login has no shop to authorize and gets "no supported resources available
// for this authorize/deauthorize operation". The Brand app can therefore be
// pointed at its own link via SHOPEE_BRAND_AUTH_BASE / SHOPEE_BRAND_AUTH_TYPE;
// unset (e.g. sandbox, where any test shop account is accepted) it falls back
// to the main app's link and `seller`, exactly as before.
const MAIN_CREDENTIALS = {
  partnerId: SHOPEE_PARTNER_ID,
  partnerKey: SHOPEE_PARTNER_KEY,
  redirectUri: SHOPEE_REDIRECT_URI,
  authBase: SHOPEE_AUTH_BASE,
  authType: 'seller',
};
// TEMPORARY (client-requested 2026-10-04): the Brand Portal app's Partner ID
// is fixed here instead of read from SHOPEE_BRAND_PARTNER_ID, because the
// Brand Portal login could not be completed with the configured one. Only the
// ID is fixed -- the signing key still comes from SHOPEE_BRAND_PARTNER_KEY, so
// that key must belong to this same Partner ID or every signed Brand call
// (the token exchange included) will be refused as a bad signature. To go back
// to the setting, replace this with SHOPEE_BRAND_PARTNER_ID.
const BRAND_PARTNER_ID_FIXED = '1025507';
const BRAND_CREDENTIALS = {
  partnerId: BRAND_PARTNER_ID_FIXED,
  partnerKey: SHOPEE_BRAND_PARTNER_KEY,
  redirectUri: SHOPEE_BRAND_REDIRECT_URI,
  authBase: SHOPEE_BRAND_AUTH_BASE || SHOPEE_AUTH_BASE,
  authType: SHOPEE_BRAND_AUTH_TYPE || 'seller',
};

function buildAuthUrl(creds = MAIN_CREDENTIALS) {
  const url = new URL(creds.authBase);

  // Live host: the classic v2 authorization link, which (unlike the
  // sandbox's newer auth page below) requires a signed URL -- confirmed
  // against the live host, which answered an unsigned link with
  // {"error":"error_param","message":"no timestamp."}. Sign string is
  // partner_id + path + timestamp, same as every other public v2 call, and
  // the return URL goes in `redirect` rather than `redirect_uri`. The
  // timestamp is built per call (this runs at click time, see
  // routes/auth.js), so the link is always fresh.
  if (url.pathname === '/api/v2/shop/auth_partner') {
    const timestamp = Math.floor(Date.now() / 1000);
    url.searchParams.set('partner_id', creds.partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', signPublic(creds.partnerId, url.pathname, timestamp, creds.partnerKey));
    url.searchParams.set('redirect', creds.redirectUri);
    return url.toString();
  }

  url.searchParams.set('partner_id', creds.partnerId);
  url.searchParams.set('auth_type', creds.authType);
  url.searchParams.set('redirect_uri', creds.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', crypto.randomBytes(8).toString('hex'));
  return url.toString();
}

// idParams: whichever id Shopee's redirect carried, forwarded as-is --
// `shop_id` for a shop account, `main_account_id` for a main account (never
// both), and possibly others for the other authorization kinds (e.g. a
// principal). Already numeric; see routes/auth.js's ID_PARAMS. A response
// for a main account lists the authorized shops in shop_id_list instead of
// the caller already knowing which one.
async function exchangeToken(code, idParams = {}, creds = MAIN_CREDENTIALS) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(creds.partnerId, path, timestamp, creds.partnerKey);
  const url = `${SHOPEE_API_BASE}${path}?partner_id=${creds.partnerId}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      partner_id: Number(creds.partnerId),
      ...idParams,
    }),
  });

  return res.json();
}

async function getShopInfo(accessToken, shopId) {
  const path = '/api/v2/shop/get_shop_info';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(SHOPEE_PARTNER_ID, path, timestamp, accessToken, shopId, SHOPEE_PARTNER_KEY);
  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&shop_id=${shopId}&access_token=${accessToken}`;

  const res = await fetch(url);
  return res.json();
}

async function refreshToken(refreshTokenValue, shopId, creds = MAIN_CREDENTIALS) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(creds.partnerId, path, timestamp, creds.partnerKey);
  const url = `${SHOPEE_API_BASE}${path}?partner_id=${creds.partnerId}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshTokenValue,
      shop_id: Number(shopId),
      partner_id: Number(creds.partnerId),
    }),
  });

  return res.json();
}

async function getOrderList(accessToken, shopId, { timeFrom, timeTo, orderStatus, pageSize = 50, cursor = '' }) {
  const path = '/api/v2/order/get_order_list';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(SHOPEE_PARTNER_ID, path, timestamp, accessToken, shopId, SHOPEE_PARTNER_KEY);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    access_token: accessToken,
    time_range_field: 'create_time',
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: String(pageSize),
    cursor,
  });
  if (orderStatus) params.set('order_status', orderStatus);

  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  return res.json();
}

async function getOrderDetail(accessToken, shopId, orderSnList, fields = 'item_list,buyer_username,order_status') {
  const path = '/api/v2/order/get_order_detail';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(SHOPEE_PARTNER_ID, path, timestamp, accessToken, shopId, SHOPEE_PARTNER_KEY);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    access_token: accessToken,
    order_sn_list: orderSnList.join(','),
    response_optional_fields: fields,
  });

  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  return res.json();
}

function shopSignedParams(path, accessToken, shopId, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(SHOPEE_PARTNER_ID, path, timestamp, accessToken, shopId, SHOPEE_PARTNER_KEY);
  return new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    access_token: accessToken,
    ...extra,
  });
}

async function shopGet(path, accessToken, shopId, extra = {}) {
  const params = shopSignedParams(path, accessToken, shopId, extra);
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  return res.json();
}

async function shopPost(path, accessToken, shopId, body) {
  const params = shopSignedParams(path, accessToken, shopId);
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function getShippingParameter(accessToken, shopId, orderSn) {
  return shopGet('/api/v2/logistics/get_shipping_parameter', accessToken, shopId, { order_sn: orderSn });
}

function getChannelList(accessToken, shopId) {
  return shopGet('/api/v2/logistics/get_channel_list', accessToken, shopId);
}

// Workaround for order/get_order_detail returning an empty order_list for
// every recently-created order in this sandbox shop (confirmed against
// Shopee support evidence) — this endpoint reliably returns the same
// item_list data keyed by package_number instead of order_sn, once a
// package exists for the order (i.e. after ship_order has been called).
function getPackageDetail(accessToken, shopId, packageNumberList) {
  return shopGet('/api/v2/order/get_package_detail', accessToken, shopId, {
    package_number_list: packageNumberList.join(','),
  });
}

// Returns item ids only — item names/prices/stock/SKUs come from a separate
// get_item_base_info call, and variant-level SKUs from get_model_list.
function getItemList(accessToken, shopId, { offset = 0, pageSize = 50, itemStatus = 'NORMAL' } = {}) {
  return shopGet('/api/v2/product/get_item_list', accessToken, shopId, {
    offset: String(offset),
    page_size: String(pageSize),
    item_status: itemStatus,
  });
}

// Shopee caps this at 50 item ids per call.
function getItemBaseInfo(accessToken, shopId, itemIdList) {
  return shopGet('/api/v2/product/get_item_base_info', accessToken, shopId, {
    item_id_list: itemIdList.join(','),
  });
}

function getModelList(accessToken, shopId, itemId) {
  return shopGet('/api/v2/product/get_model_list', accessToken, shopId, { item_id: itemId });
}

function getMassShippingParameter(accessToken, shopId, packageNumbers) {
  return shopPost('/api/v2/logistics/get_mass_shipping_parameter', accessToken, shopId, {
    package_list: packageNumbers.map((package_number) => ({ package_number })),
  });
}

function massShipOrder(accessToken, shopId, body) {
  return shopPost('/api/v2/logistics/mass_ship_order', accessToken, shopId, body);
}

function getEscrowDetail(accessToken, shopId, orderSn) {
  return shopGet('/api/v2/payment/get_escrow_detail', accessToken, shopId, { order_sn: orderSn });
}

// performanceDate in DD-MM-YYYY (see wib.js's dateStringDDMMYYYYWIB) — must
// be today or up to 6 months ago; today can only be queried via this hourly
// endpoint, not the daily one (which requires start_date != end_date).
function getAllCpcAdsHourlyPerformance(accessToken, shopId, performanceDate) {
  return shopGet('/api/v2/ads/get_all_cpc_ads_hourly_performance', accessToken, shopId, { performance_date: performanceDate });
}

function getTrackingNumber(accessToken, shopId, orderSn) {
  return shopGet('/api/v2/logistics/get_tracking_number', accessToken, shopId, { order_sn: orderSn });
}

function shipOrder(accessToken, shopId, body) {
  return shopPost('/api/v2/logistics/ship_order', accessToken, shopId, body);
}

// Client-requested (2026-09-25): a real seller-initiated cancellation, not
// just hiding the order locally — omitting item_list cancels the whole
// order rather than specific line items. 'OUT_OF_STOCK' is the standard
// reason Shopee accepts for a seller cancelling a READY_TO_SHIP order with
// no buyer-initiated request behind it; there's no UI to pick a different
// reason since the Order Detail popup only exposes one Cancel action.
function cancelOrder(accessToken, shopId, orderSn, cancelReason = 'OUT_OF_STOCK') {
  return shopPost('/api/v2/order/cancel_order', accessToken, shopId, {
    order_sn: orderSn,
    cancel_reason: cancelReason,
  });
}

// shippingDocumentType (optional) picks which template Shopee renders —
// omitted, it falls back to whatever that courier's own default is (see
// get_shipping_document_parameter below), which is why labels used to come
// out in inconsistent layouts/sizes across couriers.
function createShippingDocument(accessToken, shopId, orderSn, trackingNumber, shippingDocumentType) {
  const order = { order_sn: orderSn, tracking_number: trackingNumber };
  if (shippingDocumentType) order.shipping_document_type = shippingDocumentType;
  return shopPost('/api/v2/logistics/create_shipping_document', accessToken, shopId, {
    order_list: [order],
  });
}

// Tells us, per order, which shipping_document_type values that specific
// courier actually supports (selectable_shipping_document_type) and which
// one Shopee would use by default if none is specified
// (suggest_shipping_document_type) — checked before create_shipping_document
// so we can force a consistent type instead of drifting per-courier.
function getShippingDocumentParameter(accessToken, shopId, orderSn, trackingNumber) {
  return shopPost('/api/v2/logistics/get_shipping_document_parameter', accessToken, shopId, {
    order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }],
  });
}

function getShippingDocumentResult(accessToken, shopId, orderSn, trackingNumber) {
  return shopPost('/api/v2/logistics/get_shipping_document_result', accessToken, shopId, {
    order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }],
  });
}

// shippingDocumentType (optional, top-level per Shopee's schema — not per
// order_list entry) — must match whichever type create_shipping_document
// actually generated for this tracking number, or Shopee doesn't know which
// of possibly several generated documents to hand back.
async function downloadShippingDocument(accessToken, shopId, orderSn, trackingNumber, shippingDocumentType) {
  const path = '/api/v2/logistics/download_shipping_document';
  const params = shopSignedParams(path, accessToken, shopId);
  const body = { order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }] };
  if (shippingDocumentType) body.shipping_document_type = shippingDocumentType;
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { pdf: buffer };
}

module.exports = {
  BRAND_CREDENTIALS,
  buildAuthUrl,
  exchangeToken,
  getShopInfo,
  refreshToken,
  getOrderList,
  getOrderDetail,
  getShippingParameter,
  getChannelList,
  getPackageDetail,
  getEscrowDetail,
  getAllCpcAdsHourlyPerformance,
  getItemList,
  getItemBaseInfo,
  getModelList,
  getMassShippingParameter,
  massShipOrder,
  getTrackingNumber,
  shipOrder,
  cancelOrder,
  createShippingDocument,
  getShippingDocumentParameter,
  getShippingDocumentResult,
  downloadShippingDocument,
};
