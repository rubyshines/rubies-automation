/**
 * Unit tests for stripPreGreetingNarration in customer-service/lib/aiAdvisor.js.
 *
 * The advisor sometimes writes its own reasoning ahead of the customer email
 * ("Charlie S Black is in stock (159). Creating the exchange.\n\nHi Sam, ...").
 * The prompt forbids it, but it is a negative rule and drifted on 3.8% of 396
 * drafts since 2026-07-01. Operators caught all of them, but the strip removes
 * the review cost and the one-missed-glance risk.
 *
 * The fixtures below are the real leaked preambles from production.
 *
 * Run: node --test customer-service/test/stripPreGreetingNarration.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stripPreGreetingNarration } = require('../lib/aiAdvisor');

describe('stripPreGreetingNarration', () => {
  it('strips a real leaked preamble and keeps the email intact', () => {
    const input = 'Charlie S Black is in stock (159). Creating the exchange.\n\nHi Sam,\n\nI\'ve created your exchange.\n\nTake care,\nJamie';
    const out = stripPreGreetingNarration(input);
    assert.equal(out.text, 'Hi Sam,\n\nI\'ve created your exchange.\n\nTake care,\nJamie');
    assert.match(out.stripped, /Creating the exchange/);
  });

  it('leaves a clean reply completely untouched', () => {
    const input = 'Hi Autumn,\n\nI\'ve swapped both to Pink in size 1X.\n\nTake care,\nJamie';
    const out = stripPreGreetingNarration(input);
    assert.equal(out.text, input);
    assert.equal(out.stripped, null);
  });

  it('does not fire on a reply with no greeting at all', () => {
    // route-to-human placeholders and some outbound formats have no greeting —
    // stripping to "nothing" would destroy the draft.
    const input = 'This ticket needs a human. Routing to Jamie.';
    const out = stripPreGreetingNarration(input);
    assert.equal(out.text, input);
    assert.equal(out.stripped, null);
  });

  it('does not fire on a mid-sentence "hi"', () => {
    const input = 'Hi there,\n\nWe say hi to everyone who writes in.\n\nJamie';
    const out = stripPreGreetingNarration(input);
    assert.equal(out.text, input);
    assert.equal(out.stripped, null);
  });

  it('handles each greeting form', () => {
    for (const g of ['Hi', 'Hey', 'Hello', 'Hola']) {
      const out = stripPreGreetingNarration(`Reasoning here.\n\n${g} Sam,\n\nBody.`);
      assert.equal(out.text, `${g} Sam,\n\nBody.`, `greeting ${g}`);
    }
  });

  it('is a no-op on empty or nullish input', () => {
    assert.deepEqual(stripPreGreetingNarration(''), { text: '', stripped: null });
    assert.deepEqual(stripPreGreetingNarration(null), { text: null, stripped: null });
    assert.deepEqual(stripPreGreetingNarration(undefined), { text: undefined, stripped: null });
  });

  it('strips only whitespace without reporting a correction', () => {
    const out = stripPreGreetingNarration('\n\n  \nHi Sam,\n\nBody.');
    assert.equal(out.text, 'Hi Sam,\n\nBody.');
    assert.equal(out.stripped, null, 'leading whitespace is not a narration leak');
  });

  it('keeps the FIRST greeting when the body quotes another one', () => {
    const input = 'Planning.\n\nHi Sam,\n\nYou wrote:\nHi team, where is my order?\n\nJamie';
    const out = stripPreGreetingNarration(input);
    assert.match(out.text, /^Hi Sam,/);
    assert.match(out.text, /Hi team, where is my order\?/, 'the quoted greeting survives');
  });

  it('strips every real production preamble', () => {
    const preambles = [
      'The Cheeky bottom (Black/M) is in stock and ships now; the Mia 1X (Black) is out of stock and holds. The split is exactly what the operator wants.',
      "The operator has provided the new address. It's in the same country (Canada), so I can apply the order modification directly.",
      'All three products are in stock in size 14 Black. This is an exchange (2x AJ 12 to 2x AJ 14) combined with new purchases.',
      'The refund is already processed and donation info was already given. This is a simple thank-you closing.',
      'This is a business_outreach message. Nikko is pitching Redo, a third-party returns/exchange service, unsolicited.',
    ];
    for (const p of preambles) {
      const out = stripPreGreetingNarration(`${p}\n\nHi Sam,\n\nBody text.\n\nJamie`);
      assert.equal(out.text, 'Hi Sam,\n\nBody text.\n\nJamie');
      assert.ok(out.stripped.length > 0);
    }
  });
});
