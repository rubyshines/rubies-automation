/**
 * restockEta.js — soonest dated inbound for a set of SKUs.
 *
 * "Out of stock" and "out of stock, arriving next week" are different answers to
 * a customer, and the second is still worth recommending. Supabase is stubbed
 * via require.cache per repo convention.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const CLIENT = require.resolve('../../shared/supabaseClient');

/** Install a fake Supabase whose two tables return the given rows. */
function stubSupabase({ items = [], shipments = [] } = {}) {
  const client = {
    from(table) {
      const api = {
        _table: table,
        select() { return api; },
        order() { return api; },
        range() { return Promise.resolve({ data: table === 'inbound_shipment_items' ? items : shipments, error: null }); },
        in() { return Promise.resolve({ data: shipments, error: null }); },
      };
      return api;
    },
  };
  require.cache[CLIENT] = {
    id: CLIENT, filename: CLIENT, loaded: true, exports: {
      getSupabaseClient: () => client,
      // The real helper applies .range() itself, so the stub must too --
      // awaiting the builder alone yields the builder, not a result.
      fetchAllPaginated: async (fn) => (await fn().range(0, 999)).data || [],
    },
  };
  delete require.cache[require.resolve('../lib/restockEta')];
  return require('../lib/restockEta');
}

const TODAY = '2026-08-12';

test('restockEtaForSkus: returns the soonest open inbound covering the SKUs', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [
      { sku: 'HLA-BLK-M', qty: 275, inbound_shipment_id: 1 },
      { sku: 'HLA-SND-M', qty: 295, inbound_shipment_id: 1 },
      { sku: 'HLA-BLK-M', qty: 100, inbound_shipment_id: 2 },
    ],
    shipments: [
      { id: 1, transfer_number: 'KALI-2601', status: 'in_transit', estimated_arrival_date: '2026-08-20', in_inventory_date: null },
      { id: 2, transfer_number: 'LATER-01', status: 'in_transit', estimated_arrival_date: '2026-10-01', in_inventory_date: null },
    ],
  });
  const r = await restockEtaForSkus(['HLA-BLK-M', 'HLA-SND-M'], { today: TODAY });
  assert.strictEqual(r.eta, '2026-08-20', 'soonest, not the later container');
  assert.strictEqual(r.transfer_number, 'KALI-2601');
  assert.strictEqual(r.qty, 570, 'sums both colours on that shipment');
});

test('restockEtaForSkus: sellable estimate buffers past warehouse arrival', async () => {
  const { restockEtaForSkus, RECEIVING_BUFFER_DAYS } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-08-20', in_inventory_date: null }],
  });
  const r = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  // Arrival is NOT the sellable date: receiving and putaway sit between them, so
  // quoting the ETA to a customer as "back in stock" would be wrong.
  assert.strictEqual(r.sellable_estimate, '2026-08-25');
  assert.strictEqual(RECEIVING_BUFFER_DAYS, 5);
  assert.match(r.basis, /warehouse arrival/);
});

test('restockEtaForSkus: a confirmed in_inventory_date wins over the buffer', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'partially_received', estimated_arrival_date: '2026-08-20', in_inventory_date: '2026-08-22' }],
  });
  const r = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.strictEqual(r.sellable_estimate, '2026-08-22');
  assert.match(r.basis, /confirmed sellable date/);
});

test('restockEtaForSkus: null when the SKU has no inbound at all (the Naomi case)', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-08-20', in_inventory_date: null }],
  });
  assert.strictEqual(await restockEtaForSkus(['GAF-BLK-M'], { today: TODAY }), null);
});

test('restockEtaForSkus: ignores already-received shipments', async () => {
  // If a shipment is received and the size still reads zero, a past ETA is not
  // the explanation and must not be offered as a restock date.
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'received', estimated_arrival_date: '2026-08-20', in_inventory_date: null }],
  });
  assert.strictEqual(await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY }), null);
});

test('restockEtaForSkus: ignores ETAs already in the past', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-07-01', in_inventory_date: null }],
  });
  assert.strictEqual(await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY }), null);
});

test('restockEtaForSkus: SKU matching is case and whitespace tolerant', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: ' hla-blk-m ', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-08-20', in_inventory_date: null }],
  });
  const r = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.strictEqual(r.eta, '2026-08-20');
});

test('restockEtaForSkus: empty or junk input returns null without querying', async () => {
  const { restockEtaForSkus } = stubSupabase({});
  for (const input of [[], null, undefined, [''], [null]]) {
    assert.strictEqual(await restockEtaForSkus(input, { today: TODAY }), null, JSON.stringify(input));
  }
});

test('addDays: pure UTC date math, month rollover included', async () => {
  const { addDays } = stubSupabase({});
  assert.strictEqual(addDays('2026-08-20', 5), '2026-08-25');
  assert.strictEqual(addDays('2026-08-29', 5), '2026-09-03');
  assert.strictEqual(addDays('2026-12-30', 5), '2027-01-04');
  assert.strictEqual(addDays('not-a-date', 5), null);
});

// --- the offer rule ---------------------------------------------------------
// Encoded here rather than left to the model, so every caller applies it the
// same way instead of each one re-judging "is that soon enough".

test('worth_offering: true inside the window, false beyond it', async () => {
  const { restockEtaForSkus, RESTOCK_OFFER_WINDOW_DAYS } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-08-20', in_inventory_date: null }],
  });
  assert.strictEqual(RESTOCK_OFFER_WINDOW_DAYS, 21);
  const soon = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.strictEqual(soon.days_until_sellable, 13, 'arrival 08-20 + 5 receiving = 08-25');
  assert.strictEqual(soon.worth_offering, true);
});

test('worth_offering: false when the sellable date is past the window', async () => {
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-10-01', in_inventory_date: null }],
  });
  const far = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.ok(far, 'still reported, so the advisor knows it exists');
  assert.strictEqual(far.worth_offering, false, 'but must not be pitched as worth waiting for');
  assert.ok(far.days_until_sellable > 21);
});

test('worth_offering: exactly at the window boundary still counts', async () => {
  // 21 days out: sellable 2026-09-02 = arrival 08-28 + 5.
  const { restockEtaForSkus } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-08-28', in_inventory_date: null }],
  });
  const r = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.strictEqual(r.days_until_sellable, 21);
  assert.strictEqual(r.worth_offering, true, 'boundary is inclusive');
});

test('daysBetween: whole days, and null on junk', async () => {
  const { daysBetween } = stubSupabase({});
  assert.strictEqual(daysBetween('2026-08-12', '2026-08-25'), 13);
  assert.strictEqual(daysBetween('2026-08-25', '2026-08-12'), -13);
  assert.strictEqual(daysBetween('2026-08-12', '2026-08-12'), 0);
  assert.strictEqual(daysBetween('junk', '2026-08-12'), null);
});

// --- vague phrasing ---------------------------------------------------------
// A date built on an ETA we do not control should not be quoted precisely. The
// phrase reuses formatPreOrderDate (same wording as the site and the pre-order
// line attributes) and skews later so we under-promise.

test('sellable_phrase: vague, and conservative near a boundary', async () => {
  const mk = (eta) => stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: eta, in_inventory_date: null }],
  }).restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });

  // arrival 20th + 5 receiving = sellable 25th, +3 conservatism = 28th
  assert.strictEqual((await mk('2026-08-20')).sellable_phrase, 'end of August, 2026');

  // sellable 20th would read "middle" on its own; conservatism pushes it later
  // so we never sound earlier than we are confident about.
  const boundary = await mk('2026-08-15');
  assert.strictEqual(boundary.sellable_estimate, '2026-08-20');
  assert.strictEqual(boundary.sellable_phrase, 'end of August, 2026', 'boundary must round later, not earlier');

  // rolls into the next month rather than claiming the end of this one
  assert.strictEqual((await mk('2026-08-25')).sellable_phrase, 'beginning of September, 2026');
});

test('sellable_phrase: never earlier than the internal sellable estimate implies', async () => {
  const { restockEtaForSkus, PHRASE_CONSERVATISM_DAYS } = stubSupabase({
    items: [{ sku: 'HLA-BLK-M', qty: 10, inbound_shipment_id: 1 }],
    shipments: [{ id: 1, transfer_number: 'T', status: 'in_transit', estimated_arrival_date: '2026-09-08', in_inventory_date: null }],
  });
  assert.strictEqual(PHRASE_CONSERVATISM_DAYS, 3);
  const r = await restockEtaForSkus(['HLA-BLK-M'], { today: TODAY });
  assert.strictEqual(r.sellable_estimate, '2026-09-13');
  assert.strictEqual(r.sellable_phrase, 'middle of September, 2026');
});
