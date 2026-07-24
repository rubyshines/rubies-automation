// toHtmlBody (clickable RUBIES + links in outbound email) and the
// addProspect slug/refusal logic.
const { test } = require('node:test');
const assert = require('node:assert');
const { toHtmlBody, buildRawMessage } = require('../../b2b-outreach/lib/sendB2bEmail');
const { slugify } = require('../../b2b-outreach/lib/addProspect');

test('first RUBIES mention becomes a store link; later mentions stay plain', () => {
  const html = toHtmlBody('I am Jamie, the founder of RUBIES. RUBIES was inspired by Ruby.');
  const links = html.match(/<a href="https:\/\/rubyshines\.com">RUBIES<\/a>/g) || [];
  assert.equal(links.length, 1);
  assert.ok(html.indexOf('founder of <a') !== -1); // it linked the FIRST one
  assert.ok(html.includes('. RUBIES was inspired'));  // second stays plain
});

test('URLs are linkified and HTML is escaped', () => {
  const html = toHtmlBody('See https://transpridebrighton.org/partners & say <hi>');
  assert.ok(html.includes('<a href="https://transpridebrighton.org/partners">'));
  assert.ok(html.includes('&amp; say &lt;hi&gt;'));
});

test('line breaks become <br>', () => {
  assert.ok(toHtmlBody('a\n\nb').includes('<br>\r\n<br>\r\nb'));
});

test('buildRawMessage emits multipart/alternative with both parts', () => {
  const raw = Buffer.from(buildRawMessage({
    to: 'x@y.org', subject: 'Hello', body: 'Hi from RUBIES\nBye',
  }), 'base64url').toString('utf8');
  assert.ok(raw.includes('Content-Type: multipart/alternative; boundary='));
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(raw.includes('Content-Type: text/html; charset=UTF-8'));
  assert.ok(raw.includes('Hi from RUBIES\nBye')); // plain part verbatim
  assert.ok(raw.includes('<a href="https://rubyshines.com">RUBIES</a>'));
});

test('slugify normalizes names', () => {
  assert.equal(slugify('Not A Phase!'), 'not-a-phase');
  assert.equal(slugify('  Trans Pride  Brighton '), 'trans-pride-brighton');
});
