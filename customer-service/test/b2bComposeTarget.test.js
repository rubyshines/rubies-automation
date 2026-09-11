// The empty composer's recipient line: what a typed message will become before
// any draft row exists — the thread it inherits and the reply-all cc that thread
// implies — and the recipient merge every save path shares.
const { test } = require('node:test');
const assert = require('node:assert');
const { composeTarget, mergeRecipients, composeInheritEntry } = require('../../b2b-outreach/lib/queueService');
const { replyWaiting } = require('../../b2b-outreach/lib/queue');

const OUR = 'jamie@rubyshines.com';

const threads = [
  {
    id: 659, subject: 'Would love your support for Atlanta Family Weekend',
    messages: [
      { direction: 'inbound', message_type: null, from_email: 'katyc@colage.org', to_email: OUR, cc_email: 'asha@colage.org', sent_at: '2026-09-10T17:34:44Z' },
    ],
  },
  {
    id: 586, subject: 'Our September call',
    messages: [
      { direction: 'outbound', message_type: 'meeting_confirmation', from_email: OUR, to_email: 'katyc@colage.org', cc_email: null, sent_at: '2026-09-09T19:36:03Z' },
    ],
  },
];

test('a Tier-1 reply entry targets its thread, with the cc the contact kept on it', () => {
  const t = composeTarget({ entry: { tier: 1, thread_id: 659 }, threads, ourEmail: OUR });
  assert.deepEqual(t, {
    thread_id: 659,
    subject: 'Would love your support for Atlanta Family Weekend',
    // What the Subject box shows, and what the send path computes for a blank
    // box — one helper, so a pre-filled box cannot send something different.
    reply_subject: 'Re: Would love your support for Atlanta Family Weekend',
    cc: 'asha@colage.org',
  });
});

test('a thread with nobody else on it targets the thread and no cc', () => {
  const t = composeTarget({ entry: { tier: 3, thread_id: 586 }, threads, ourEmail: OUR });
  assert.deepEqual(t, {
    thread_id: 586, subject: 'Our September call', reply_subject: 'Re: Our September call', cc: null,
  });
});

test('no entry, or an entry with no thread, is a fresh email: no target', () => {
  assert.equal(composeTarget({ entry: undefined, threads, ourEmail: OUR }), null);
  assert.equal(composeTarget({ entry: { tier: 4, message_type: 'intro_pitch' }, threads, ourEmail: OUR }), null);
});

test('an entry naming a thread the payload does not hold still threads, with no cc claimed', () => {
  const t = composeTarget({ entry: { tier: 1, thread_id: 999 }, threads, ourEmail: OUR });
  assert.deepEqual(t, { thread_id: 999, subject: null, reply_subject: null, cc: null });
});

test('machine mail never sets the audience: the anchor is the newest real message', () => {
  const t = composeTarget({
    entry: { tier: 1, thread_id: 1 },
    threads: [{
      id: 1, subject: 's',
      messages: [
        { direction: 'inbound', message_type: null, from_email: 'a@org.com', to_email: OUR, cc_email: 'b@org.com', sent_at: '2026-09-01T00:00:00Z' },
        { direction: 'inbound', message_type: 'auto_reply', from_email: 'a@org.com', to_email: OUR, cc_email: null, sent_at: '2026-09-02T00:00:00Z' },
      ],
    }],
    ourEmail: OUR,
  });
  assert.equal(t.cc, 'b@org.com');
});

test('replyWaiting: they wrote last, or ever and we never did', () => {
  assert.equal(replyWaiting({ lastInboundAt: '2026-09-10T17:34:44Z', lastOutboundAt: '2026-09-09T19:36:03Z' }), true);
  assert.equal(replyWaiting({ lastInboundAt: '2026-09-10T17:34:44Z', lastOutboundAt: null }), true);
  assert.equal(replyWaiting({ lastInboundAt: '2026-09-08T00:00:00Z', lastOutboundAt: '2026-09-09T19:36:03Z' }), false);
  assert.equal(replyWaiting({ lastInboundAt: null, lastOutboundAt: '2026-09-09T19:36:03Z' }), false);
  assert.equal(replyWaiting(undefined), false);
});

test('composeInheritEntry: a queue entry always wins', () => {
  const entry = { tier: 3, message_type: 'followup_1', thread_id: 586 };
  assert.equal(composeInheritEntry(entry, { lastInboundAt: '2026-09-10T17:34:44Z', lastInboundThreadId: 659 }), entry);
});

test('composeInheritEntry: claimed On Me, the reply still goes in the thread they wrote in', () => {
  // Deferred → assembleQueue returned nothing, but the mail is sitting there.
  const ctx = { lastInboundAt: '2026-09-10T17:34:44Z', lastInboundThreadId: 659, lastOutboundAt: '2026-09-09T19:36:03Z' };
  assert.deepEqual(composeInheritEntry(undefined, ctx), { thread_id: 659 });
});

test('composeInheritEntry: nothing waiting and nothing due is a fresh email', () => {
  const answered = { lastInboundAt: '2026-09-08T00:00:00Z', lastInboundThreadId: 586, lastOutboundAt: '2026-09-09T19:36:03Z' };
  assert.equal(composeInheritEntry(undefined, answered), undefined);
  assert.equal(composeInheritEntry(undefined, {}), undefined);
  assert.equal(composeInheritEntry(undefined, { lastInboundAt: '2026-09-10T17:34:44Z', lastInboundThreadId: null }), undefined);
});

test('mergeRecipients: undefined leaves a field alone, empty string clears it, text is trimmed', () => {
  const base = { cc: 'asha@colage.org', attachments: ['x'] };
  assert.deepEqual(mergeRecipients(base, {}), base, 'untouched');
  assert.deepEqual(mergeRecipients(base, { to: ' katy@colage.org ' }), { ...base, to: 'katy@colage.org' });
  assert.deepEqual(mergeRecipients(base, { cc: '' }), { attachments: ['x'] }, 'an explicit empty cc is "cc nobody"');
  assert.deepEqual(mergeRecipients(base, { cc: '   ' }), { attachments: ['x'] });
  assert.deepEqual(mergeRecipients(null, { cc: 'a@b.co' }), { cc: 'a@b.co' });
  assert.deepEqual(base, { cc: 'asha@colage.org', attachments: ['x'] }, 'pure: the input is never mutated');
});

// The Subject box is pre-filled from this, so it has to produce exactly what
// sendB2bEmail computes when the box is left blank — that equivalence is the
// only reason pre-filling is safe.
const { replySubject } = require('../../b2b-outreach/lib/replyCc');

test('replySubject prefixes once, keeps an existing Re: whatever its case', () => {
  assert.equal(replySubject('Our September call'), 'Re: Our September call');
  assert.equal(replySubject('Re: Our September call'), 'Re: Our September call');
  assert.equal(replySubject('RE: Our September call'), 'RE: Our September call');
  assert.equal(replySubject('  Our September call  '), 'Re: Our September call');
});

test('replySubject has nothing to inherit for a brand-new email', () => {
  // Null, not '': the send path treats a missing subject on a new thread as an
  // error to refuse, and '' would sail past that check as a real subject.
  assert.equal(replySubject(null), null);
  assert.equal(replySubject(''), null);
  assert.equal(replySubject('   '), null);
});
