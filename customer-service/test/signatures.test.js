/**
 * Unit tests for lib/signatures.js — shared CS email sign-off + advocacy P.S.
 *
 * Run: node --test customer-service/test/signatures.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SIGNATURE_NAME_BLOCK, signOff, signOffHtml, ADVOCACY_PS } = require('../lib/signatures');

// Em-dash (—), en-dash (–), double-hyphen, and emojis are banned in customer copy.
const BANNED = /[—–]|--|[✀-➿]|[\u{1F000}-\u{1FAFF}]|[☀-⛿]|✨/u;

describe('signatures', () => {
  it('name block is the personal founder block with brand lines, no emoji/dashes', () => {
    assert.match(SIGNATURE_NAME_BLOCK, /Jamie Alexander/);
    assert.match(SIGNATURE_NAME_BLOCK, /RUBIES Founder/);
    assert.match(SIGNATURE_NAME_BLOCK, /Every girl deserves to shine/);
    assert.match(SIGNATURE_NAME_BLOCK, /rubyshines\.com/);
    assert.ok(!BANNED.test(SIGNATURE_NAME_BLOCK), 'name block must have no emoji or dashes');
  });

  it('signOff prepends the valediction and defaults to "Talk soon,"', () => {
    assert.ok(signOff().startsWith('Talk soon,\n'));
    assert.ok(signOff('Take care,').startsWith('Take care,\n'));
    assert.match(signOff(), /Jamie Alexander/);
  });

  it('signOffHtml wraps the sign-off in a paragraph with <br> line breaks', () => {
    const html = signOffHtml('Take care,');
    assert.ok(html.startsWith('<p>Take care,<br>'));
    assert.ok(html.endsWith('</p>'));
    assert.ok(!html.includes('\n'), 'html variant should not contain raw newlines');
  });

  it('advocacy P.S. has both framings, starts with P.S., and (Phase A) has no link', () => {
    for (const key of ['peer_parent', 'peer_self']) {
      const ps = ADVOCACY_PS[key];
      assert.ok(ps, `${key} P.S. exists`);
      assert.match(ps, /^P\.S\. /);
      assert.ok(!/https?:|rubyshines\.com\/help/.test(ps), 'Phase A P.S. must not contain a link');
      assert.ok(!BANNED.test(ps), 'P.S. must have no emoji or dashes');
    }
    assert.match(ADVOCACY_PS.peer_parent, /other families/);
    assert.match(ADVOCACY_PS.peer_self, /others in our community/);
  });
});
