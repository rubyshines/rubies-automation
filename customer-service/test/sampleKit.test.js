const test = require('node:test');
const assert = require('node:assert');

const {
  KIT_GARMENTS,
  MIN_WEEKS_COVER,
  MIN_UNITS,
  weeksOfCover,
  pickGarmentColor,
  pickKitColors,
} = require('../lib/sampleKit');

const garment = (key) => KIT_GARMENTS.find(g => g.key === key);

/** Build a candidate the way loadKitStock does, from the two facts that matter. */
const cand = (color, qty, unitsSold90) => ({
  color,
  sku: `X-${color}-M`,
  variantId: `gid://shopify/ProductVariant/${color}`,
  variantTitle: `${color} / M`,
  qty,
  unitsSold: unitsSold90,
  weeksCover: weeksOfCover({ qty, unitsSold: unitsSold90 }),
});

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

test('cover is stock divided by the rate it leaves, and no sales means no bound', () => {
  // 90 days is 12.86 weeks, so 65 sales is 5.06/week and 130 units is ~26 weeks.
  assert.equal(Math.round(weeksOfCover({ qty: 130, unitsSold: 65 })), 26);
  assert.equal(weeksOfCover({ qty: 40, unitsSold: 0 }), Infinity);
  assert.equal(weeksOfCover({ qty: 0, unitsSold: 10 }), 0);
});

test('units on hand rank the real SKUs backwards; cover ranks them right (measured 2026-09-11)', () => {
  // The case the whole rule exists for. RUBY-PNK-M holds four times the units
  // of RUBY-BLK-XL and is the one that is safe to draw on.
  const pnkM = cand('PNK', 177, 3);
  const blkXl = cand('BLK', 43, 38);
  assert.ok(pnkM.qty > blkXl.qty, 'PNK-M has more units on hand');
  assert.ok(pnkM.weeksCover > blkXl.weeksCover, 'and far more cover');
  assert.ok(blkXl.weeksCover < MIN_WEEKS_COVER, 'the 43-unit SKU is the tight one');
  assert.ok(pnkM.weeksCover >= MIN_WEEKS_COVER, 'the 177-unit SKU is fine');
});

// ---------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------

test('a healthy default is kept untouched', () => {
  const r = pickGarmentColor(garment('charlie'), [cand('SND', 191, 27), cand('BLK', 260, 87)]);
  assert.equal(r.status, 'default');
  assert.equal(r.chosen.color, 'SND');
  assert.equal(r.reason, null);
});

test('a thin default is swapped for the preferred alternate, and the reason names the numbers', () => {
  const r = pickGarmentColor(garment('charlie'), [
    cand('SND', 20, 86),   // ~3 weeks
    cand('BLK', 260, 87),  // ~38 weeks
  ]);
  assert.equal(r.status, 'substituted');
  assert.equal(r.chosen.color, 'BLK');
  assert.match(r.reason, /SND is 3w of cover on 20 units/);
});

test('black is preferred over another healthy colour even when black has less cover', () => {
  // Kit coherence: the fallback is the universal neutral, not whatever happens
  // to be deepest in the warehouse.
  const r = pickGarmentColor(garment('charlie'), [
    cand('SND', 20, 86),    // ~3 weeks
    cand('BLK', 200, 110),  // ~23 weeks
    cand('PNK', 900, 18),   // ~643 weeks
  ]);
  assert.equal(r.chosen.color, 'BLK');
});

test('a marginally better alternate is not worth changing the kit for', () => {
  // 19.6 weeks → 22 weeks is churn. The margin keeps the default.
  const r = pickGarmentColor(garment('charlie'), [
    cand('SND', 107, 70),  // ~19.7 weeks, just under the floor
    cand('BLK', 120, 70),  // ~22.0 weeks, just over it
  ]);
  assert.equal(r.status, 'no_healthy_option');
  assert.equal(r.chosen.color, 'SND');
});

test('when nothing clears the floor the default is kept and flagged, never silently swapped', () => {
  const r = pickGarmentColor(garment('ava'), [
    cand('SND', 33, 29),   // ~14.6 weeks
    cand('BLK', 17, 21),   // ~10.4 weeks
  ]);
  assert.equal(r.status, 'no_healthy_option');
  assert.equal(r.chosen.color, 'SND');
  assert.match(r.reason, /clears 20 weeks of cover/);
});

test('a healthy default stands even when its only sibling is thin (the live 1X Ava bra)', () => {
  // Sandstone 1X is 23.6 weeks and Black 1X is 10.4. Swapping to the thinner
  // colour to "protect" the healthier one is the failure mode a max-cover rule
  // would not have, but a naive low-stock rule would.
  const r = pickGarmentColor(garment('ava'), [
    cand('SND', 33, 18),   // ~23.6 weeks
    cand('BLK', 17, 21),   // ~10.4 weeks
  ]);
  assert.equal(r.status, 'default');
  assert.equal(r.chosen.color, 'SND');
});

test('infinite cover on a handful of units is not healthy — the units floor catches the new colourway', () => {
  const r = pickGarmentColor(garment('charlie'), [
    cand('SND', 20, 86),               // ~3 weeks
    cand('PNK', MIN_UNITS - 1, 0),     // never sold, so unbounded cover
  ]);
  assert.equal(r.chosen.color, 'SND', 'a 5-unit colourway is not a substitute');
  assert.equal(r.status, 'no_healthy_option');
});

test('an operator colour wins outright, including one the rule would have rejected', () => {
  const r = pickGarmentColor(garment('charlie'), [cand('SND', 191, 27), cand('BLK', 5, 50)], 'BLK');
  assert.equal(r.status, 'forced');
  assert.equal(r.chosen.color, 'BLK');
});

test('an operator colour that does not exist falls through to the rule rather than being ignored in silence', () => {
  const r = pickGarmentColor(garment('charlie'), [cand('SND', 191, 27)], 'TEAL');
  assert.equal(r.status, 'default');
  assert.equal(r.chosen.color, 'SND');
});

test('a garment made in no colour in that size is left out, not substituted from another size', () => {
  const r = pickGarmentColor(garment('ruby'), []);
  assert.equal(r.status, 'unavailable');
  assert.equal(r.chosen, null);
});

test('a default that is not made in the size at all still yields the healthiest sibling', () => {
  // Ruby has no Sandstone; the same shape covers a size where the default
  // colour simply is not cut.
  const r = pickGarmentColor(garment('ruby'), [cand('BLK', 147, 72)]);
  assert.equal(r.status, 'substituted');
  assert.equal(r.chosen.color, 'BLK');
  assert.match(r.reason, /not made in that size/);
});

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

test('the kit is the five garments in packing order, every one carrying its verdict', () => {
  const healthy = [cand('SND', 200, 30), cand('BLK', 200, 30), cand('PNK', 200, 30)];
  const picks = pickKitColors({
    charlie: healthy, aj: healthy, brooke: healthy, ava: healthy, ruby: healthy,
  });
  assert.deepEqual(picks.map(p => p.garment.key), ['charlie', 'aj', 'brooke', 'ava', 'ruby']);
  assert.ok(picks.every(p => p.status && p.chosen), 'every garment resolves to a colour and a status');
  // Ruby's default is Pink, the other four default to Sandstone.
  assert.deepEqual(picks.map(p => p.chosen.color), ['SND', 'SND', 'SND', 'SND', 'PNK']);
});

test('the live M kit needs no substitution at all (measured 2026-09-11)', () => {
  // Guards against a threshold change quietly turning the standard kit into a
  // substituted one. These are the real numbers for size M.
  const picks = pickKitColors({
    charlie: [cand('SND', 191, 27), cand('BLK', 260, 87), cand('PNK', 163, 28)],
    aj:      [cand('SND', 300, 72), cand('BLK', 659, 258), cand('PNK', 456, 82)],
    brooke:  [cand('SND', 146, 23), cand('BLK', 236, 57)],
    ava:     [cand('SND', 169, 32), cand('BLK', 156, 28)],
    ruby:    [cand('PNK', 177, 3),  cand('BLK', 149, 109)],
  });
  assert.ok(picks.every(p => p.status === 'default'), picks.map(p => `${p.garment.key}:${p.status}`).join(' '));
});
