/**
 * Expected-arrival estimation for inbound shipments.
 *
 * The behaviour under test is a three-way split: use the date given, derive one from the
 * carrier, or ask. What must never happen is a shipment recorded with no date — Warehance
 * renders that as 0001-01-01 and the warehouse cannot plan receiving around it.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  TRANSIT_DAYS, detectMode, addDays, resolveExpectedArrival, describeEstimate,
} = require('../lib/merchandising/transitEstimate');

const TODAY = '2026-08-05';

test('detectMode: recognises the carrier strings we actually write', () => {
  assert.strictEqual(detectMode('Ocean/CLH'), 'ocean');
  assert.strictEqual(detectMode('UPS'), 'courier');
  assert.strictEqual(detectMode('air freight'), 'air');
  assert.strictEqual(detectMode('FedEx'), 'courier');
  assert.strictEqual(detectMode('sea freight'), 'ocean');
});

test('detectMode: case-insensitive', () => {
  assert.strictEqual(detectMode('ups'), 'courier');
  assert.strictEqual(detectMode('OCEAN'), 'ocean');
});

test('detectMode: returns null rather than guessing at an unknown carrier', () => {
  // "Harry" is our freight forwarder's name, not a mode — it must not resolve to one.
  assert.strictEqual(detectMode('Harry'), null);
  assert.strictEqual(detectMode(''), null);
  assert.strictEqual(detectMode(undefined), null);
});

test('addDays: crosses month and year boundaries in UTC', () => {
  assert.strictEqual(addDays('2026-08-05', 30), '2026-09-04');
  assert.strictEqual(addDays('2026-12-20', 30), '2027-01-19');
  assert.strictEqual(addDays('2026-02-27', 2), '2026-03-01'); // 2026 is not a leap year
  assert.strictEqual(addDays('2024-02-27', 2), '2024-02-29'); // 2024 is
});

test('addDays: rejects a non-date rather than producing NaN', () => {
  assert.throws(() => addDays('next tuesday', 5), /YYYY-MM-DD/);
});

test('an explicit expected arrival wins over any estimate', () => {
  const r = resolveExpectedArrival({ expectedArrival: '2026-08-20', carrier: 'UPS', shipDate: '2026-08-01', today: TODAY });
  assert.strictEqual(r.expectedArrival, '2026-08-20');
  assert.strictEqual(r.source, 'provided');
});

test('estimates from the ship date when there is one', () => {
  const r = resolveExpectedArrival({ carrier: 'Ocean/CLH', shipDate: '2026-07-05', today: TODAY });
  assert.strictEqual(r.expectedArrival, '2026-08-04'); // + 30 days
  assert.strictEqual(r.source, 'estimated');
  assert.strictEqual(r.mode, 'ocean');
  assert.strictEqual(r.basedOn, 'ship date');
});

test('falls back to today when the ship date is unknown', () => {
  const r = resolveExpectedArrival({ carrier: 'UPS', today: TODAY });
  assert.strictEqual(r.expectedArrival, '2026-08-10'); // + 5 days
  assert.strictEqual(r.basedOn, "today's date");
});

test('each mode uses its own transit time', () => {
  const at = (carrier) => resolveExpectedArrival({ carrier, shipDate: '2026-08-01', today: TODAY }).transitDays;
  assert.strictEqual(at('Ocean/CLH'), TRANSIT_DAYS.ocean);
  assert.strictEqual(at('air freight'), TRANSIT_DAYS.air);
  assert.strictEqual(at('UPS'), TRANSIT_DAYS.courier);
  // The whole point of the split: a container and a parcel must not get the same date.
  assert.notStrictEqual(at('Ocean/CLH'), at('UPS'));
});

test('asks instead of guessing when the carrier mode is unrecognisable', () => {
  const r = resolveExpectedArrival({ carrier: 'Harry', today: TODAY });
  assert.strictEqual(r.needsPrompt, true);
  assert.strictEqual(r.expectedArrival, null);
  assert.match(r.question, /Harry/);
});

test('asks when there is no carrier and no date at all', () => {
  const r = resolveExpectedArrival({ today: TODAY });
  assert.strictEqual(r.needsPrompt, true);
  assert.strictEqual(r.expectedArrival, null);
});

test('an operator-supplied transit time answers the prompt', () => {
  // This is the follow-up call after the tool asked: same unknown carrier, now with days.
  const r = resolveExpectedArrival({ carrier: 'Harry', transitDays: 12, shipDate: '2026-08-01', today: TODAY });
  assert.strictEqual(r.needsPrompt, undefined);
  assert.strictEqual(r.expectedArrival, '2026-08-13');
  assert.strictEqual(r.transitDays, 12);
});

test('a stated transit time overrides the mode default', () => {
  const r = resolveExpectedArrival({ carrier: 'UPS', transitDays: 2, shipDate: '2026-08-01', today: TODAY });
  assert.strictEqual(r.expectedArrival, '2026-08-03');
  assert.notStrictEqual(r.transitDays, TRANSIT_DAYS.courier);
});

test('a nonsense transit time falls back to the carrier rather than corrupting the date', () => {
  for (const bad of [0, -5, 'soon', null]) {
    const r = resolveExpectedArrival({ carrier: 'UPS', transitDays: bad, shipDate: '2026-08-01', today: TODAY });
    assert.strictEqual(r.expectedArrival, '2026-08-06', `transitDays=${bad}`);
  }
});

test('needs a base date to estimate from', () => {
  assert.throws(() => resolveExpectedArrival({ carrier: 'UPS' }), /today/);
});

test('describeEstimate: explains an estimate and stays silent on a given date', () => {
  const estimated = resolveExpectedArrival({ carrier: 'Ocean/CLH', shipDate: '2026-07-05', today: TODAY });
  const note = describeEstimate(estimated);
  assert.match(note, /2026-08-04/);
  assert.match(note, /30 days/);
  assert.match(note, /ocean/);
  assert.match(note, /update_inbound_shipment/); // tells the operator how to correct it

  assert.strictEqual(describeEstimate(resolveExpectedArrival({ expectedArrival: '2026-08-20', today: TODAY })), null);
  assert.strictEqual(describeEstimate(null), null);
});
