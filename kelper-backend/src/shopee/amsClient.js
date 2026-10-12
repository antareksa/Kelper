const { signShop } = require('./sign');
const { BRAND_CREDENTIALS } = require('./client');

const { SHOPEE_API_BASE } = process.env;

// Shopee's Affiliate Marketing Solution (AMS) API -- the source of the Dashboard's
// "Affiliasi" numbers (client-decided 2026-10-12; it replaced the Brand Portal
// "principal" API, which could not be authorized for this shop).
//
// AMS is only open to a Shopee app of the type "Affiliate Marketing Solution
// Management", so it runs on the app configured in the SHOPEE_BRAND_* variables
// (the "second app": its own credentials and its own token table, see
// shopee_brand_tokens in db.js). Despite the old names, that second app is now the
// AMS app. Authorization is the ordinary seller/shop one, like the main app's.
//
// get_affiliate_performance answers PER AFFILIATE (sales, items_sold, orders, clicks,
// est_commission, roi, total_buyers, new_buyers), at most 20 per page. The caller adds
// the pages up to get the shop's total (see shopeeSync.js's fetchAffiliatePerformance).
//
// `date` is a single day as YYYYMMDD. period_type "Day" needs start_date = end_date, a
// day in the past three months and already reported (Shopee's data runs a day behind).
async function getAffiliatePerformance(accessToken, shopId, { date, pageNo = 1, pageSize = 20, orderType = 'ConfirmedOrder', channel = 'AllChannel' }) {
  const path = '/api/v2/ams/get_affiliate_performance';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signShop(BRAND_CREDENTIALS.partnerId, path, timestamp, accessToken, shopId, BRAND_CREDENTIALS.partnerKey);
  const params = new URLSearchParams({
    partner_id: BRAND_CREDENTIALS.partnerId,
    timestamp: String(timestamp),
    sign,
    shop_id: String(shopId),
    access_token: accessToken,
    period_type: 'Day',
    start_date: date,
    end_date: date,
    page_no: String(pageNo),
    page_size: String(pageSize),
    order_type: orderType,
    channel,
  });
  const res = await fetch(`${SHOPEE_API_BASE}${path}?${params.toString()}`);
  return res.json();
}

module.exports = { getAffiliatePerformance };
