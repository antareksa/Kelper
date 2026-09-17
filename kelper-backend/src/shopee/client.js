const crypto = require('crypto');
const { signPublic, signShop } = require('./sign');

const {
  SHOPEE_PARTNER_ID,
  SHOPEE_PARTNER_KEY,
  SHOPEE_REDIRECT_URI,
  SHOPEE_AUTH_BASE,
  SHOPEE_API_BASE,
} = process.env;

function buildAuthUrl() {
  const url = new URL(SHOPEE_AUTH_BASE);
  url.searchParams.set('partner_id', SHOPEE_PARTNER_ID);
  url.searchParams.set('auth_type', 'seller');
  url.searchParams.set('redirect_uri', SHOPEE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', crypto.randomBytes(8).toString('hex'));
  return url.toString();
}

async function exchangeToken(code, shopId) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(SHOPEE_PARTNER_ID, path, timestamp, SHOPEE_PARTNER_KEY);
  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: Number(shopId),
      partner_id: Number(SHOPEE_PARTNER_ID),
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

async function refreshToken(refreshTokenValue, shopId) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signPublic(SHOPEE_PARTNER_ID, path, timestamp, SHOPEE_PARTNER_KEY);
  const url = `${SHOPEE_API_BASE}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshTokenValue,
      shop_id: Number(shopId),
      partner_id: Number(SHOPEE_PARTNER_ID),
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

function getTrackingNumber(accessToken, shopId, orderSn) {
  return shopGet('/api/v2/logistics/get_tracking_number', accessToken, shopId, { order_sn: orderSn });
}

function shipOrder(accessToken, shopId, body) {
  return shopPost('/api/v2/logistics/ship_order', accessToken, shopId, body);
}

function createShippingDocument(accessToken, shopId, orderSn, trackingNumber) {
  return shopPost('/api/v2/logistics/create_shipping_document', accessToken, shopId, {
    order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }],
  });
}

function getShippingDocumentResult(accessToken, shopId, orderSn, trackingNumber) {
  return shopPost('/api/v2/logistics/get_shipping_document_result', accessToken, shopId, {
    order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }],
  });
}

async function downloadShippingDocument(accessToken, shopId, orderSn, trackingNumber) {
  const path = '/api/v2/logistics/download_shipping_document';
  const params = shopSignedParams(path, accessToken, shopId);
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_list: [{ order_sn: orderSn, tracking_number: trackingNumber }] }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { pdf: buffer };
}

module.exports = {
  buildAuthUrl,
  exchangeToken,
  getShopInfo,
  refreshToken,
  getOrderList,
  getOrderDetail,
  getShippingParameter,
  getChannelList,
  getPackageDetail,
  getItemList,
  getItemBaseInfo,
  getModelList,
  getMassShippingParameter,
  massShipOrder,
  getTrackingNumber,
  shipOrder,
  createShippingDocument,
  getShippingDocumentResult,
  downloadShippingDocument,
};
