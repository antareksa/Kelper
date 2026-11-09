const fs = require('fs');

// Low-disk warning (2026-11-10). On 2026-11-07 the VM's disk filled up and live
// failed to save for ~4 hours with nobody noticing (see the Ops Agent incident).
// The server now checks the disk every CHECK_MS; when free space is low, the
// Dashboard shows a red banner (GET /admin/disk) and the log warns once an hour.
// Live and staging share one disk, so both show it.

const CHECK_MS = 5 * 60 * 1000;
// Free space only, not a percentage: 15% of the VM's 9.7 GB disk is ~1.5 GB,
// but 15% of a big disk is plenty, so a percentage would cry wolf there.
const LOW_FREE_BYTES = 1.5 * 1024 ** 3;
const WARN_EVERY_SECONDS = 60 * 60;

let latest = null;
let lastWarnAt = 0;

function check() {
  fs.statfs('/', (err, s) => {
    if (err) return;
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    const freePct = Math.round((freeBytes / totalBytes) * 1000) / 10;
    const now = Math.floor(Date.now() / 1000);
    latest = { freeBytes, totalBytes, freePct, low: freeBytes < LOW_FREE_BYTES, checkedAt: now };
    if (latest.low && now - lastWarnAt >= WARN_EVERY_SECONDS) {
      lastWarnAt = now;
      console.error(`[server] DISK LOW: ${(freeBytes / 1024 ** 3).toFixed(2)} GB free (${freePct}%) — clean up before saving starts to fail`);
    }
  });
}

function startDiskCheck() {
  check();
  setInterval(check, CHECK_MS).unref();
}

const getDiskStatus = () => latest;

module.exports = { startDiskCheck, getDiskStatus };
