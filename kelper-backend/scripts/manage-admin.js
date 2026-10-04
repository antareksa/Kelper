// One-off CLI for admin_users (client-requested 2026-10-01) -- deliberately
// not an HTTP endpoint: adding/removing an admin login is rare enough that a
// shell script run over SSH is the right trust boundary, not new API surface
// that would need its own auth story.
//
// Roles (2026-10-04):
//   admin    the whole dashboard (the default)
//   packing  Packing Station admin: only the Packing Station Dashboard and
//            Order menus
//
// Usage (from kelper-backend/, NODE_ENV=production on the VM):
//   node scripts/manage-admin.js add <username> <password> [admin|packing]
//   node scripts/manage-admin.js set-role <username> <admin|packing>
//   node scripts/manage-admin.js remove <username>
//   node scripts/manage-admin.js list
const { createAdmin, deleteAdmin, listAdmins, setAdminRole, ROLES } = require('../src/adminUsers');

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log('Usage:');
  console.log('  node scripts/manage-admin.js add <username> <password> [admin|packing]');
  console.log('  node scripts/manage-admin.js set-role <username> <admin|packing>');
  console.log('  node scripts/manage-admin.js remove <username>');
  console.log('  node scripts/manage-admin.js list');
  console.log('Roles: admin = whole dashboard (default), packing = Packing Station Dashboard + Order only.');
}

if (cmd === 'add') {
  const [username, password, role = 'admin'] = args;
  if (!username || !password) {
    usage();
    process.exit(1);
  }
  try {
    createAdmin(username, password, role);
    console.log(`Added ${role} account "${username}".`);
  } catch (err) {
    console.error(err.message.includes('UNIQUE') ? `An account named "${username}" already exists.` : err.message);
    process.exit(1);
  }
} else if (cmd === 'set-role') {
  const [username, role] = args;
  if (!username || !ROLES.includes(role)) {
    usage();
    process.exit(1);
  }
  // Also signs that account out of its open sessions, so the new role applies
  // from its next login.
  console.log(setAdminRole(username, role) ? `"${username}" is now ${role} (signed out of open sessions).` : `No account named "${username}" found.`);
} else if (cmd === 'remove') {
  const [username] = args;
  if (!username) {
    usage();
    process.exit(1);
  }
  console.log(deleteAdmin(username) ? `Removed account "${username}" (and ended its open sessions).` : `No account named "${username}" found.`);
} else if (cmd === 'list') {
  const admins = listAdmins();
  if (admins.length === 0) {
    console.log('No accounts.');
  } else {
    for (const a of admins) console.log(`${a.username}  [${a.role}]  (created ${new Date(a.created_at * 1000).toISOString()})`);
  }
} else {
  usage();
  process.exit(1);
}
