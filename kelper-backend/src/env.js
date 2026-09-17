// Single source of truth for which environment this process is running as —
// used by server.js (which .env file to load), db.js (which SQLite file to
// open) and config.js (which config.*.json to read), so all three always
// agree instead of each guessing independently.
//
// Defaults to 'development' when NODE_ENV is unset — a missing/misconfigured
// NODE_ENV should fail safe into the sandbox/mock-friendly environment with
// its own database, never silently fall through to production data.
const NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const isProduction = NODE_ENV === 'production';

module.exports = { NODE_ENV, isProduction };
