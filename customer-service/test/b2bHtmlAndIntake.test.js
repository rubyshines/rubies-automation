// toHtmlBody / normalizeSignature (clickable links in outbound email, CS
// signature convention) and the addProspect slug logic.
const { test } = require('node:test');
const assert = require('node:assert');
const { toHtmlBody, normalizeSignature, buildRawMessage } = require('../../b2b-outreach/lib/sendB2bEmail');
const { slugify } = require('../../b2b-outreach/lib/addProspect');

// ── first-mention RUBIES link: intro messages only ──────────────────────────

test('intro messages link the first body RUBIES mention only', () => {
  const html = toHtmlBody('I am Jamie, the founder of RUBIES. RUBIES was inspired by Ruby.', { introLink: true });
  const links = html.match(/<a href="https:\/\/rubyshines\.com">RUBIES<\/a>/g) || [];
  assert.equal(links.length, 1);
  assert.ok(html.indexOf('founder of <a') !== -1); // the FIRST one
  assert.ok(html.includes('. RUBIES was inspired'));  // second stays plain
});

test('non-intro messages never link body RUBIES mentions', () => {
  const html = toHtmlBody('Time to restock your RUBIES styles.', { introLink: false });
  assert.ok(!html.includes('<a href="https://rubyshines.com">RUBIES</a>'));
});

test('the signature RUBIES Founder is never the linked mention', () => {
  const html = toHtmlBody('Talk soon,\nJamie Alexander, RUBIES Founder', { introLink: true });
  assert.ok(!html.includes('<a href="https://rubyshines.com">RUBIES</a> Founder'));
});

// ── signature site line (CS convention) ─────────────────────────────────────

test('normalizeSignature appends rubyshines.com under the signature', () => {
  const out = normalizeSignature('Bye!\n\nTalk soon,\nJamie Alexander, RUBIES Founder');
  assert.ok(out.endsWith('Jamie Alexander, RUBIES Founder\nrubyshines.com'));
});

test('normalizeSignature is idempotent and respects an existing site line', () => {
  const already = 'Talk soon,\nJamie Alexander, RUBIES Founder\nrubyshines.com';
  assert.equal(normalizeSignature(already), already);
  assert.equal(normalizeSignature(normalizeSignature('x\nJamie Alexander, RUBIES Founder')),
    'x\nJamie Alexander, RUBIES Founder\nrubyshines.com');
});

test('bodies without the signature are untouched', () => {
  assert.equal(normalizeSignature('Just a note'), 'Just a note');
});

test('the signature site line renders as a link in HTML', () => {
  const html = toHtmlBody(normalizeSignature('Talk soon,\nJamie Alexander, RUBIES Founder'));
  assert.ok(html.includes('<a href="https://rubyshines.com">rubyshines.com</a>'));
});

// ── full message assembly ───────────────────────────────────────────────────

test('buildRawMessage: intro type gets multipart, linked mention, linked signature', () => {
  const raw = Buffer.from(buildRawMessage({
    to: 'x@y.org', subject: 'Hello', message_type: 'intro_outreach',
    body: 'Hi from RUBIES\n\nTalk soon,\nJamie Alexander, RUBIES Founder',
  }), 'base64url').toString('utf8');
  assert.ok(raw.includes('Content-Type: multipart/alternative; boundary='));
  assert.ok(raw.includes('Hi from RUBIES\n')); // plain part verbatim
  assert.ok(raw.includes('Jamie Alexander, RUBIES Founder\nrubyshines.com')); // sig line in plain part too
  assert.ok(raw.includes('<a href="https://rubyshines.com">RUBIES</a>'));
  assert.ok(raw.includes('<a href="https://rubyshines.com">rubyshines.com</a>'));
});

test('buildRawMessage: non-intro type links signature but not body mentions', () => {
  const raw = Buffer.from(buildRawMessage({
    to: 'x@y.org', subject: 'Re: restock', message_type: 'reorder_nudge',
    body: 'Running low on RUBIES?\n\nTalk soon,\nJamie Alexander, RUBIES Founder',
  }), 'base64url').toString('utf8');
  assert.ok(!raw.includes('<a href="https://rubyshines.com">RUBIES</a>'));
  assert.ok(raw.includes('<a href="https://rubyshines.com">rubyshines.com</a>'));
});

// ── slugify ─────────────────────────────────────────────────────────────────

test('slugify normalizes names', () => {
  assert.equal(slugify('Not A Phase!'), 'not-a-phase');
  assert.equal(slugify('  Trans Pride  Brighton '), 'trans-pride-brighton');
});
