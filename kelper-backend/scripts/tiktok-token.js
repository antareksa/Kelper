// Prints the stored TikTok Shop access token, for testing in Partner
// Center's API Testing Tool (2026-11-04). Run on the VM, staging only:
//   cd /opt/kelper-staging/kelper-backend && NODE_ENV=production node scripts/tiktok-token.js
// The token gives access to the connected shop: don't paste it into chats
// or tickets, and only use it with a sandbox (test) seller.
const db = require('../src/db');

let row;
try {
  row = db.prepare('SELECT seller_name, access_token, access_expires_at FROM tiktok_tokens LIMIT 1').get();
} catch {
  row = null; // table doesn't exist: TikTok was never connected here
}
if (!row) {
  console.log('No TikTok token stored. Click Hubungkan in Pengaturan first.');
  process.exit(1);
}
console.log(`Seller:  ${row.seller_name}`);
console.log(`Expires: ${new Date(row.access_expires_at * 1000).toISOString()}`);
console.log(`Token:   ${row.access_token}`);
