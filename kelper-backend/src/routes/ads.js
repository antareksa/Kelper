const express = require('express');
const {
  getRoasSettings,
  saveRoasSettings,
  weekRanges,
  syncAdsCampaigns,
  setCampaignRunning,
  setItemAutoRoas,
  listCampaigns,
  listLog,
} = require('../roasAuto');

// The Iklan page: per-item ad campaigns, the Iklan / Auto ROAS switches, the
// weekly ROAS rule's settings and its log (see roasAuto.js). Full admins only:
// a Packing Station admin is refused by adminSession.js's allow-list.
const router = express.Router();

function shopIdFrom(req, res) {
  const shopId = Number(req.query.shop_id || req.body?.shop_id);
  if (!shopId) {
    res.status(400).json({ error: 'shop_id_required', message: 'shop_id is required' });
    return null;
  }
  return shopId;
}

router.get('/campaigns', (req, res) => {
  const shopId = shopIdFrom(req, res);
  if (!shopId) return;
  res.json({ settings: getRoasSettings(), weeks: weekRanges(), campaigns: listCampaigns(shopId) });
});

// "Sinkron dari Shopee": re-reads the campaigns now instead of waiting up to 30 min.
router.post('/sync', async (req, res) => {
  const shopId = shopIdFrom(req, res);
  if (!shopId) return;
  try {
    const error = await syncAdsCampaigns(shopId, { force: true });
    if (error) return res.status(502).json({ error: 'shopee_error', message: error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: err.message });
  }
});

router.post('/settings', (req, res) => {
  const { mode, bandPct, step, floor, ceiling } = req.body || {};
  const error = saveRoasSettings({ mode, bandPct, step, floor, ceiling });
  if (error) return res.status(400).json({ error: 'invalid_settings', message: error });
  res.json(getRoasSettings());
});

// Iklan on/off: { running: true | false } pauses or resumes the campaign on Shopee.
router.post('/campaigns/:campaignId/running', async (req, res) => {
  const shopId = shopIdFrom(req, res);
  if (!shopId) return;
  try {
    const error = await setCampaignRunning(shopId, Number(req.params.campaignId), !!req.body.running, req.adminUsername);
    if (error) return res.status(400).json({ error: 'edit_failed', message: error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'edit_failed', message: err.message });
  }
});

// Auto ROAS on/off: { enabled: true | false }. Local only, nothing is sent to Shopee.
router.post('/items/:itemId/auto-roas', (req, res) => {
  const shopId = shopIdFrom(req, res);
  if (!shopId) return;
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'invalid_item', message: 'Item tidak dikenal.' });
  setItemAutoRoas(shopId, itemId, !!req.body.enabled, req.adminUsername);
  res.json({ ok: true });
});

router.get('/log', (req, res) => {
  const shopId = shopIdFrom(req, res);
  if (!shopId) return;
  res.json({ log: listLog(shopId, Math.min(500, Number(req.query.limit) || 100)) });
});

module.exports = router;
