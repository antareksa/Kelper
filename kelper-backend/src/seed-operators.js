const db = require('./db');

const operators = [
  { name: 'Operator 1', login_barcode: 'OP-0001' },
  { name: 'Operator 2', login_barcode: 'OP-0002' },
  { name: 'Operator 3', login_barcode: 'OP-0003' },
];

const insertOperator = db.prepare(`
  INSERT OR IGNORE INTO operators (name, login_barcode, created_at)
  VALUES (?, ?, ?)
`);

const now = Math.floor(Date.now() / 1000);

for (const op of operators) {
  const result = insertOperator.run(op.name, op.login_barcode, now);
  console.log(result.changes > 0 ? `Seeded ${op.name} (${op.login_barcode})` : `Skipped ${op.name} (already exists)`);
}
