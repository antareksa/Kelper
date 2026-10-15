// Client-requested (2026-10-15): weekly per-item ROAS target adjustment, plus an
// Iklan on/off and an Auto ROAS on/off switch per item. Full rules and the
// decisions behind them: docs/FEATURE-gms-roas-auto-adjust.md.
//
// Every Monday from 00:05 WIB, for each product-level campaign with exactly one
// item: compare that item's (Laba - ad spend) over last week (Mon-Sun) with the
// week before. Up more than bandPct -> lower the ROAS target by step (spend
// more), down more than bandPct -> raise it (spend less), otherwise no change;
// always kept within [floor, ceiling]. The current target is read from Shopee
// right before, so a change made in Seller Centre is respected.
//
// Mode (setting roasAutoMode): 'off' = no weekly run, 'preview' = the run only
// logs what it WOULD change (the default, so the first weeks can be checked),
// 'live' = it really changes the target on Shopee. The toggles always act.
//
// Campaigns are edited with edit_manual_product_ads: a campaign whose product is
// chosen by hand (ad_type 'manual', exactly one item). edit_gms_product_campaign
// is NOT used -- that is Shopee's single shop-wide GMV Max campaign.
const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const { getValidAccessToken } = require('./shopee/tokenStore');
const {
  getProductLevelCampaignIdList,
  getProductLevelCampaignSettingInfo,
  getProductCampaignDailyPerformance,
  editManualProductAds,
} = require('./shopee/client');
const { dateStringWIB, shiftDateStringWIB, startOfDateWIB } = require('./wib');

const SYNC_INTERVAL_SECONDS = 30 * 60;
const DAILY_LOOKBACK_DAYS = 15; // two full weeks plus today
const RUN_MINUTE_AFTER_MIDNIGHT = 5; // Monday 00:05 WIB

const DEFAULTS = { mode: 'preview', bandPct: 10, step: 0.5, floor: 1, ceiling: 10 };

function now() {
  return Math.floor(Date.now() / 1000);
}

function getRoasSettings() {
  return {
    mode: getSetting('roasAutoMode', DEFAULTS.mode),
    bandPct: Number(getSetting('roasAutoBandPct', DEFAULTS.bandPct)),
    step: Number(getSetting('roasAutoStep', DEFAULTS.step)),
    floor: Number(getSetting('roasAutoFloor', DEFAULTS.floor)),
    ceiling: Number(getSetting('roasAutoCeiling', DEFAULTS.ceiling)),
  };
}

// Returns an error message, or null after saving.
function saveRoasSettings(input) {
  const next = { ...getRoasSettings(), ...input };
  if (!['off', 'preview', 'live'].includes(next.mode)) return 'Mode tidak dikenal.';
  for (const key of ['bandPct', 'step', 'floor', 'ceiling']) {
    next[key] = Number(next[key]);
    if (!Number.isFinite(next[key]) || next[key] <= 0) return 'Semua angka harus lebih dari 0.';
  }
  if (next.floor >= next.ceiling) return 'Batas bawah harus lebih kecil dari batas atas.';
  setSetting('roasAutoMode', next.mode);
  setSetting('roasAutoBandPct', next.bandPct);
  setSetting('roasAutoStep', next.step);
  setSetting('roasAutoFloor', next.floor);
  setSetting('roasAutoCeiling', next.ceiling);
  return null;
}

// Monday (YYYY-MM-DD, WIB) of the current week, and the two full weeks before
// it: thisWeek = last Mon-Sun, lastWeek = the Mon-Sun before that. end is
// exclusive (the next Monday).
function weekRanges() {
  const today = dateStringWIB(0);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = shiftDateStringWIB(today, -((dow + 6) % 7));
  return {
    monday,
    thisWeek: { start: shiftDateStringWIB(monday, -7), end: monday },
    lastWeek: { start: shiftDateStringWIB(monday, -14), end: shiftDateStringWIB(monday, -7) },
  };
}

const ddmmyyyy = (ymd) => ymd.split('-').reverse().join('-');
const ymdFromDdmmyyyy = (dmy) => String(dmy).split('-').reverse().join('-');
const round1 = (n) => Math.round(n * 10) / 10;

function parseItemIds(campaign) {
  try {
    return JSON.parse(campaign.item_ids || '[]');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sync from Shopee

const upsertCampaign = db.prepare(`
  INSERT INTO ads_campaigns (campaign_id, shop_id, ad_name, ad_type, bidding_method, campaign_status, roas_target, item_ids, start_time, synced_at)
  VALUES (@campaign_id, @shop_id, @ad_name, @ad_type, @bidding_method, @campaign_status, @roas_target, @item_ids, @start_time, @synced_at)
  ON CONFLICT(campaign_id) DO UPDATE SET
    shop_id = excluded.shop_id, ad_name = excluded.ad_name, ad_type = excluded.ad_type,
    bidding_method = excluded.bidding_method, campaign_status = excluded.campaign_status,
    roas_target = excluded.roas_target, item_ids = excluded.item_ids,
    start_time = excluded.start_time, synced_at = excluded.synced_at
`);
const upsertDaily = db.prepare(`
  INSERT INTO ads_campaign_daily (campaign_id, date, expense, broad_gmv, direct_gmv, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(campaign_id, date) DO UPDATE SET
    expense = excluded.expense, broad_gmv = excluded.broad_gmv, direct_gmv = excluded.direct_gmv, fetched_at = excluded.fetched_at
`);
const markPausedToday = db.prepare(`
  INSERT INTO ads_campaign_daily (campaign_id, date, paused_seen, fetched_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(campaign_id, date) DO UPDATE SET paused_seen = 1
`);

const syncAttemptAt = new Map(); // shopId -> unix seconds of the last attempt
function resetAdsSyncThrottle() { syncAttemptAt.clear(); weeklyFailedAt.clear(); } // for tests

// Reads every product-level campaign, its settings and its daily figures for
// the last DAILY_LOOKBACK_DAYS. At most every SYNC_INTERVAL_SECONDS unless
// forced; a failed attempt also waits. Returns an error message or null.
async function syncAdsCampaigns(shopId, { force = false } = {}) {
  const last = syncAttemptAt.get(shopId);
  if (!force && last && now() - last < SYNC_INTERVAL_SECONDS) return null;
  syncAttemptAt.set(shopId, now());
  const accessToken = await getValidAccessToken(shopId);

  const campaignIds = [];
  for (let page = 0, offset = 0; page < 50; page++) {
    const result = await getProductLevelCampaignIdList(accessToken, shopId, { offset, limit: 100 });
    if (result.error) return `get_product_level_campaign_id_list: ${result.message || result.error}`;
    const list = result.response?.campaign_list || [];
    campaignIds.push(...list.map((c) => c.campaign_id));
    if (!result.response?.has_next_page || list.length === 0) break;
    offset += list.length;
  }

  const syncedAt = now();
  const today = dateStringWIB(0);
  for (let i = 0; i < campaignIds.length; i += 100) {
    const result = await getProductLevelCampaignSettingInfo(accessToken, shopId, campaignIds.slice(i, i + 100));
    if (result.error) return `get_product_level_campaign_setting_info: ${result.message || result.error}`;
    db.transaction(() => {
      for (const c of result.response?.campaign_list || []) {
        const info = c.common_info || {};
        upsertCampaign.run({
          campaign_id: c.campaign_id,
          shop_id: shopId,
          ad_name: info.ad_name ?? null,
          ad_type: info.ad_type ?? null,
          bidding_method: info.bidding_method ?? null,
          campaign_status: info.campaign_status ?? null,
          roas_target: c.auto_bidding_info?.roas_target ?? null,
          item_ids: JSON.stringify(info.item_id_list || []),
          start_time: info.campaign_duration?.start_time ?? null,
          synced_at: syncedAt,
        });
        if (info.campaign_status && info.campaign_status !== 'ongoing') markPausedToday.run(c.campaign_id, today, syncedAt);
      }
    })();
  }
  // A campaign Shopee no longer lists (deleted) is dropped; its log stays.
  db.prepare('DELETE FROM ads_campaigns WHERE shop_id = ? AND synced_at < ?').run(shopId, syncedAt);

  const start = ddmmyyyy(dateStringWIB(DAILY_LOOKBACK_DAYS));
  const end = ddmmyyyy(today);
  for (let i = 0; i < campaignIds.length; i += 100) {
    const result = await getProductCampaignDailyPerformance(accessToken, shopId, start, end, campaignIds.slice(i, i + 100));
    if (result.error) return `get_product_campaign_daily_performance: ${result.message || result.error}`;
    const shops = Array.isArray(result.response) ? result.response : [result.response || {}];
    db.transaction(() => {
      for (const shop of shops) {
        for (const c of shop.campaign_list || []) {
          for (const m of c.metrics_list || []) {
            upsertDaily.run(c.campaign_id, ymdFromDdmmyyyy(m.date), m.expense ?? 0, m.broad_gmv ?? 0, m.direct_gmv ?? 0, syncedAt);
          }
        }
      }
    })();
  }
  return null;
}

// ---------------------------------------------------------------------------
// The weekly figure: item Laba - ad spend

// Every SKU an item's orders can carry: its own SKU, its variants' SKUs, and the
// ITEM-<id> fallback shopeeSync.js stores for an item without one.
function skusForItem(itemId) {
  const item = db.prepare('SELECT item_sku FROM shopee_items WHERE item_id = ?').get(itemId);
  const models = db.prepare('SELECT model_sku FROM shopee_item_models WHERE item_id = ?').all(itemId);
  const skus = new Set([`ITEM-${itemId}`]);
  if (item?.item_sku) skus.add(item.item_sku);
  for (const m of models) if (m.model_sku) skus.add(m.model_sku);
  return [...skus];
}

// Laba the same way the Dashboard counts it (routes/dashboard.js): orders on the
// day they were scanned picked up, price/HPP from the snapshot taken then, else
// the current List Barang price/HPP; an item without HPP adds nothing.
function itemLabaBetween(shopId, itemId, startTs, endTs) {
  const skus = skusForItem(itemId);
  const placeholders = skus.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT oi.qty, oi.price_snapshot, oi.hpp_snapshot, p.price, p.hpp
      FROM order_items oi
      JOIN orders o ON o.order_sn = oi.order_sn
      JOIN (
        SELECT order_sn, MAX(completed_at) AS completed_at FROM packing_sessions WHERE status = 'DONE' GROUP BY order_sn
      ) ps ON ps.order_sn = o.order_sn
      LEFT JOIN products p ON p.sku = oi.sku
      WHERE o.shop_id = ? AND o.order_sn NOT LIKE 'MOCK-%' AND ps.completed_at >= ? AND ps.completed_at < ?
        AND oi.sku IN (${placeholders})
    `)
    .all(shopId, startTs, endTs, ...skus);
  let laba = 0;
  for (const r of rows) {
    const price = r.price_snapshot != null ? r.price_snapshot : r.price;
    const hpp = r.hpp_snapshot ?? r.hpp;
    if (price != null && hpp != null) laba += (price - hpp) * r.qty;
  }
  return { laba, orderLines: rows.length };
}

function weekFigure(shopId, campaign, itemId, range) {
  const { laba, orderLines } = itemLabaBetween(shopId, itemId, startOfDateWIB(range.start), startOfDateWIB(range.end));
  const daily = db
    .prepare(`
      SELECT COALESCE(SUM(expense), 0) AS expense, COUNT(expense) AS days, MAX(paused_seen) AS paused
      FROM ads_campaign_daily WHERE campaign_id = ? AND date >= ? AND date < ?
    `)
    .get(campaign.campaign_id, range.start, range.end);
  const tax = Number(getSetting('adsTaxPercentage', '0'));
  const adSpend = daily.expense * (1 + tax / 100);
  return {
    value: laba - adSpend,
    laba,
    adSpend,
    hasData: orderLines > 0 || daily.days > 0,
    paused: !!daily.paused,
  };
}

// Why a campaign is left out of the automation entirely, or null if it is managed.
function ineligibleReason(campaign) {
  const itemIds = parseItemIds(campaign);
  if (itemIds.length !== 1) return 'dilewati: lebih dari 1 produk';
  if (campaign.ad_type !== 'manual') return 'dilewati: produk dipilih otomatis oleh Shopee';
  if (campaign.bidding_method !== 'auto' || !(campaign.roas_target > 0)) return 'dilewati: bukan Custom ROAS';
  return null;
}

// What the weekly rule says for one campaign right now. Never calls Shopee.
function decide(shopId, campaign, settings, ranges = weekRanges()) {
  const base = { campaignId: campaign.campaign_id, oldTarget: campaign.roas_target, newTarget: null, thisWeek: null, lastWeek: null, changePct: null };
  const skip = (reason, extra = {}) => ({ ...base, ...extra, action: 'skip', reason });

  const notManaged = ineligibleReason(campaign);
  if (notManaged) return skip(notManaged);
  const itemId = parseItemIds(campaign)[0];
  base.itemId = itemId;

  const setting = db.prepare('SELECT auto_roas FROM ads_item_settings WHERE item_id = ?').get(itemId);
  if (setting && !setting.auto_roas) return skip('Auto ROAS off');
  if (campaign.campaign_status !== 'ongoing') return skip('iklan off');
  if (campaign.start_time && campaign.start_time > startOfDateWIB(ranges.lastWeek.start)) {
    return skip('campaign baru: belum 2 minggu penuh');
  }

  const thisWeek = weekFigure(shopId, campaign, itemId, ranges.thisWeek);
  const lastWeek = weekFigure(shopId, campaign, itemId, ranges.lastWeek);
  const numbers = { thisWeek: thisWeek.value, lastWeek: lastWeek.value };
  if (thisWeek.paused || lastWeek.paused) return skip('iklan sempat off', numbers);
  if (!lastWeek.hasData) return skip('tidak ada data minggu lalu', numbers);
  if (lastWeek.value === 0) return skip('minggu lalu 0, tidak bisa dibandingkan', numbers);

  const changePct = ((thisWeek.value - lastWeek.value) / Math.abs(lastWeek.value)) * 100;
  Object.assign(numbers, { changePct: round1(changePct) });
  let target;
  if (changePct > settings.bandPct) target = campaign.roas_target - settings.step;
  else if (changePct < -settings.bandPct) target = campaign.roas_target + settings.step;
  else return skip(`perubahan dalam ±${settings.bandPct}%`, numbers);

  target = round1(Math.min(settings.ceiling, Math.max(settings.floor, target)));
  if (target === round1(campaign.roas_target)) return skip('sudah di batas', numbers);
  return { ...base, ...numbers, action: target < campaign.roas_target ? 'lower' : 'raise', newTarget: target, reason: null };
}

const insertLog = db.prepare(`
  INSERT INTO roas_auto_log (created_at, shop_id, campaign_id, item_id, kind, mode, action, old_target, new_target, this_week, last_week, change_pct, reason, username, error)
  VALUES (@created_at, @shop_id, @campaign_id, @item_id, @kind, @mode, @action, @old_target, @new_target, @this_week, @last_week, @change_pct, @reason, @username, @error)
`);
function log(entry) {
  insertLog.run({
    created_at: now(), shop_id: null, campaign_id: null, item_id: null, mode: null, old_target: null, new_target: null,
    this_week: null, last_week: null, change_pct: null, reason: null, username: null, error: null, ...entry,
  });
}

// The weekly run for one shop. Re-reads everything from Shopee first; if that
// fails (an error answer or a thrown one, e.g. Shopee down) nothing is decided,
// the failure is logged and { error } returned. onSynced runs once the fresh data
// is in, before any change. In 'preview' mode nothing is sent to Shopee; every
// decision is logged either way.
async function runWeekly(shopId, mode, onSynced = () => {}) {
  let syncError;
  try {
    syncError = await syncAdsCampaigns(shopId, { force: true });
  } catch (err) {
    syncError = err.message;
  }
  if (syncError) {
    log({ shop_id: shopId, kind: 'weekly', mode, action: 'error', error: syncError });
    return { error: syncError };
  }
  onSynced();
  const settings = getRoasSettings();
  const ranges = weekRanges();
  const campaigns = db.prepare('SELECT * FROM ads_campaigns WHERE shop_id = ?').all(shopId);
  const accessToken = mode === 'live' ? await getValidAccessToken(shopId) : null;
  const results = [];
  for (const campaign of campaigns) {
    const d = decide(shopId, campaign, settings, ranges);
    let error = null;
    if (d.action !== 'skip' && mode === 'live') {
      try {
        const result = await editManualProductAds(accessToken, shopId, campaign.campaign_id, 'change_roas_target', { roas_target: d.newTarget });
        if (result.error) error = result.message || result.error;
        else db.prepare('UPDATE ads_campaigns SET roas_target = ? WHERE campaign_id = ?').run(d.newTarget, campaign.campaign_id);
      } catch (err) {
        error = err.message; // one campaign failing must not stop the others
      }
    }
    log({
      shop_id: shopId, campaign_id: campaign.campaign_id, item_id: d.itemId ?? null, kind: 'weekly', mode,
      action: d.action, old_target: d.oldTarget, new_target: d.newTarget, this_week: d.thisWeek,
      last_week: d.lastWeek, change_pct: d.changePct, reason: d.reason, error,
    });
    results.push({ ...d, error });
  }
  return { results };
}

// Called on every enrichment pass: runs once per week, at the first pass from
// Monday 00:05 WIB (later that week if the server was down then). If reading
// Shopee fails, the week is NOT marked done and it tries again 30 min later. The
// week is marked done before the first change, so a crash halfway can never
// apply a step twice.
const weeklyFailedAt = new Map(); // shopId -> unix seconds of the last failed attempt
async function maybeRunWeekly(shopId) {
  const settings = getRoasSettings();
  if (settings.mode === 'off') return;
  const { monday } = weekRanges();
  const lastRunKey = `roasAutoLastRunWeek:${shopId}`;
  if (getSetting(lastRunKey, null) === monday) return;
  if (now() < startOfDateWIB(monday) + RUN_MINUTE_AFTER_MIDNIGHT * 60) return;
  const failed = weeklyFailedAt.get(shopId);
  if (failed && now() - failed < SYNC_INTERVAL_SECONDS) return;
  const result = await runWeekly(shopId, settings.mode, () => setSetting(lastRunKey, monday));
  if (result.error) weeklyFailedAt.set(shopId, now());
  else weeklyFailedAt.delete(shopId);
}

// ---------------------------------------------------------------------------
// Toggles

// Iklan on/off: pauses or resumes the campaign on Shopee. Returns an error
// message or null.
async function setCampaignRunning(shopId, campaignId, running, username) {
  const campaign = db.prepare('SELECT * FROM ads_campaigns WHERE campaign_id = ? AND shop_id = ?').get(campaignId, shopId);
  if (!campaign) return 'Campaign tidak ditemukan.';
  if (campaign.ad_type !== 'manual') return 'Campaign ini tidak bisa diatur dari sini (produk dipilih otomatis oleh Shopee).';
  if (running && campaign.campaign_status !== 'paused') return `Campaign tidak sedang dijeda (status: ${campaign.campaign_status}).`;
  if (!running && campaign.campaign_status !== 'ongoing') return `Campaign tidak sedang berjalan (status: ${campaign.campaign_status}).`;

  const action = running ? 'resume' : 'pause';
  let error = null;
  try {
    const accessToken = await getValidAccessToken(shopId);
    const result = await editManualProductAds(accessToken, shopId, campaignId, action);
    if (result.error) error = result.message || result.error;
  } catch (err) {
    error = `Shopee tidak bisa dihubungi (${err.message})`;
  }
  if (!error) {
    db.prepare('UPDATE ads_campaigns SET campaign_status = ? WHERE campaign_id = ?').run(running ? 'ongoing' : 'paused', campaignId);
    if (!running) markPausedToday.run(campaignId, dateStringWIB(0), now());
  }
  log({ shop_id: shopId, campaign_id: campaignId, item_id: parseItemIds(campaign)[0] ?? null, kind: 'iklan', action, username, error });
  return error;
}

function setItemAutoRoas(shopId, itemId, enabled, username) {
  db.prepare(`
    INSERT INTO ads_item_settings (item_id, auto_roas) VALUES (?, ?)
    ON CONFLICT(item_id) DO UPDATE SET auto_roas = excluded.auto_roas
  `).run(itemId, enabled ? 1 : 0);
  log({ shop_id: shopId, item_id: itemId, kind: 'auto_roas', action: enabled ? 'on' : 'off', username });
}

// ---------------------------------------------------------------------------
// For the Dashboard page

function listCampaigns(shopId) {
  const settings = getRoasSettings();
  const ranges = weekRanges();
  const campaigns = db.prepare('SELECT * FROM ads_campaigns WHERE shop_id = ? ORDER BY ad_name').all(shopId);
  const lastWeekly = db.prepare(`
    SELECT * FROM roas_auto_log WHERE campaign_id = ? AND kind = 'weekly' ORDER BY id DESC LIMIT 1
  `);
  return campaigns.map((c) => {
    const itemIds = parseItemIds(c);
    const itemId = itemIds.length === 1 ? itemIds[0] : null;
    const item = itemId ? db.prepare('SELECT name, image_url FROM shopee_items WHERE item_id = ?').get(itemId) : null;
    const setting = itemId ? db.prepare('SELECT auto_roas FROM ads_item_settings WHERE item_id = ?').get(itemId) : null;
    const last = lastWeekly.get(c.campaign_id);
    return {
      campaignId: c.campaign_id,
      adName: c.ad_name,
      status: c.campaign_status,
      roasTarget: c.roas_target,
      itemCount: itemIds.length,
      itemId,
      itemName: item?.name ?? null,
      imageUrl: item?.image_url ?? null,
      skus: itemId ? skusForItem(itemId).filter((s) => !s.startsWith('ITEM-')) : [],
      autoRoas: setting ? !!setting.auto_roas : true,
      canToggleIklan: c.ad_type === 'manual' && ['ongoing', 'paused'].includes(c.campaign_status),
      notManaged: ineligibleReason(c),
      preview: decide(shopId, c, settings, ranges),
      lastDecision: last
        ? { at: last.created_at, mode: last.mode, action: last.action, oldTarget: last.old_target, newTarget: last.new_target, changePct: last.change_pct, reason: last.reason, error: last.error }
        : null,
      syncedAt: c.synced_at,
    };
  });
}

function listLog(shopId, limit = 100) {
  return db
    .prepare(`
      SELECT l.*, i.name AS item_name FROM roas_auto_log l
      LEFT JOIN shopee_items i ON i.item_id = l.item_id
      WHERE l.shop_id = ? ORDER BY l.id DESC LIMIT ?
    `)
    .all(shopId, limit);
}

module.exports = {
  getRoasSettings,
  saveRoasSettings,
  weekRanges,
  syncAdsCampaigns,
  resetAdsSyncThrottle,
  decide,
  runWeekly,
  maybeRunWeekly,
  setCampaignRunning,
  setItemAutoRoas,
  listCampaigns,
  listLog,
};
