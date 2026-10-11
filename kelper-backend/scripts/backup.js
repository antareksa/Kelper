// Database backups in Google Cloud Storage (client-requested 2026-10-11).
//
//   node scripts/backup.js save [label]       take a backup and upload it
//   node scripts/backup.js list               show the backups in the bucket
//   node scripts/backup.js load <name|latest> restore a backup (replaces the live database)
//
// save   Takes a consistent snapshot of the live database (safe while the
//        server is running), gzips it and uploads it to
//        gs://<bucket>/backups/<env>/. The bucket is evidence.gcsBucket from
//        the config; the VM's attached service account is used, no key files.
//        If the upload fails the snapshot is kept in kelper-backend/backups/.
// list   Newest last. Use the name shown there with `load`.
// load   Accepts a name from `list`, "latest", or a local .db / .db.gz file
//        (e.g. the copy reset-all.js saved). It checks the file is a healthy
//        KELPER database, saves a safety copy of the CURRENT database to
//        kelper-backend/backups/, stops the server (systemd service "kelper"),
//        swaps the database file and starts the server again. Asks you to type
//        RESTORE first (skip with --yes). Everything saved after that backup
//        was taken is gone.
//
// A backup holds everything, including the Shopee tokens -- treat the bucket
// folder accordingly.
//
// Testing without Google: set KELPER_BACKUP_LOCAL_DIR=/some/folder and the
// "bucket" becomes that folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { NODE_ENV } = require('../src/env');
const { getConfig } = require('../src/config');

const SERVICE = 'kelper';
const dbFile = path.join(__dirname, '..', `kelper.${NODE_ENV}.db`);
const localBackupDir = path.join(__dirname, '..', 'backups');
const PREFIX = `backups/${NODE_ENV}/`;
const localDir = process.env.KELPER_BACKUP_LOCAL_DIR || null;

const args = process.argv.slice(2);
const cmd = args[0];
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.slice(1).filter((a) => !a.startsWith('--'));

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';
const fail = (msg) => { console.error(msg); process.exit(1); };

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

// ---------------------------------------------------------------- storage
function bucket() {
  const name = getConfig().evidence?.gcsBucket;
  if (!name) fail('No bucket configured (evidence.gcsBucket in the config).');
  const { Storage } = require('@google-cloud/storage');
  return new Storage().bucket(name);
}

function explain(err, what) {
  if (err && (err.code === 403 || err.code === 401)) {
    return `Google refused to ${what}: this VM's service account has no permission on the bucket.\n` +
      'Fix in Google Cloud Console: Storage > Buckets > the bucket > Permissions > give the VM\'s service account\n' +
      'the role "Storage Object User" (needed to write, list AND read backups).';
  }
  return `Could not ${what}: ${err && err.message ? err.message : err}`;
}

async function putObject(localPath, name) {
  if (localDir) {
    fs.mkdirSync(path.join(localDir, PREFIX), { recursive: true });
    return fs.copyFileSync(localPath, path.join(localDir, PREFIX, name));
  }
  await bucket().upload(localPath, { destination: PREFIX + name, resumable: false });
}

async function listObjects() {
  if (localDir) {
    const dir = path.join(localDir, PREFIX);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith('.db.gz')).sort().map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { name: n, size: st.size, updated: st.mtime.toISOString() };
    });
  }
  const [files] = await bucket().getFiles({ prefix: PREFIX });
  return files
    .filter((f) => f.name.endsWith('.db.gz'))
    .map((f) => ({ name: f.name.slice(PREFIX.length), size: Number(f.metadata.size), updated: f.metadata.updated }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function getObject(name, destination) {
  if (localDir) return fs.copyFileSync(path.join(localDir, PREFIX, name), destination);
  await bucket().file(PREFIX + name).download({ destination });
}

// ---------------------------------------------------------------- helpers
async function snapshotTo(file) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    await db.backup(file);
  } finally {
    db.close();
  }
}

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(dest));
}

async function gunzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

// Opens the candidate read-only and checks it really is a healthy KELPER database.
function inspect(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, reason: `integrity check failed: ${integrity}` };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ['orders', 'settings', 'admin_users']) {
      if (!tables.has(t)) return { ok: false, reason: `table "${t}" is missing -- this is not a KELPER database` };
    }
    const c = (t) => (tables.has(t) ? db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c : 0);
    return { ok: true, counts: { orders: c('orders'), operators: c('operators'), products: c('products'), admins: c('admin_users') } };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    if (db) db.close();
  }
}

function serviceState() {
  try {
    return execFileSync('systemctl', ['is-active', SERVICE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    if (e.code === 'ENOENT') return 'no-systemd';
    return (e.stdout && e.stdout.toString().trim()) || 'inactive';
  }
}

const systemctl = (action) => execFileSync('sudo', ['-n', 'systemctl', action, SERVICE], { stdio: 'inherit' });

// ---------------------------------------------------------------- commands
async function save() {
  const label = (positional[0] || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `kelper.${NODE_ENV}.${stamp()}${label ? '.' + label : ''}.db`;
  fs.mkdirSync(localBackupDir, { recursive: true });
  const tmpDb = path.join(os.tmpdir(), base);
  const tmpGz = tmpDb + '.gz';

  await snapshotTo(tmpDb);
  await gzipFile(tmpDb, tmpGz);
  fs.rmSync(tmpDb, { force: true });
  console.log(`Snapshot taken (${mb(fs.statSync(tmpGz).size)} compressed).`);

  try {
    await putObject(tmpGz, base + '.gz');
  } catch (err) {
    const keep = path.join(localBackupDir, base + '.gz');
    fs.copyFileSync(tmpGz, keep);
    fs.rmSync(tmpGz, { force: true });
    console.error(explain(err, 'upload the backup'));
    fail(`The snapshot was kept on this machine instead: ${keep}`);
  }
  fs.rmSync(tmpGz, { force: true });
  console.log(`Backup saved: ${localDir ? localDir : 'gs://' + getConfig().evidence.gcsBucket}/${PREFIX}${base}.gz`);
  console.log(`Restore it later with:  NODE_ENV=${NODE_ENV} node scripts/backup.js load ${base}.gz`);
}

async function list() {
  let items;
  try {
    items = await listObjects();
  } catch (err) {
    fail(explain(err, 'list the backups'));
  }
  if (items.length === 0) return console.log(`No backups found under ${PREFIX}`);
  console.log(`Backups (${NODE_ENV}), oldest first -- the last one is the newest:\n`);
  for (const it of items) console.log(`  ${it.name}   ${mb(it.size).padStart(9)}   ${String(it.updated).slice(0, 19).replace('T', ' ')} UTC`);
  console.log(`\nRestore:  NODE_ENV=${NODE_ENV} node scripts/backup.js load <name>   (or "latest")`);
}

async function load() {
  const target = positional[0];
  if (!target) fail('Say which backup: node scripts/backup.js load <name|latest>   (see "list")');
  fs.mkdirSync(localBackupDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kelper-restore-'));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  process.on('exit', cleanup); // also covers the fail() exits below

  try {
    // 1. get the file
    let gz;
    if (fs.existsSync(target)) {
      gz = path.resolve(target);
      console.log(`Using local file ${gz}`);
    } else {
      let name = target;
      if (target === 'latest') {
        let items;
        try { items = await listObjects(); } catch (err) { fail(explain(err, 'list the backups')); }
        if (items.length === 0) fail('There are no backups to restore.');
        name = items[items.length - 1].name;
      }
      name = name.replace(PREFIX, '');
      gz = path.join(work, name);
      try { await getObject(name, gz); } catch (err) { fail(explain(err, `download "${name}"`)); }
      console.log(`Downloaded ${name} (${mb(fs.statSync(gz).size)}).`);
    }
    const candidate = path.join(work, 'restore.db');
    if (gz.endsWith('.gz')) await gunzipFile(gz, candidate); else fs.copyFileSync(gz, candidate);

    // 2. check it
    const check = inspect(candidate);
    if (!check.ok) fail(`This file cannot be restored: ${check.reason}. Nothing was changed.`);
    const now = fs.existsSync(dbFile) ? inspect(dbFile) : { ok: false };
    console.log(`\nThe backup contains: ${check.counts.orders} order(s), ${check.counts.operators} staff, ${check.counts.products} product(s), ${check.counts.admins} admin account(s).`);
    if (now.ok) console.log(`The CURRENT database has: ${now.counts.orders} order(s), ${now.counts.operators} staff, ${now.counts.products} product(s), ${now.counts.admins} admin account(s).`);
    console.log('Restoring REPLACES the current database. Everything saved after that backup was taken is lost.\n');

    // 3. confirm
    if (!flags.has('--yes')) {
      if (!process.stdin.isTTY) fail('Not running in an interactive terminal. Add --yes to run without being asked.');
      const answer = await ask('A safety copy of the current database is saved first. Type RESTORE to continue: ');
      if (answer.trim() !== 'RESTORE') return console.log('Cancelled. Nothing was changed.');
    }

    // 4. safety copy of what is there now
    if (fs.existsSync(dbFile)) {
      const safety = path.join(localBackupDir, `kelper.${NODE_ENV}.${stamp()}.before-restore.db`);
      await snapshotTo(safety);
      console.log(`Safety copy of the current database: ${safety}`);
    }

    // 5. stop the server, swap the file, start it again
    const state = serviceState();
    let stopped = false;
    if (state === 'active') {
      try { systemctl('stop'); stopped = true; } catch (e) {
        fail(`Could not stop the "${SERVICE}" service (needs passwordless sudo). Stop it yourself with:\n  sudo systemctl stop ${SERVICE}\nthen run this command again. Nothing was changed.`);
      }
    } else if (state === 'no-systemd') {
      console.log('NOTE: no systemd here -- make sure the server is NOT running while restoring.');
    }

    try {
      const next = dbFile + '.restoring';
      fs.copyFileSync(candidate, next);
      if (fs.existsSync(dbFile)) { try { fs.chmodSync(next, fs.statSync(dbFile).mode); } catch (e) { /* best effort */ } }
      fs.rmSync(dbFile + '-wal', { force: true });
      fs.rmSync(dbFile + '-shm', { force: true });
      fs.renameSync(next, dbFile);
    } finally {
      if (stopped) systemctl('start');
    }
    console.log('\nRestore done.' + (stopped ? ` The "${SERVICE}" service was stopped and started again.` : ''));
    console.log('  - Reload any open Dashboard / Packing Station pages.');
    console.log('  - Check fetching with:  node scripts/fetch-lock.js status');
  } finally {
    cleanup();
  }
}

(async () => {
  if (cmd === 'save') await save();
  else if (cmd === 'list') await list();
  else if (cmd === 'load') await load();
  else {
    console.log('Usage:');
    console.log('  node scripts/backup.js save [label]');
    console.log('  node scripts/backup.js list');
    console.log('  node scripts/backup.js load <name|latest> [--yes]');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => fail(`Failed: ${err.message}`));
