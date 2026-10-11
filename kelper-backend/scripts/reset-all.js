// Full reset (client-requested 2026-10-11): wipe this server's database back to
// a clean slate -- orders, packing history, staff, the product catalog, and the
// Shopee connection -- for starting over, e.g. before going live or when
// switching to another shop. The wider sibling of reset-shop-data.js, which
// only clears one shop's orders.
//
// What it does, in order:
//   1. Shows exactly what will be deleted (row counts) and which database file.
//   2. Asks you to type RESET to continue (skip with --yes).
//   3. Saves a full backup copy of the database to kelper-backend/backups/.
//   4. Deletes everything in ONE transaction (all or nothing).
//
// Always kept: admin accounts (admin_users) -- wiping them would lock everyone
// out of the Dashboard with no way back in. Use manage-admin.js to change those.
//
// Default wipes EVERYTHING else. Keep parts with:
//   --keep-staff       keep operators (Daftar Staff)
//   --keep-products    keep the product / HPP / barcode / stock catalog and bundles
//   --keep-settings    keep packing settings (delay, limits, work hours, ...)
//   --keep-shopee      keep the Shopee connection (tokens and cached items)
//
// Fetching ALWAYS ends up LOCKED: wiping the settings table does it (locked is
// the default), and with --keep-settings the lock is set explicitly -- an
// unlocked server would otherwise pull every open Shopee order straight back
// in. Unlock again with fetch-lock.js when you are ready. Station pages that
// are open should be reloaded afterwards.
//
// NOT touched (outside the database): the authorization stored at Shopee itself
// (remove the app under Seller Centre if you also want it revoked there), and
// packing-video files saved on the stations / in the cloud bucket.
//
// Usage (from kelper-backend/):
//   NODE_ENV=production node scripts/reset-all.js                (asks first)
//   NODE_ENV=production node scripts/reset-all.js --keep-staff --keep-products
//   NODE_ENV=production node scripts/reset-all.js --yes          (no question)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const db = require('../src/db');
const { NODE_ENV } = require('../src/env');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const known = ['--yes', '--keep-staff', '--keep-products', '--keep-settings', '--keep-shopee'];
const unknownFlags = [...flags].filter((f) => !known.includes(f));
if (unknownFlags.length > 0 || args.some((a) => !a.startsWith('--'))) {
  console.error(`Unknown option(s): ${[...unknownFlags, ...args.filter((a) => !a.startsWith('--'))].join(' ')}`);
  console.error(`Usage: node scripts/reset-all.js [${known.join('] [')}]`);
  process.exit(1);
}

// Child tables first: nothing relies on foreign-key cascades.
const GROUPS = [
  { name: 'Orders & packing history', skip: false, tables: ['scan_progress', 'packing_sessions', 'order_income', 'order_items', 'orders', 'station_sessions', 'attendance_log'] },
  { name: 'Ads / shop / affiliate statistics', skip: false, tables: ['ads_performance_daily', 'shop_performance_daily', 'affiliate_performance_daily'] },
  { name: 'Shopee connection (tokens + cached items)', skip: flags.has('--keep-shopee'), tables: ['shopee_tokens', 'shopee_brand_tokens', 'shopee_item_models', 'shopee_items'] },
  { name: 'Product catalog (HPP, barcode, stock) + bundles', skip: flags.has('--keep-products'), tables: ['bundle_items', 'products'] },
  { name: 'Staff (operators)', skip: flags.has('--keep-staff'), tables: ['operators'] },
  { name: 'Settings (packing limits, work hours, fetch lock)', skip: flags.has('--keep-settings'), tables: ['settings'] },
  { name: 'Login attempt records', skip: false, tables: ['login_attempts'] },
];
const ALWAYS_KEPT = ['admin_users', 'admin_sessions'];

const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));

// A table that exists in the database but in no list above (added later by a
// new feature) is reported instead of being silently kept or wiped.
const listed = new Set([...GROUPS.flatMap((g) => g.tables), ...ALWAYS_KEPT]);
const unlisted = [...existing].filter((t) => !listed.has(t));

console.log(`\nDatabase: kelper-backend/kelper.${NODE_ENV}.db   (NODE_ENV=${NODE_ENV})\n`);
console.log('Will DELETE:');
for (const g of GROUPS.filter((x) => !x.skip)) {
  const parts = g.tables.filter((t) => existing.has(t)).map((t) => `${t} ${count(t)}`);
  console.log(`  - ${g.name}: ${parts.join(', ')}`);
}
const kept = GROUPS.filter((x) => x.skip);
console.log('\nWill KEEP:');
console.log(`  - Admin accounts (${count('admin_users')}) -- always kept`);
for (const g of kept) console.log(`  - ${g.name} (--keep flag)${g.tables.includes('settings') ? ' -- except fetching, which is locked' : ''}`);
if (unlisted.length > 0) console.log(`\nNOTE: table(s) not covered by this script, left untouched: ${unlisted.join(', ')}`);
console.log('');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

(async () => {
  if (!flags.has('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('Not running in an interactive terminal. Add --yes to run without being asked.');
      process.exit(1);
    }
    const answer = await ask('This cannot be undone (a backup copy is saved first). Type RESET to continue: ');
    if (answer.trim() !== 'RESET') {
      console.log('Cancelled. Nothing was changed.');
      process.exit(0);
    }
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Ends in .db on purpose: *.db is gitignored, and the file holds Shopee tokens.
  const backupFile = path.join(backupDir, `kelper.${NODE_ENV}.${stamp}.backup.db`);
  await db.backup(backupFile);
  console.log(`Backup saved: ${backupFile}`);

  const wipe = db.transaction(() => {
    for (const g of GROUPS.filter((x) => !x.skip)) {
      for (const t of g.tables) if (existing.has(t)) db.prepare(`DELETE FROM "${t}"`).run();
    }
    if (flags.has('--keep-settings')) {
      // Settings survive, but fetching must not: lock it and drop any limited-unlock state.
      db.prepare("INSERT INTO settings (key, value) VALUES ('syncEnabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      db.prepare("DELETE FROM settings WHERE key IN ('fetchBudget', 'fetchDrain')").run();
    }
  });
  wipe();
  db.exec('VACUUM');

  console.log('\nReset done.');
  console.log('  - Fetching is LOCKED (nothing is pulled from Shopee until you unlock it).');
  if (!flags.has('--keep-shopee')) console.log('  - Shopee is DISCONNECTED here -- connect the shop again from the Dashboard.');
  console.log('  - Reload any open Packing Station / Dashboard pages.');
  console.log(`  - To undo: stop the server and replace kelper.${NODE_ENV}.db with the backup file above.`);
  process.exit(0);
})().catch((err) => {
  console.error('Reset FAILED, nothing was deleted:', err.message);
  process.exit(1);
});
