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
//   node scripts/fetch-lock.js lock     (pause fetching)
//   node scripts/fetch-lock.js unlock   (resume fetching)
//   node scripts/fetch-lock.js status
const { getSetting, setSetting } = require('../src/settings');

const [, , cmd] = process.argv;

function status() {
  const enabled = getSetting('syncEnabled', 'false') === 'true';
  console.log(enabled ? 'Fetching is UNLOCKED (running).' : 'Fetching is LOCKED (paused).');
}

if (cmd === 'lock') {
  setSetting('syncEnabled', 'false');
  console.log('Fetching LOCKED -- no new orders will be pulled from Shopee until unlocked.');
} else if (cmd === 'unlock') {
  setSetting('syncEnabled', 'true');
  console.log('Fetching UNLOCKED -- the server will start pulling new orders on its next sync tick.');
} else if (cmd === 'status') {
  status();
} else {
  console.log('Usage:');
  console.log('  node scripts/fetch-lock.js lock');
  console.log('  node scripts/fetch-lock.js unlock');
  console.log('  node scripts/fetch-lock.js status');
  process.exit(1);
}
