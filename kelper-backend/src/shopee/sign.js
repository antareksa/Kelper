const crypto = require('crypto');

function hmac(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// Public/partner-level endpoints (no shop access_token yet), e.g. auth/token/get
function signPublic(partnerId, path, timestamp, partnerKey) {
  return hmac(partnerKey, `${partnerId}${path}${timestamp}`);
}

// Shop-level endpoints, signed string also includes access_token + shop_id
function signShop(partnerId, path, timestamp, accessToken, shopId, partnerKey) {
  return hmac(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`);
}

module.exports = { signPublic, signShop };
