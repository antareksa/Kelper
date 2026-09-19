const express = require('express');
const { verifyPushSignature } = require('../shopee/pushAuth');
const { syncAndLabelOrders } = require('../shopeeSync');

const router = express.Router();

// Receives Shopee's Push Mechanism callbacks (order/product/marketing/chat
// events) — mounted in server.js with express.raw() ahead of the app-wide
// express.json(), since signature verification needs the exact raw request
// bytes, not a reserialized JSON object (key ordering could differ).
router.post('/shopee', (req, res) => {
  const rawBody = req.body.toString('utf8');
  const { SHOPEE_PARTNER_KEY, SHOPEE_PUSH_CALLBACK_URL } = process.env;
  const signature = req.get('Authorization');

  if (!verifyPushSignature(SHOPEE_PUSH_CALLBACK_URL, rawBody, SHOPEE_PARTNER_KEY, signature)) {
    console.error('[webhook] rejected push: signature mismatch (check SHOPEE_PUSH_CALLBACK_URL matches the Partner Console exactly)');
    return res.status(401).end();
  }

  // Ack immediately: Shopee requires HTTP 2xx within 3s and auto-disables
  // the whole push subscription (with no backfill) after enough slow/failed
  // responses, so nothing below this line may delay or fail the response.
  res.status(200).end();

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('[webhook] push body was not valid JSON after signature check passed');
    return;
  }

  const shopId = payload.shop_id;
  if (!shopId) return;

  console.log(`[webhook] push code=${payload.code} shop=${shopId} — triggering immediate sync`);
  // Reuses the exact same discover+book+label logic the 30s poll loop already
  // runs — idempotent, and already gated on the syncEnabled pause toggle
  // inside syncAndLabelOrders, so a push arriving while fetching is paused
  // is a no-op here too. The poll loop itself is untouched: Shopee's own
  // guidance is to treat push as a supplement, not a replacement, since
  // messages can be delayed, duplicated, or (during an outage) dropped
  // entirely with no backfill.
  syncAndLabelOrders(shopId).catch((err) => {
    console.error(`[webhook] sync triggered by push failed: ${err.message}`);
  });
});

module.exports = router;
