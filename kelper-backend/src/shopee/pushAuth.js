const crypto = require('crypto');

// Shopee signs push callbacks with HMAC-SHA256 over "<callback_url>|<raw_body>",
// keyed with the app's Partner Key, hex-encoded, sent in the Authorization
// header — a different scheme from sign.js's outbound request signing (which
// signs partner_id+path+timestamp[+token+shop_id], not a URL+body pair).
// callbackUrl must be the exact URL registered/verified in the Partner
// Console's "Set Push" screen, not whatever the request happened to arrive on.
//
// partnerKeys accepts one key or several: the Partner Console's "Get Test
// Push" verification handshake signs with a separate "Test Push Partner
// Key", not the app's real Partner Key used for actual live pushes — so the
// caller passes both candidates and this matches against either.
function verifyPushSignature(callbackUrl, rawBody, partnerKeys, signatureHeader) {
  if (!callbackUrl || !signatureHeader) return false;
  const keys = (Array.isArray(partnerKeys) ? partnerKeys : [partnerKeys]).filter(Boolean);
  if (keys.length === 0) return false;

  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  return keys.some((key) => {
    const expected = crypto.createHmac('sha256', key).update(`${callbackUrl}|${rawBody}`).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
  });
}

module.exports = { verifyPushSignature };
