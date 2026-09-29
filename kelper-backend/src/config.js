const fs = require('fs');
const path = require('path');
const { NODE_ENV, isProduction } = require('./env');

// config.<environment>.json is the normal case; a plain config.json is kept
// as a fallback so an existing local checkout that hasn't been migrated yet
// still works.
const envConfigPath = path.join(__dirname, '..', `config.${NODE_ENV}.json`);
const fallbackConfigPath = path.join(__dirname, '..', 'config.json');
const CONFIG_PATH = fs.existsSync(envConfigPath) ? envConfigPath : fallbackConfigPath;

const DEFAULTS = {
  // Whole-backend debug mode: when true, the sync loop below fabricates mock
  // orders on its own discovery tick (instead of calling Shopee), so they
  // flow through the exact same pipeline a real order would. A debug
  // deployment is a property of the backend/environment (dev vs production),
  // not something each station remembers to switch on.
  debugMode: false,
  shipping: {
    useMassShip: false,
    trackingPoll: { maxAttempts: 20, delayMs: 3000 },
    documentPoll: { maxAttempts: 15, delayMs: 2000 },
    // After this many consecutive bookOneOrder failures for the same order,
    // give up retrying it automatically and flag it to Masalah instead (see
    // shopeeSync.js's bookOneOrder) — better than silently retrying forever.
    maxBookingFailures: 5,
  },
  session: {
    staleSessionSeconds: 3600,
    staleCheckIntervalMs: 60000,
  },
  sync: {
    pollIntervalMs: 5000,
    autoBookShipping: true,
  },
  // Client-requested (2026-09-30): packing video evidence, backed up to GCS
  // Nearline in addition to each station's own local download (see
  // PackingStation.jsx's downloadPackingVideo). Off by default -- local dev
  // has no GCS service account attached, so uploads would just fail loudly
  // on every packed order. config.production.json turns this on once the
  // VM's attached service account (see setup notes) is in place.
  evidence: {
    gcsEnabled: false,
    gcsBucket: 'kelper-storage',
  },
};

function deepMerge(base, override) {
  if (typeof override !== 'object' || override === null) return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    result[key] = baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)
      ? deepMerge(baseVal, override[key])
      : override[key];
  }
  return result;
}

// Re-reads config.json on every call (it's tiny) so edits made with a plain
// text editor take effect immediately — no server restart needed. Falls back
// to defaults on missing/malformed file rather than crashing the server.
function getConfig() {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults: ${err.message}`);
    }
    config = DEFAULTS;
  }

  // Hard safety net, independent of whatever config.production.json actually
  // says: production must never fabricate mock orders, even from a stray
  // edit or a config file copied from development by mistake.
  if (isProduction && config.debugMode) {
    console.error('[config] debugMode=true is ignored in production — refusing to fabricate mock orders on a live shop.');
    config = { ...config, debugMode: false };
  }

  return config;
}

module.exports = { getConfig };
