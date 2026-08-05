const { test } = require('node:test');
const assert = require('node:assert');
const { computeSampleRepair } = require('../../scripts/repairB2bSampleStates');

const company = (over = {}) => ({
  id: 'shop-a', name: 'Hello Gorgeous', relationship_type: 'wholesale',
  relationship_state: 'active', order_count: 1, total_sales: 0,
  last_order_date: '2025-11-04', samples_shipped_at: null, ...over,
});
const sample = (created_at = '2025-11-04T16:52:23Z') => ({ created_at, total_price: 0, cancelled_at: null, tags: ['sample kit reach out'] });
const purchase = (created_at, total_price) => ({ created_at, total_price, cancelled_at: null, tags: [] });

test('samples-only company is demoted and its phantom order cleared', () => {
  const upd = computeSampleRepair(company(), [sample()]);
  assert.equal(upd.relationship_state, 'in_contact');
  assert.equal(upd.last_order_date, null);
  assert.equal(upd.order_count, 0);
  assert.equal(upd.samples_shipped_at, '2025-11-04T16:52:23Z');
});

test('a real purchase anywhere means the sync is already right — no repair', () => {
  assert.equal(computeSampleRepair(company({ order_count: 2, total_sales: 605 }),
    [sample(), purchase('2026-05-15T00:00:00Z', 605)]), null);
});

test('lost is never touched', () => {
  assert.equal(computeSampleRepair(company({ relationship_state: 'lost' }), [sample()]), null);
});

test('company with no sample orders is out of scope', () => {
  assert.equal(computeSampleRepair(company({ order_count: 0, last_order_date: null, relationship_state: 'in_contact' }), []), null);
});

test('cancelled sample orders do not qualify a company for repair', () => {
  const cancelled = { ...sample(), cancelled_at: '2025-11-05T00:00:00Z' };
  assert.equal(computeSampleRepair(company({ order_count: 0, last_order_date: null, relationship_state: 'in_contact' }), [cancelled]), null);
});

test('already-correct samples-only company needs no write', () => {
  assert.equal(computeSampleRepair(company({
    relationship_state: 'in_contact', order_count: 0, total_sales: 0,
    last_order_date: null, samples_shipped_at: '2025-11-04T16:52:23Z',
  }), [sample()]), null);
});

test('existing samples_shipped_at is preserved', () => {
  const upd = computeSampleRepair(company({ samples_shipped_at: '2025-10-01T00:00:00Z' }), [sample()]);
  assert.equal(upd.samples_shipped_at, undefined);
  assert.equal(upd.relationship_state, 'in_contact', 'other corrections still apply');
});

test('idempotent — a second run over repaired rows is a no-op', () => {
  const first = computeSampleRepair(company(), [sample()]);
  const repaired = { ...company(), ...first, total_sales: 0 };
  assert.equal(computeSampleRepair(repaired, [sample()]), null);
});
