const test = require('node:test');
const assert = require('node:assert');

const { normalizeBody } = require('../import/exportReplyCorpus');

test('normalizeBody collapses cosmetic variance between templated sends', () => {
  const a = 'Hi Sam,\n\nYour order #12345 shipped! Track it at https://track.me/abc. Email us at care@rubyshines.com.';
  const b = 'Hi Alex,\n\nYour order #99887 shipped! Track it at https://track.me/xyz. Email us at care@rubyshines.com.';
  assert.strictEqual(normalizeBody(a), normalizeBody(b));
});

test('normalizeBody keeps genuinely different bodies distinct', () => {
  const a = 'No problem, I went ahead and created a new order for you.';
  const b = 'Sorry for the delay, our warehouse had a quality control issue.';
  assert.notStrictEqual(normalizeBody(a), normalizeBody(b));
});

test('normalizeBody normalizes numbers, emails, urls, whitespace', () => {
  const n = normalizeBody('Refund of $42.50 sent  to  jo@x.com via https://pay.me #123');
  assert.ok(!/42|jo@x\.com|https/.test(n));
  assert.ok(!/\s{2,}/.test(n));
});
