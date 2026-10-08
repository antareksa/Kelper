// SSH-usable lock/unlock for order fetching (client-requested 2026-10-02) --
// same underlying toggle as the Dashboard's "Mulai Fetching"/"Jeda Fetching"
// button (see shopeeSync.js's isSyncEnabled, backed by the settings table),
// just reachable without opening the UI -- useful right after connecting a
// new shop, when fetching would otherwise start immediately feeding real
// orders into Packing Station before you're ready to test.
//
// Takes effect immediately, no restart needed -- the running server reads
// this setting fresh from the database on every sync tick.
//
// Usage (from kelper-backend/):
//   node scripts/fetch-lock.js lock          (pause fetching)
//   node scripts/fetch-lock.js unlock        (resume fetching, no limit)
//   node scripts/fetch-lock.js unlock 5      (let only 5 NEW orders in, then lock again)
//   node scripts/fetch-lock.js status
//
// A limited unlock locks by itself once the count is reached. Orders already
// fetched are still booked and labelled after that; only NEW orders stop
// coming in. Running lock/unlock again ends that state.
const { getSetting, setSetting } = require('../src/settings');

const [, , cmd, limitArg] = process.argv;

function status() {
  const enabled = getSetting('syncEnabled', 'false') === 'true';
  const left = getSetting('fetchBudget', '');
  const draining = getSetting('fetchDrain', 'false') === 'true';
  if (enabled && left !== '') console.log(`Fetching is UNLOCKED with a limit -- ${left} more new order(s) allowed, then it locks again.`);
  else if (enabled) console.log('Fetching is UNLOCKED (running, no limit).');
  else if (draining) console.log('Fetching is LOCKED (the limit was reached) -- orders already fetched are still being booked.');
  else console.log('Fetching is LOCKED (paused).');
}

if (cmd === 'lock') {
  setSetting('syncEnabled', 'false');
  setSetting('fetchBudget', '');
  setSetting('fetchDrain', 'false');
  console.log('Fetching LOCKED -- no new orders will be pulled from Shopee until unlocked.');
} else if (cmd === 'unlock') {
  let limit = null;
  if (limitArg !== undefined) {
    limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('The limit must be a whole number of 1 or more, e.g.:  node scripts/fetch-lock.js unlock 5');
      process.exit(1);
    }
  }
  setSetting('fetchBudget', limit === null ? '' : String(limit));
  setSetting('fetchDrain', 'false');
  setSetting('syncEnabled', 'true');
  if (limit === null) console.log('Fetching UNLOCKED -- the server will start pulling new orders on its next sync tick.');
  else console.log(`Fetching UNLOCKED for ${limit} new order(s) -- it locks again by itself once ${limit} have been fetched.`);
} else if (cmd === 'status') {
  status();
} else {
  console.log('Usage:');
  console.log('  node scripts/fetch-lock.js lock');
  console.log('  node scripts/fetch-lock.js unlock');
  console.log('  node scripts/fetch-lock.js unlock <number>   (only that many new orders, then lock again)');
  console.log('  node scripts/fetch-lock.js status');
  process.exit(1);
}
