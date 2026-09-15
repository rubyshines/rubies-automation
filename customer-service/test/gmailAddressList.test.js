/**
 * The To/Cc header parser. A display name may hold a comma inside quotes
 * (Outlook writes "Last, First"); splitting on every comma made half a cc list
 * into word fragments and lost the people on it (2026-09-14).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitHeaderList, parseMailboxes, parseAddressList } = require('../../gmail-management/lib/gmailSync');

test('a quoted "Last, First" name does not split the list', () => {
  const h = '"Musquiz, Alicia" <alicia.musquiz@hhs.sccgov.org>, "Frandsen, Ash" <ash.frandsen@hhs.sccgov.org>, "Castro, Sela" <sela.castro@hhs.sccgov.org>';
  assert.deepEqual(parseAddressList(h), ['alicia.musquiz@hhs.sccgov.org', 'ash.frandsen@hhs.sccgov.org', 'sela.castro@hhs.sccgov.org']);
  assert.deepEqual(parseMailboxes(h)[1], { email: 'ash.frandsen@hhs.sccgov.org', name: 'Frandsen, Ash' });
});

test('bare addresses, unquoted names and mixed lists', () => {
  assert.deepEqual(parseAddressList('a@x.org'), ['a@x.org']);
  assert.deepEqual(parseAddressList('Kim Marks <kim@asyoulikeitshop.com>, staff@asyoulikeitshop.com'), ['kim@asyoulikeitshop.com', 'staff@asyoulikeitshop.com']);
  assert.deepEqual(parseMailboxes('Kim Marks <Kim@AsYouLikeItShop.com>'), [{ email: 'kim@asyoulikeitshop.com', name: 'Kim Marks' }]);
  assert.deepEqual(parseMailboxes('jamie@rubyshines.com'), [{ email: 'jamie@rubyshines.com', name: null }]);
});

test('a comma inside angle brackets or a malformed unquoted name never yields a fragment', () => {
  // Unquoted "Last, First" is malformed; the name fragment before the comma
  // holds no address and is dropped, the address survives with the rest.
  assert.deepEqual(parseAddressList('Musquiz, Alicia <alicia@x.org>'), ['alicia@x.org']);
  assert.deepEqual(splitHeaderList('"a, b" <a@x.org>, c@x.org'), ['"a, b" <a@x.org>', 'c@x.org']);
  assert.deepEqual(parseAddressList(''), []);
  assert.deepEqual(parseAddressList(null), []);
});
