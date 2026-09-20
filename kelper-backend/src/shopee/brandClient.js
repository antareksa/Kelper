const { signShop } = require('./sign');
const { BRAND_CREDENTIALS } = require('./client');

const { SHOPEE_API_BASE } = process.env;

// Brand Portal's "principal"-namespaced APIs (get_shop_affiliate_performance
// and friends) sign like any other shop-level call (partner_id+path+
// timestamp+access_token+shop_id — confirmed empirically against the real
// sandbox, since the docs' Common Request Parameters section didn't spell
// this out) but ALSO require principal_id as a separate query param. For a
// single-shop Brand Portal authorization (this app only ever connects one
// shop at a time — see ShopeeBrandAuth), principal_id is just that same
// shop_id; a multi-shop Brand Portal account would have a distinct
// principal_id, which this integration doesn't support.
async function getShopAffiliatePerformance(accessToken, shopId, { startDate, endDate, timezone = 'GMT+7', granularity = 'day' }) {
  const path = '/api/v2/principal/get_shop_affiliate_performance';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(BRAND_CREDENTIALS.partnerId, path, timestamp, accessToken, shopId, BRAND_CREDENTIALS.partnerKey);
  const params = new URLSearchParams({
    partner_id: BRAND_CREDENTIALS.partnerId,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    principal_id: shopId,
    access_token: accessToken,
  });

  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate, timezone, granularity }),
  });
  return res.json();
}

// Same request/signing shape as getShopAffiliatePerformance above (see its
// comment) — different path, same principal_id-as-shop_id assumption for a
// single-shop Brand Portal authorization. Used for Pengunjung (unique_visitors
// in the response), though it also carries much richer sales/conversion
// data we aren't using yet.
async function getShopSalesPerformanceDetail(accessToken, shopId, { startDate, endDate, timezone = 'GMT+7', granularity = 'day' }) {
  const path = '/api/v2/principal/get_shop_sales_performance_detail';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(BRAND_CREDENTIALS.partnerId, path, timestamp, accessToken, shopId, BRAND_CREDENTIALS.partnerKey);
  const params = new URLSearchParams({
    partner_id: BRAND_CREDENTIALS.partnerId,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    principal_id: shopId,
    access_token: accessToken,
  });

  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate, timezone, granularity }),
  });
  return res.json();
}

module.exports = { getShopAffiliatePerformance, getShopSalesPerformanceDetail };
