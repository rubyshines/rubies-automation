/**
 * Unit tests for lib/signatures.js — shared CS email sign-off + advocacy P.S.
 *
 * Run: node --test customer-service/test/signatures.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SIGNATURE_NAME, SITE_URL, SITE_LABEL, SIGNATURE_BLOCK_MD, signOff, signOffHtml, ADVOCACY_PS } = require('../lib/signatures');

// Em-dash (—), en-dash (–), double-hyphen, and emojis are banned in customer copy.
const BANNED = /[—–]|--|[✀-➿]|[\u{1F000}-\u{1FAFF}]|[☀-⛿]|✨/u;

describe('signatures', () => {
  it('name is on one line with the title, no tagline/emoji/dashes', () => {
    assert.equal(SIGNATURE_NAME, 'Jamie Alexander, RUBIES Founder');
    assert.ok(!/Every girl deserves to shine/.test(SIGNATURE_NAME), 'tagline removed');
    assert.ok(!BANNED.test(SIGNATURE_NAME), 'no emoji or dashes');
  });

  it('markdown block (AI paths) links the site so it autolinks on send', () => {
    assert.match(SIGNATURE_BLOCK_MD, /^Jamie Alexander, RUBIES Founder\n/);
    assert.ok(SIGNATURE_BLOCK_MD.includes(`[${SITE_LABEL}](${SITE_URL})`), 'site is a markdown link');
    assert.ok(!/Every girl deserves to shine/.test(SIGNATURE_BLOCK_MD));
  });

  it('signOff has a blank line after the valediction and clean site text', () => {
    assert.ok(signOff().startsWith('Talk soon,\n\n'), 'blank line after valediction');
    assert.ok(signOff('Take care,').startsWith('Take care,\n\n'));
    assert.match(signOff(), /Jamie Alexander, RUBIES Founder/);
    assert.ok(signOff().endsWith(SITE_LABEL), 'plain-text site label, no markdown');
    assert.ok(!signOff().includes(']('), 'plain text has no markdown link syntax');
  });

  it('signOffHtml has a real link, a blank line, and no raw newlines', () => {
    const html = signOffHtml('Take care,');
    assert.ok(html.startsWith('<p>Take care,<br><br>'), 'blank line after valediction');
    assert.ok(html.includes(`<a href="${SITE_URL}">${SITE_LABEL}</a>`), 'site is a real link');
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
