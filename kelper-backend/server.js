require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const authRoutes = require('./src/routes/auth');
const shopRoutes = require('./src/routes/shop');
const packingRoutes = require('./src/routes/packing');
const ordersRoutes = require('./src/routes/orders');
const operatorsRoutes = require('./src/routes/operators');
const adminRoutes = require('./src/routes/admin');

const app = express();
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

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`kelper-backend listening on http://localhost:${port}`));
