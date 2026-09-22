const fs = require('fs');
const path = require('path');
const { NODE_ENV, isProduction } = require('./src/env');

// .env.<environment> is the normal case; a plain .env is kept as a fallback
// so an existing local checkout that hasn't been migrated yet still works.
const envFile = path.join(__dirname, `.env.${NODE_ENV}`);
const fallbackEnvFile = path.join(__dirname, '.env');
require('dotenv').config({ path: fs.existsSync(envFile) ? envFile : fallbackEnvFile });

const express = require('express');
const authRoutes = require('./src/routes/auth');
const shopRoutes = require('./src/routes/shop');
const packingRoutes = require('./src/routes/packing');
const ordersRoutes = require('./src/routes/orders');
const operatorsRoutes = require('./src/routes/operators');
const adminRoutes = require('./src/routes/admin');
const productsRoutes = require('./src/routes/products');
const dashboardRoutes = require('./src/routes/dashboard');
const webhookRoutes = require('./src/routes/webhook');
const { startShopeeSync } = require('./src/shopeeSync');

const app = express();
// Production sits behind Caddy (one reverse-proxy hop) — without this,
// req.ip would be Caddy's own loopback address for every request, which
// would make the login brute-force guard (loginGuard.js) share one lockout
// across every visitor instead of tracking per real client IP.
app.set('trust proxy', 1);
// Mounted before the app-wide express.json() below: push signature
// verification needs the exact raw request bytes, so this one route gets
// express.raw() instead of the parsed-JSON body every other route uses.
app.use('/webhook', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.use('/auth', authRoutes);
app.use('/shop', shopRoutes);
app.use('/packing', packingRoutes);
app.use('/orders', ordersRoutes);
app.use('/operators', operatorsRoutes);
app.use('/admin', adminRoutes);
app.use('/products', productsRoutes);
app.use('/dashboard', dashboardRoutes);

// Production serves the frontend's built static bundle directly from this
// same process/port — there's no separate `vite dev` running in production
// (that's a development-only tool). Registered after every API route so a
// request for a real endpoint is never shadowed by the SPA catch-all below.
// Development is unaffected: it keeps using Vite's own dev server on 5173,
// exactly as today.
if (isProduction) {
  const distPath = path.join(__dirname, '..', 'kelper-frontend', 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    console.error(`[server] production build not found at ${distPath} — run "npm run build" in kelper-frontend first.`);
  }
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`kelper-backend [${NODE_ENV}] listening on http://localhost:${port}`));

startShopeeSync();
