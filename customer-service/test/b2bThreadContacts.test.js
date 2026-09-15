/**
 * threadContacts: everyone on the conversation becomes a contact — the rules
 * that decide who, pinned without a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitDisplayName, peopleFromMessage, planThreadContacts } = require('../../b2b-outreach/lib/threadContacts');
const { computeThreadAudience, pickReplyAnchor } = require('../../b2b-outreach/lib/replyCc');

test('splitDisplayName reads "Last, First" and "First Last", and refuses non-people', () => {
  assert.deepEqual(splitDisplayName('"Frandsen, Ash"'), { first_name: 'Ash', last_name: 'Frandsen', full_name: 'Ash Frandsen' });
  assert.deepEqual(splitDisplayName('Garcia, Isa'), { first_name: 'Isa', last_name: 'Garcia', full_name: 'Isa Garcia' });
  assert.deepEqual(splitDisplayName('Kim Marks'), { first_name: 'Kim', last_name: 'Marks', full_name: 'Kim Marks' });
  assert.deepEqual(splitDisplayName('M Torres'), { first_name: 'M', last_name: 'Torres', full_name: 'M Torres' });
  assert.equal(splitDisplayName('TheQCorner'), null);        // one word: a mailbox, not a person
  assert.equal(splitDisplayName('Youth Services Team'), null); // a team
  assert.equal(splitDisplayName('kim@asyoulikeitshop.com'), null);
  assert.equal(splitDisplayName(''), null);
  assert.equal(splitDisplayName(null), null);
});

test('peopleFromMessage merges header people with the record\'s address strings, names winning', () => {
  const people = peopleFromMessage({
    from_email: 'theqcorner@hhs.sccgov.org', from_name: 'TheQCorner',
    to_email: 'jamie@rubyshines.com',
    cc_email: '"musquiz, alicia.musquiz@hhs.sccgov.org, "frandsen, ash.frandsen@hhs.sccgov.org',
    people: [{ email: 'ash.frandsen@hhs.sccgov.org', name: 'Frandsen, Ash' }],
  });
  assert.deepEqual(people.map(p => p.email).sort(), [
    'alicia.musquiz@hhs.sccgov.org', 'ash.frandsen@hhs.sccgov.org', 'jamie@rubyshines.com', 'theqcorner@hhs.sccgov.org',
  ]);
  assert.equal(people.find(p => p.email === 'ash.frandsen@hhs.sccgov.org').name, 'Frandsen, Ash');
  assert.equal(people.find(p => p.email === 'alicia.musquiz@hhs.sccgov.org').name, null);
});

const qCorner = { id: 'the-q-corner', website: 'https://bhsd.santaclaracounty.gov/2slgbtqia', general_email: 'theqcorner@hhs.sccgov.org' };

test('planThreadContacts: colleagues at a known domain are added, non-primary, named from the header', () => {
  const { add, skipped } = planThreadContacts({
    company: qCorner,
    senders: ['theqcorner@hhs.sccgov.org'],
    people: [
      { email: 'theqcorner@hhs.sccgov.org', name: 'TheQCorner' },
      { email: 'jamie@rubyshines.com', name: null },
      { email: 'ash.frandsen@hhs.sccgov.org', name: 'Frandsen, Ash' },
      { email: 'alicia.musquiz@hhs.sccgov.org', name: null },
    ],
    existing: [], onFile: [], today: new Date('2026-09-14T12:00:00Z'),
  });
  assert.deepEqual(add.map(r => r.email), ['theqcorner@hhs.sccgov.org', 'ash.frandsen@hhs.sccgov.org', 'alicia.musquiz@hhs.sccgov.org']);
  const ash = add.find(r => r.email === 'ash.frandsen@hhs.sccgov.org');
  assert.equal(ash.full_name, 'Ash Frandsen');
  assert.equal(ash.first_name, 'Ash');
  assert.equal(ash.is_primary, false);
  assert.equal(ash.is_active, true);
  assert.equal(ash.company_id, 'the-q-corner');
  assert.equal(ash.source, 'thread_header');
  assert.match(ash.notes, /2026-09-14/);
  assert.equal(add.find(r => r.email === 'theqcorner@hhs.sccgov.org').full_name, null); // not a person's name
  assert.deepEqual(skipped, []); // ours is silently ignored, not reported
});

test('planThreadContacts: the gate — free mail, unknown domains, other companies, system mailboxes, already on file', () => {
  const { add, skipped } = planThreadContacts({
    company: { id: 'colage', website: 'https://colage.org', general_email: 'research@colage.org' },
    senders: ['katyc@colage.org'],
    people: [
      { email: 'katyc@colage.org', name: 'Katy Chatel' },        // on file already
      { email: 'asha@colage.org', name: null },                  // colleague: add
      { email: 'friend@gmail.com', name: 'A Friend' },           // free mail: report
      { email: 'someone@otherorg.org', name: null },             // domain the company is not known by
      { email: 'shared@partner.org', name: null },               // on file for another company
      { email: 'postmaster@colage.org', name: null },            // system mailbox
    ],
    existing: [{ email: 'katyc@colage.org', company_id: 'colage' }, { email: 'shared@partner.org', company_id: 'partner' }],
    onFile: [{ email: 'katyc@colage.org' }],
  });
  assert.deepEqual(add.map(r => r.email), ['asha@colage.org']);
  assert.deepEqual(skipped.map(s => [s.email, s.reason]), [
    ['katyc@colage.org', 'on_file'],
    ['friend@gmail.com', 'generic_domain'],
    ['someone@otherorg.org', 'unknown_domain'],
    ['shared@partner.org', 'other_company'],
    ['postmaster@colage.org', 'system_mailbox'],
  ]);
});

test('planThreadContacts: the sender\'s domain counts even when the company row says nothing', () => {
  // The Q Corner's website is a county page; every person is at hhs.sccgov.org,
  // which only the correlated sender vouches for.
  const { add } = planThreadContacts({
    company: { id: 'the-q-corner', website: 'https://bhsd.santaclaracounty.gov/x', general_email: null },
    senders: ['isa.garcia@hhs.sccgov.org'],
    people: [{ email: 'isa.garcia@hhs.sccgov.org', name: 'Garcia, Isa' }, { email: 'sela.castro@hhs.sccgov.org', name: null }],
    existing: [], onFile: [],
  });
  assert.deepEqual(add.map(r => r.email), ['isa.garcia@hhs.sccgov.org', 'sela.castro@hhs.sccgov.org']);
  // With no company and no sender, nobody can be attributed.
  assert.deepEqual(planThreadContacts({ company: null, senders: [], people: [{ email: 'x@y.org' }] }).add, []);
});

test('computeThreadAudience: everyone on the newest real message, minus us', () => {
  const msgs = [
    { direction: 'outbound', message_type: 'operator_message', from_email: 'jamie@rubyshines.com', to_email: 'theqcorner@hhs.sccgov.org', cc_email: null, sent_at: '2026-09-14T17:25:55Z' },
    { direction: 'inbound', message_type: null, from_email: 'theqcorner@hhs.sccgov.org', to_email: 'jamie@rubyshines.com',
      cc_email: '"musquiz, alicia.musquiz@hhs.sccgov.org, "frandsen, ash.frandsen@hhs.sccgov.org, "castro, sela.castro@hhs.sccgov.org', sent_at: '2026-09-14T22:08:21Z' },
    { direction: 'inbound', message_type: 'auto_reply', from_email: 'bot@hhs.sccgov.org', to_email: 'jamie@rubyshines.com', cc_email: 'nobody@hhs.sccgov.org', sent_at: '2026-09-14T23:00:00Z' },
  ];
  const audience = computeThreadAudience(pickReplyAnchor(msgs), 'jamie@rubyshines.com');
  assert.deepEqual(audience, ['theqcorner@hhs.sccgov.org', 'alicia.musquiz@hhs.sccgov.org', 'ash.frandsen@hhs.sccgov.org', 'sela.castro@hhs.sccgov.org']);
  // An outbound anchor: whoever we wrote to and copied.
  assert.deepEqual(computeThreadAudience(msgs[0], 'jamie@rubyshines.com'), ['theqcorner@hhs.sccgov.org']);
  assert.deepEqual(computeThreadAudience(null, 'jamie@rubyshines.com'), []);
});
