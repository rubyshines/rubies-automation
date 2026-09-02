// Reply-all cc derivation: the audience of a reply is everyone the anchor
// message kept on the conversation, minus us and whoever becomes the To.
const { test } = require('node:test');
const assert = require('node:assert');

const { splitAddresses, pickReplyAnchor, computeReplyCc } = require('../../b2b-outreach/lib/replyCc');

const OUR = 'jamie@rubyshines.com';

test('splitAddresses reads bare and display-name forms, lowercased', () => {
  assert.deepEqual(
    splitAddresses('Ez <Ez@TGV.org.au>, help@org.com'),
    ['ez@tgv.org.au', 'help@org.com']
  );
  assert.deepEqual(splitAddresses(null), []);
  assert.deepEqual(splitAddresses(''), []);
});

test('inbound anchor: their cc and their other To recipients ride the reply, sender and we do not', () => {
  const cc = computeReplyCc({
    direction: 'inbound',
    from_email: 'director@org.com',
    to_email: 'jamie@rubyshines.com, board@org.com',
    cc_email: 'colleague@org.com',
  }, OUR);
  assert.equal(cc, 'colleague@org.com, board@org.com');
});

test('outbound anchor: a chase keeps whoever we cc last time; its To is not duplicated into cc', () => {
  const cc = computeReplyCc({
    direction: 'outbound',
    from_email: 'jamie@rubyshines.com',
    to_email: 'director@org.com',
    cc_email: 'colleague@org.com',
  }, OUR);
  assert.equal(cc, 'colleague@org.com');
});

test('nobody beyond the To recipient → null, and a missing anchor → null', () => {
  assert.equal(computeReplyCc({
    direction: 'inbound', from_email: 'director@org.com',
    to_email: 'jamie@rubyshines.com', cc_email: null,
  }, OUR), null);
  assert.equal(computeReplyCc(null, OUR), null);
});

test('duplicates collapse across cc and to', () => {
  const cc = computeReplyCc({
    direction: 'inbound',
    from_email: 'director@org.com',
    to_email: 'Colleague <colleague@org.com>, jamie@rubyshines.com',
    cc_email: 'colleague@org.com',
  }, OUR);
  assert.equal(cc, 'colleague@org.com');
});

test('pickReplyAnchor takes the newest REAL message and skips machine mail', () => {
  const anchor = pickReplyAnchor([
    { direction: 'inbound', message_type: null, sent_at: '2026-08-01T00:00:00Z', from_email: 'old@org.com' },
    { direction: 'inbound', message_type: null, sent_at: '2026-08-20T00:00:00Z', from_email: 'director@org.com' },
    { direction: 'inbound', message_type: 'auto_reply', sent_at: '2026-08-21T00:00:00Z', from_email: 'director@org.com' },
    { direction: 'inbound', message_type: 'calendar_notice', sent_at: '2026-08-22T00:00:00Z', from_email: 'director@org.com' },
    { direction: 'inbound', message_type: 'bounce', sent_at: '2026-08-23T00:00:00Z', from_email: 'mailer-daemon@google.com' },
  ]);
  assert.equal(anchor.from_email, 'director@org.com');
  assert.equal(anchor.sent_at, '2026-08-20T00:00:00Z');
});

test('a typed OUTBOUND message is a real anchor (message_type is a catalog type, not machine mail)', () => {
  const anchor = pickReplyAnchor([
    { direction: 'outbound', message_type: 'community_checkin', sent_at: '2026-08-25T00:00:00Z', cc_email: 'colleague@org.com' },
    { direction: 'inbound', message_type: null, sent_at: '2026-08-20T00:00:00Z' },
  ]);
  assert.equal(anchor.message_type, 'community_checkin');
});

test('no real correspondence at all → no anchor', () => {
  assert.equal(pickReplyAnchor([
    { direction: 'inbound', message_type: 'auto_reply', sent_at: '2026-08-21T00:00:00Z' },
  ]), null);
  assert.equal(pickReplyAnchor([]), null);
});
