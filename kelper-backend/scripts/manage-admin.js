// One-off CLI for admin_users (client-requested 2026-10-01) -- deliberately
// not an HTTP endpoint: adding/removing an admin login is rare enough that a
// shell script run over SSH is the right trust boundary, not new API surface
// that would need its own auth story.
//
// Usage (from kelper-backend/):
//   node scripts/manage-admin.js add <username> <password>
//   node scripts/manage-admin.js remove <username>
//   node scripts/manage-admin.js list
const { createAdmin, deleteAdmin, listAdmins } = require('../src/adminUsers');

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log('Usage:');
  console.log('  node scripts/manage-admin.js add <username> <password>');
  console.log('  node scripts/manage-admin.js remove <username>');
  console.log('  node scripts/manage-admin.js list');
}

if (cmd === 'add') {
  const [username, password] = args;
  if (!username || !password) {
    usage();
    process.exit(1);
  }
  try {
    createAdmin(username, password);
    console.log(`Added admin "${username}".`);
  } catch (err) {
    console.error(err.message.includes('UNIQUE') ? `An admin named "${username}" already exists.` : err.message);
    process.exit(1);
  }
} else if (cmd === 'remove') {
  const [username] = args;
  if (!username) {
    usage();
    process.exit(1);
  }
  console.log(deleteAdmin(username) ? `Removed admin "${username}".` : `No admin named "${username}" found.`);
} else if (cmd === 'list') {
  const admins = listAdmins();
  if (admins.length === 0) {
    console.log('No admins.');
  } else {
    for (const a of admins) console.log(`${a.username} (created ${new Date(a.created_at * 1000).toISOString()})`);
  }
} else {
  usage();
  process.exit(1);
}
