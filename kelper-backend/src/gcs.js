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

module.exports = { uploadPackingVideo };
