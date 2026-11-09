const db = require('../db');
const { apiRequest } = require('./client');

// TikTok Shop / Tokopedia income (2026-11-10, step 3 of the TikTok integration):
// the TikTok side of shopeeSync.js's fillMissingIncomeData. Once an order is DONE
// in KELPER (picked up), its settlement is read from
// GET /finance/202501/orders/{order_id}/statement_transactions and stored in the
// same order_income table, mapped onto the same columns the Dashboard reads.
//
// UNPROVEN MAPPING: the sandbox never settles orders (every answer is zeros), so
// the field mapping below follows TikTok's API spec only. Check it against the
// first real settled order.
//
// An unsettled order comes back as SUCCESS with all zeros and no
// sku_transactions. That must count as "not settled yet" and store NOTHING:
// storing it would show 0 fees and overstate Laba Bersih. TikTok settles some
// days after delivery, so each order is asked again at most every RETRY_SECONDS.

const RETRY_SECONDS = 6 * 60 * 60;
const MAX_PER_TICK = 20; // a backlog drains over several ticks instead of one burst
const lastTried = new Map(); // order_sn -> unix seconds; in memory, a restart retries at once

function now() {
  return Math.floor(Date.now() / 1000);
}

// TikTok sends amounts as strings, fees usually negative. Fees are stored as
// positive costs, like Shopee's.
const amount = (v) => Math.abs(Number(v) || 0);

// Fee fields, by Dashboard group (names from the API spec's fee_tax_breakdown.fee).
const COMMISSION_FEES = ['platform_commission_amount', 'dynamic_commission_amount'];
const TRANSACTION_FEES = ['transaction_fee_amount'];
const LAYANAN_FEES = ['voucher_xtra_service_fee_amount']; // TikTok's own "Voucher Xtra" = Layanan
const AFFILIATE_FEES = ['affiliate_commission_amount', 'affiliate_ads_commission_amount', 'affiliate_partner_commission_amount', 'external_affiliate_marketing_fee_amount'];
// Bookkeeping entries that are not a cost of the order (a deposit, its release,
// the pre-tax copy of the affiliate commission): never added.
const IGNORED_FEES = ['affiliate_commission_amount_before_pit', 'affiliate_commission_deposit', 'affiliate_commission_release'];

// Maps one statement onto order_income's columns, or null when it isn't settled.
function mapStatement(st) {
  const skus = st?.sku_transactions || [];
  if (skus.length === 0 && !Number(st?.settlement_amount) && !Number(st?.revenue_amount)) return null;

  const sumFees = (names) => skus.reduce((t, s) => t + names.reduce((u, n) => u + amount(s.fee_tax_breakdown?.fee?.[n]), 0), 0);
  const allFees = skus.reduce((t, s) => t + Object.entries(s.fee_tax_breakdown?.fee || {})
    .filter(([n]) => !IGNORED_FEES.includes(n))
    .reduce((u, [, v]) => u + amount(v), 0), 0);
  const tax = skus.reduce((t, s) => t + Object.values(s.fee_tax_breakdown?.tax || {}).reduce((u, v) => u + amount(v), 0), 0);

  const commission = sumFees(COMMISSION_FEES);
  const transaction = sumFees(TRANSACTION_FEES);
  const layanan = sumFees(LAYANAN_FEES);
  const affiliate = sumFees(AFFILIATE_FEES);
  // Everything else TikTok charged (Seller Free Shipping, flash sale, LIVE, ...):
  // goes to Biaya Pesanan with commission and transaction, via this column.
  const other = Math.max(0, allFees - commission - transaction - layanan - affiliate);

  return {
    order_selling_price: Number(st.revenue_amount) || 0,
    escrow_amount: Number(st.settlement_amount) || 0,
    service_fee: layanan,
    commission_fee: commission,
    seller_transaction_fee: transaction,
    seller_order_processing_fee: other,
    withholding_tax: tax,
    affiliate_commission: affiliate,
  };
}

const insertIncome = db.prepare(`
  INSERT OR REPLACE INTO order_income
    (order_sn, order_selling_price, escrow_amount, service_fee, commission_fee, seller_transaction_fee,
     seller_order_processing_fee, withholding_tax, affiliate_commission, raw_income, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// One connected TikTok shop's DONE orders that have no settlement stored yet.
async function fillTikTokIncome(opts, tiktokShopId) {
  const pending = db.prepare(`
    SELECT order_sn FROM orders
    WHERE platform != 'shopee' AND marketplace_shop_id = ? AND status = 'DONE'
      AND NOT EXISTS (SELECT 1 FROM order_income WHERE order_income.order_sn = orders.order_sn AND raw_income IS NOT NULL)
  `).all(String(tiktokShopId)).filter((r) => now() - (lastTried.get(r.order_sn) || 0) >= RETRY_SECONDS);

  for (const { order_sn: orderSn } of pending.slice(0, MAX_PER_TICK)) {
    lastTried.set(orderSn, now());
    let statement;
    try {
      statement = await apiRequest('GET', `/finance/202501/orders/${orderSn}/statement_transactions`, opts);
    } catch (err) {
      console.warn(`[server] TikTok statement for ${orderSn} failed: ${err.tiktokCode ?? ''} ${err.message} — will retry later`);
      continue;
    }
    const m = mapStatement(statement);
    if (!m) continue; // not settled yet
    insertIncome.run(orderSn, m.order_selling_price, m.escrow_amount, m.service_fee, m.commission_fee, m.seller_transaction_fee,
      m.seller_order_processing_fee, m.withholding_tax, m.affiliate_commission, JSON.stringify(statement), now());
    console.log(`[server] TikTok income stored for ${orderSn} (settlement ${m.escrow_amount})`);
  }
}

module.exports = { fillTikTokIncome, mapStatement };
