const crypto = require('crypto');

// Shopee signs push callbacks with HMAC-SHA256 over "<callback_url>|<raw_body>",
// keyed with the app's Partner Key, hex-encoded, sent in the Authorization
// header — a different scheme from sign.js's outbound request signing (which
// signs partner_id+path+timestamp[+token+shop_id], not a URL+body pair).
// callbackUrl must be the exact URL registered/verified in the Partner
// Console's "Set Push" screen, not whatever the request happened to arrive on.
function verifyPushSignature(callbackUrl, rawBody, partnerKey, signatureHeader) {
  if (!callbackUrl || !partnerKey || !signatureHeader) return false;

  const expected = crypto
    .createHmac('sha256', partnerKey)
    .update(`${callbackUrl}|${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = { verifyPushSignature };
