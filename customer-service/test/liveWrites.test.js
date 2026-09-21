'use strict';
// Possessing production credentials is not permission to use them: local dev
// runs with the same .env as Railway. These assert the guard is shaped so that
// an unknown environment refuses rather than writes, and that the two service
// paths which cascade outside are still behind it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const live = require('../../shared/liveWrites');

function withSignal(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, live.LIVE_SIGNAL);
  const previous = process.env[live.LIVE_SIGNAL];
  if (value === undefined) delete process.env[live.LIVE_SIGNAL];
  else process.env[live.LIVE_SIGNAL] = value;
  try { return fn(); } finally {
    if (had) process.env[live.LIVE_SIGNAL] = previous;
    else delete process.env[live.LIVE_SIGNAL];
  }
}

test('the guard proves production rather than assuming it', () => {
  withSignal(undefined, () => {
    assert.equal(live.isLiveDeployment(), false, 'a laptop has no Railway deployment id');
    assert.equal(live.liveWriteMode().live, false);
  });
  withSignal('dep_1234', () => {
    assert.equal(live.isLiveDeployment(), true, 'a Railway deployment does');
    assert.equal(live.liveWriteMode().live, true);
  });
  // An empty string is what a half-configured environment looks like, and it
  // must read as "not production" rather than as a present variable.
  withSignal('', () => assert.equal(live.isLiveDeployment(), false, 'an empty id is not proof'));
});

test('allowLiveWrite refuses off the live deployment, and says what it skipped', () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    withSignal(undefined, () => assert.equal(live.allowLiveWrite('mint a code'), false));
    withSignal('dep_1234', () => assert.equal(live.allowLiveWrite('mint a code'), true));
  } finally { console.warn = realWarn; }
  assert.equal(warned.length, 1, 'it warns exactly once — on the refusal, not the pass');
  assert.match(warned[0], /SKIPPED/, 'the log line is greppable');
  assert.match(warned[0], /mint a code/, 'it names the write that did not happen');
  assert.match(warned[0], new RegExp(live.LIVE_SIGNAL), 'and why, so a stuck guard is diagnosable');
});

test('the shop link mints no Shopify code off the live deployment', async () => {
  const discounts = require('../../virtual-closet/lib/discounts');
  const { STORE } = require('../../virtual-closet/lib/catalog');
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // No Shopify client and no database are reachable here: if the guard were
    // removed this would try to reach the store and fail, which is the point.
    const url = await withSignal(undefined, () => discounts.shopUrlFor({ id: 1, slug: 'demo' }, { redirect: '/collections/all' }));
    assert.equal(url, `${STORE}/collections/all`, 'the shopper still reaches the store, just without a code');
    assert.ok(!/\/discount\//.test(url), 'and not through a discount URL');
  } finally { console.warn = realWarn; }
});

// approveCentre needs a database, so assert the wiring statically instead: the
// cascade to the donation map and the theme deploy has no compile-time
// reference to the guard, and deleting the check would leave every test green.
test('the approve cascade to the donation map is still behind the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../virtual-closet/lib/operator.js'), 'utf8');
  const approve = src.match(/async function approveCentre[\s\S]*?\n}/);
  assert.ok(approve, 'approveCentre is still there to guard');
  assert.match(approve[0], /createDonationPartner\(/, 'it still has the cascade this test exists for');
  const guarded = /allowLiveWrite\([^)]*\)[\s\S]{0,120}?createDonationPartner\(/.test(approve[0]);
  assert.ok(guarded, 'createDonationPartner is only reached through allowLiveWrite');

  // The operator's own MCP tools are deliberately NOT guarded: they are run by
  // hand from a laptop and must keep working. If that ever changes, partner
  // management breaks silently, so pin the intent here.
  const tools = fs.readFileSync(path.join(__dirname, '../lib/tools/donationPartners.js'), 'utf8');
  assert.ok(!/allowLiveWrite|isLiveDeployment/.test(tools),
    'donation partner MCP tools stay unguarded — an operator on a laptop is not a test fixture');
});
