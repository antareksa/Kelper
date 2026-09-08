const db = require('./db');

const MOCK_SHOP_ID = 227886187;

const mockOrders = [
  {
    order_sn: 'MOCK-ORDER-001',
    buyer_name: 'Andi Wijaya',
    items: [
      { sku: 'SKU-RED-M', product_name: 'Kaos Polos Merah - M', qty: 2 },
      { sku: 'SKU-BLU-L', product_name: 'Kaos Polos Biru - L', qty: 1 },
    ],
  },
  {
    order_sn: 'MOCK-ORDER-002',
    buyer_name: 'Sinta Dewi',
    items: [
      { sku: 'SKU-BLK-S', product_name: 'Kaos Polos Hitam - S', qty: 3 },
    ],
  },
  {
    order_sn: 'MOCK-ORDER-003',
    buyer_name: 'Budi Santoso',
    items: [
      { sku: 'SKU-RED-M', product_name: 'Kaos Polos Merah - M', qty: 1 },
      { sku: 'SKU-BLK-S', product_name: 'Kaos Polos Hitam - S', qty: 1 },
      { sku: 'SKU-BLU-L', product_name: 'Kaos Polos Biru - L', qty: 2 },
    ],
  },
];

const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO orders (order_sn, shop_id, status, buyer_name, created_at)
  VALUES (?, ?, 'READY_TO_PACK', ?, ?)
`);
const insertItem = db.prepare(`
  INSERT INTO order_items (order_sn, sku, product_name, qty)
  VALUES (?, ?, ?, ?)
`);

const now = Math.floor(Date.now() / 1000);

for (const order of mockOrders) {
  const result = insertOrder.run(order.order_sn, MOCK_SHOP_ID, order.buyer_name, now);
  if (result.changes > 0) {
    for (const item of order.items) {
      insertItem.run(order.order_sn, item.sku, item.product_name, item.qty);
    }
    console.log(`Seeded ${order.order_sn}`);
  } else {
    console.log(`Skipped ${order.order_sn} (already exists)`);
  }
}
