const { Storage } = require('@google-cloud/storage');

// No credentials configured here on purpose -- the production VM has the
// kelper-evidence-writer service account attached directly to the instance,
// so Application Default Credentials picks it up automatically. Local dev
// never calls this (see config.js's evidence.gcsEnabled, off by default).
const storage = new Storage();

async function uploadPackingVideo(bucketName, orderSn, buffer) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(`${orderSn}.webm`);
  await file.save(buffer, { contentType: 'video/webm', resumable: false });
}

// The uploaded video of one order (same name uploadPackingVideo gives it), for the
// Order menu's download button (routes/orders.js, 2026-10-15). Reading needs the
// VM's service account to be allowed to read the bucket, not only write to it.
function packingVideoFile(bucketName, orderSn) {
  return storage.bucket(bucketName).file(`${orderSn}.webm`);
}

module.exports = { uploadPackingVideo, packingVideoFile };
