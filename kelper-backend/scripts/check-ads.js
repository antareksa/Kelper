// SSH-usable check of Iklan (ad spend), for comparing what the Dashboard shows
// against what Shopee's Ads API says right now.
//
// Prints (1) what the Dashboard has stored per day and the tax setting it
// applies, then (2) a live pull from Shopee of the chosen day's hourly spend.
//
// The live pull uses the stored access token as-is and never refreshes it --
// the running server owns token refresh (Shopee refresh tokens are single-use,
// so a second refresher could invalidate the server's). If the token has
// expired, the script says so instead; the server renews it on its next tick.
//
// Usage (from kelper-backend/, NODE_ENV=production on the VM):
//   NODE_ENV=production node scripts/check-ads.js              (today, WIB)
//   NODE_ENV=production node scripts/check-ads.js 02-10-2026   (a DD-MM-YYYY date)
//   NODE_ENV=production node scripts/check-ads.js --stored     (stored values only, no Shopee call)
const fs = require('fs');
const path = require('path');
const { NODE_ENV } = require('../src/env');

// Same env-file choice as server.js -- the Shopee client reads its partner
// key at require time, so this must happen before it is loaded below.
const root = path.join(__dirname, '..');
const envFile = path.join(root, `.env.${NODE_ENV}`);
require('dotenv').config({ path: fs.existsSync(envFile) ? envFile : path.join(root, '.env') });

const db = require('../src/db');
const { getSetting } = require('../src/settings');
const { getAllCpcAdsHourlyPerformance } = require('../src/shopee/client');
const { dateStringDDMMYYYYWIB } = require('../src/wib');

const args = process.argv.slice(2);
const storedOnly = args.includes('--stored');
const dateArg = args.find((a) => /^\d{2}-\d{2}-\d{4}$/.test(a));
const rupiah = (n) => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');

async function main() {
  const shops = db.prepare('SELECT shop_id, expires_at, access_token FROM shopee_tokens').all();
  if (shops.length === 0) {
    console.log('No shop is connected.');
    return;
  }

  const tax = Number(getSetting('adsTaxPercentage', '0'));
  console.log(`Ads tax applied by the Dashboard: ${tax}%\n`);

  for (const shop of shops) {
    console.log(`=== Shop ${shop.shop_id} ===`);

    const stored = db
      .prepare('SELECT date, expense, fetched_at FROM ads_performance_daily WHERE shop_id = ? ORDER BY date DESC LIMIT 7')
      .all(shop.shop_id);
    console.log('Stored on the Dashboard (last 7 days):');
    if (stored.length === 0) console.log('  (nothing stored yet)');
    for (const r of stored) {
      const age = Math.round((Date.now() / 1000 - r.fetched_at) / 60);
      console.log(`  ${r.date}  ${rupiah(r.expense).padStart(16)}   with tax ${rupiah(r.expense * (1 + tax / 100)).padStart(16)}   (fetched ${age} min ago)`);
    }

    if (storedOnly) {
      console.log();
      continue;
    }

    const date = dateArg || dateStringDDMMYYYYWIB(0);
    const now = Math.floor(Date.now() / 1000);
    if (shop.expires_at <= now) {
      console.log(`\nLive check skipped: the stored access token has expired. The server refreshes it on its next tick -- run this again in a minute.\n`);
      continue;
    }

    const result = await getAllCpcAdsHourlyPerformance(shop.access_token, shop.shop_id, date);
    if (result.error) {
      console.log(`\nLive check for ${date} FAILED: ${result.error} -- ${result.message || ''}\n`);
      continue;
    }

    const hours = (result.response || []).filter((h) => h.expense);
    const total = (result.response || []).reduce((s, h) => s + (h.expense || 0), 0);
    console.log(`\nLive from Shopee for ${date} (by hour, only hours with spend):`);
    if (hours.length === 0) console.log('  (no spend)');
    for (const h of hours) console.log(`  ${String(h.hour).padStart(2, '0')}:00  ${rupiah(h.expense).padStart(14)}`);
    console.log(`  TOTAL  ${rupiah(total).padStart(14)}   with tax ${rupiah(total * (1 + tax / 100))}\n`);
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
