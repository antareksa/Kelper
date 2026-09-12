const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  shipping: {
    useMassShip: false,
    trackingPoll: { maxAttempts: 20, delayMs: 3000 },
    documentPoll: { maxAttempts: 5, delayMs: 1000 },
  },
  session: {
    staleSessionSeconds: 3600,
    staleCheckIntervalMs: 60000,
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
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[config] Failed to read config.json, using defaults: ${err.message}`);
    }
    return DEFAULTS;
  }
}

module.exports = { getConfig };
