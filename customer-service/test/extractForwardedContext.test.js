/**
 * Unit tests for extractForwardedContext in intake/processGorgiasTickets.js.
 *
 * Gorgias's stripper drops quoted/forwarded blocks. That's correct for a normal
 * reply (prior turns already live in conversation_history) but wrong on a customer's
 * FIRST message when they forward/quote a prior email ("following up on the below
 * message") — the substance IS the stripped block. This helper recovers it for the
 * first-contact case only so the advisor has the context.
 *
 * Run: node --test customer-service/test/extractForwardedContext.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractForwardedContext } = require('../intake/processGorgiasTickets');

const ONELINER = 'Hi there, following up on the below message, I think I sent it to the wrong address!';
const FORWARDED = `${ONELINER}

On Mon, Jun 23, 2026, Kate wrote:
> Hi RUBIES, I just placed order #31328 but I need to change the shipping
> address to 42 New Street, Brooklyn NY 11231. Can you update it before it
> ships? Thanks so much!`;

describe('extractForwardedContext', () => {
  it('recovers the quoted block on a first-contact forward (stripped_text holds only the one-liner)', () => {
    const m = { id: 1, from_agent: false, stripped_text: ONELINER, body_text: FORWARDED };
    const out = extractForwardedContext(m, true);
    assert.ok(out.includes('42 New Street'), 'returns the forwarded content the advisor needs');
  });

  it('returns empty when it is not the first customer message (normal reply — history has it)', () => {
    const m = { id: 1, from_agent: false, stripped_text: ONELINER, body_text: FORWARDED };
    assert.equal(extractForwardedContext(m, false), '');
  });

  it('returns empty when nothing substantial was stripped (no quoted block)', () => {
    const m = { id: 1, from_agent: false, stripped_text: ONELINER, body_text: ONELINER };
    assert.equal(extractForwardedContext(m, true), '');
  });

  it('skips flow transcripts and help-center forms (own parsers)', () => {
    const flow = { id: 1, from_agent: false, meta: { origin: 'flow' }, stripped_text: ONELINER, body_text: FORWARDED };
    const hc = { id: 2, from_agent: false, channel: 'help-center', stripped_text: ONELINER, body_text: FORWARDED };
    assert.equal(extractForwardedContext(flow, true), '');
    assert.equal(extractForwardedContext(hc, true), '');
  });

  it('caps very long quoted chains', () => {
    const huge = ONELINER + '\n' + 'x'.repeat(10000);
    const m = { id: 1, from_agent: false, stripped_text: ONELINER, body_text: huge };
    const out = extractForwardedContext(m, true);
    assert.ok(out.length < huge.length, 'truncates');
    assert.ok(out.endsWith('[...truncated]'));
  });
});
