/**
 * Unit tests for composeOutboundDraft.js — pure helpers + parsing logic.
 *
 * The Anthropic call itself is not exercised here (covered indirectly by the
 * holdout harness when we add outbound scenarios). This file pins the
 * deterministic plumbing: prompt assembly from context, JSON extraction
 * from model output, plain→html conversion.
 *
 * Run: node --test customer-service/test/composeOutboundDraft.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserMessage,
  parseJsonResponse,
  plainToHtml,
  normalizeProposedAction,
  OUTREACH_ACTION_TYPES,
} = require('../lib/composeOutboundDraft');

const SAMPLE_CONTEXT = {
  customer: {
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    numberOfOrders: '3',
    defaultAddress: { countryCodeV2: 'US' },
  },
  orders: [
    {
      name: '#12345',
      createdAt: '2026-04-20T15:00:00Z',
      displayFulfillmentStatus: 'UNFULFILLED',
      displayFinancialStatus: 'PAID',
      currentTotalPriceSet: { shopMoney: { amount: '78.00', currencyCode: 'USD' } },
      lineItems: [
        { sku: 'GAF-BLK-S', title: 'THE NAOMI GAFF', quantity: 1 },
        { sku: 'HLA-SND-M', title: 'THE SASSY NO-TUCK SHAPING UNDERWEAR', quantity: 2 },
      ],
      shippingAddress: { address1: '123 Main', city: 'Brooklyn', province: 'NY', zip: '11201', country: 'US' },
    },
  ],
};

describe('buildUserMessage', () => {
  it('includes the order number, line items, ship-to, customer email, and steer', () => {
    const out = buildUserMessage({
      context: SAMPLE_CONTEXT,
      orderNumber: '12345',
      steer: 'Back-order heads-up — Naomi gaff is sold out, offer cancel or swap',
    });
    assert.match(out, /#12345/);
    assert.match(out, /THE NAOMI GAFF.*GAF-BLK-S/);
    assert.match(out, /THE SASSY NO-TUCK SHAPING UNDERWEAR.*HLA-SND-M/);
    assert.match(out, /123 Main/);
    assert.match(out, /Brooklyn/);
    assert.match(out, /jane@example\.com/);
    assert.match(out, /\[OPERATOR STEER\]/);
    assert.match(out, /Naomi gaff is sold out/);
    assert.match(out, /Compose the outbound email now/);
  });

  it('handles missing target order gracefully — falls back to first order in list', () => {
    const out = buildUserMessage({
      context: SAMPLE_CONTEXT,
      orderNumber: '99999', // not in orders
      steer: 'test',
    });
    // First order's data should appear (fallback)
    assert.match(out, /THE NAOMI GAFF/);
  });

  it('strips leading # from incoming order numbers when matching', () => {
    const out = buildUserMessage({
      context: SAMPLE_CONTEXT,
      orderNumber: '#12345',
      steer: 'test',
    });
    assert.match(out, /THE NAOMI GAFF/);
  });
});

describe('parseJsonResponse', () => {
  it('parses a clean JSON object', () => {
    const obj = parseJsonResponse('{"subject": "Hi", "body": "Hello", "summary": "test"}');
    assert.equal(obj.subject, 'Hi');
    assert.equal(obj.body, 'Hello');
    assert.equal(obj.summary, 'test');
  });

  it('strips ```json fences', () => {
    const wrapped = '```json\n{"subject": "S", "body": "B"}\n```';
    const obj = parseJsonResponse(wrapped);
    assert.equal(obj.subject, 'S');
    assert.equal(obj.body, 'B');
  });

  it('strips bare ``` fences', () => {
    const wrapped = '```\n{"subject": "S", "body": "B"}\n```';
    const obj = parseJsonResponse(wrapped);
    assert.equal(obj.subject, 'S');
  });

  it('extracts JSON from text with leading commentary', () => {
    const messy = 'Here is the draft:\n{"subject": "S", "body": "B"}\nDone.';
    const obj = parseJsonResponse(messy);
    assert.equal(obj.subject, 'S');
  });

  it('throws a clear error when no JSON is parseable', () => {
    assert.throws(() => parseJsonResponse('no json here at all'), /did not return valid JSON/);
  });
});

describe('normalizeProposedAction', () => {
  it('passes through a valid action_type + summary pair', () => {
    const out = normalizeProposedAction({
      action_type: 'exchange',
      operator_action_summary: '  Exchange RUBY-BLK-M -> RUBY-BLK-L, ship now.  ',
    });
    assert.equal(out.actionType, 'exchange');
    assert.equal(out.operatorActionSummary, 'Exchange RUBY-BLK-M -> RUBY-BLK-L, ship now.');
    assert.equal(out.dropped, false);
  });

  it('accepts every whitelisted action type', () => {
    for (const type of OUTREACH_ACTION_TYPES) {
      const out = normalizeProposedAction({ action_type: type, operator_action_summary: 'do the thing' });
      assert.equal(out.actionType, type);
    }
  });

  it('drops an unrecognized action_type (and flags it)', () => {
    const out = normalizeProposedAction({
      action_type: 'ship_stuff',
      operator_action_summary: 'ship the stuff',
    });
    assert.equal(out.actionType, null);
    assert.equal(out.operatorActionSummary, null);
    assert.equal(out.dropped, true);
  });

  it('drops a valid type with an empty summary (and flags it)', () => {
    const out = normalizeProposedAction({ action_type: 'refund', operator_action_summary: '   ' });
    assert.equal(out.actionType, null);
    assert.equal(out.dropped, true);
  });

  it('returns clean nulls (not dropped) when the model proposed no action', () => {
    for (const parsed of [{}, { action_type: null, operator_action_summary: null }]) {
      const out = normalizeProposedAction(parsed);
      assert.equal(out.actionType, null);
      assert.equal(out.operatorActionSummary, null);
      assert.equal(out.dropped, false);
    }
  });
});

describe('plainToHtml', () => {
  it('wraps non-empty lines in <p>', () => {
    const html = plainToHtml('Hi there\n\nSecond line');
    assert.match(html, /<p>Hi there<\/p>/);
    assert.match(html, /<p>Second line<\/p>/);
  });

  it('groups consecutive bullet lines into a single <ul>', () => {
    const html = plainToHtml('Options:\n- A\n- B\n- C\nThanks');
    // Single ul wrapping all three lis
    const ulMatches = html.match(/<ul>/g) || [];
    assert.equal(ulMatches.length, 1);
    assert.match(html, /<li>A<\/li><li>B<\/li><li>C<\/li>/);
    assert.match(html, /<p>Thanks<\/p>/);
  });

  it('escapes html special characters', () => {
    const html = plainToHtml('5 < 6 & 7 > 0');
    assert.match(html, /5 &lt; 6 &amp; 7 &gt; 0/);
  });
});
