const { test } = require('node:test');
const assert = require('node:assert');
const {
  draftSnippet, attachDrafts, mergePendingDraftEntries, SCHEDULED_STALE_HOURS,
  sanitizeSearchTerm, rollupThreads, companyThreadStatus, companyStage, matchReason,
} = require('../../b2b-outreach/lib/queueService');

// ── draftSnippet ────────────────────────────────────────────────────────────

test('draftSnippet collapses whitespace and newlines', () => {
  assert.equal(draftSnippet('Hi there,\n\nThanks   for reaching out.\n'), 'Hi there, Thanks for reaching out.');
});

test('draftSnippet truncates long bodies with an ellipsis', () => {
  const body = 'word '.repeat(100);
  const out = draftSnippet(body, 50);
  assert.ok(out.length <= 50);
  assert.ok(out.endsWith('…'));
});

test('draftSnippet returns short bodies untouched', () => {
  assert.equal(draftSnippet('Short note.'), 'Short note.');
});

test('draftSnippet handles null/empty body', () => {
  assert.equal(draftSnippet(null), '');
  assert.equal(draftSnippet(''), '');
});

test('draftSnippet does not leave trailing space before the ellipsis', () => {
  const out = draftSnippet('aaaa bbbb cccc dddd', 11); // cut lands right after a space
  assert.ok(!out.includes(' …'));
});

// ── attachDrafts ────────────────────────────────────────────────────────────

const queue = [
  { company_id: 'shop-a', company_name: 'Shop A', channel: 'wholesale', tier: 3, message_type: 'reorder_nudge', reason: '90d since last order' },
  { company_id: 'org-b', company_name: 'Org B', channel: 'lgbtq_org', tier: 1, message_type: null, reason: 'replied 2h ago — waiting on us' },
];

test('attachDrafts joins pending draft id + snippet onto matching entries', () => {
  const out = attachDrafts(queue, [
    { id: 7, company_id: 'shop-a', subject: 'Time to restock?', body: 'Hi!\nIt has been a while…', generated_at: '2026-06-10T00:00:00Z' },
  ]);
  assert.equal(out[0].draft.id, 7);
  assert.equal(out[0].draft.subject, 'Time to restock?');
  assert.equal(out[0].draft.snippet, 'Hi! It has been a while…');
  assert.equal(out[0].draft.generated_at, '2026-06-10T00:00:00Z');
  assert.equal(out[1].draft, null);
});

test('attachDrafts preserves entry fields and order', () => {
  const out = attachDrafts(queue, []);
  assert.deepEqual(out.map(e => e.company_id), ['shop-a', 'org-b']);
  assert.equal(out[0].tier, 3);
  assert.equal(out[1].reason, 'replied 2h ago — waiting on us');
  assert.ok(out.every(e => e.draft === null));
});

test('attachDrafts handles empty/null inputs', () => {
  assert.deepEqual(attachDrafts([], []), []);
  assert.deepEqual(attachDrafts(null, null), []);
});

// ── mergePendingDraftEntries ────────────────────────────────────────────────
// Companies with a pending draft are excluded by companyEligible (the sweep
// must not double-draft) — the dashboard queue synthesizes their rows from
// the draft's stored queue fields.

const companiesById = new Map([
  ['shop-a', { id: 'shop-a', name: 'Shop A', relationship_type: 'wholesale' }],
  ['org-c', { id: 'org-c', name: 'Org C', relationship_type: 'lgbtq_org' }],
  ['aff-d', { id: 'aff-d', name: 'Aff D', relationship_type: 'affiliate' }],
]);

test('mergePendingDraftEntries synthesizes rows for pending-draft companies, sorted by tier', () => {
  const out = mergePendingDraftEntries(
    [{ company_id: 'shop-a', company_name: 'Shop A', channel: 'wholesale', tier: 5, message_type: null, reason: 'follow-up overdue 3d' }],
    [{ id: 9, company_id: 'org-c', message_type: 'community_checkin', queue_tier: 3, queue_reason: 'pride window' }],
    companiesById,
  );
  assert.deepEqual(out.map(e => e.company_id), ['org-c', 'shop-a']); // tier 3 before tier 5
  assert.equal(out[0].company_name, 'Org C');
  assert.equal(out[0].channel, 'lgbtq_org');
  assert.equal(out[0].tier, 3);
  assert.equal(out[0].reason, 'pride window');
});

test('mergePendingDraftEntries skips companies already in the queue (Tier-1 reply case)', () => {
  const out = mergePendingDraftEntries(
    [{ company_id: 'shop-a', company_name: 'Shop A', channel: 'wholesale', tier: 1, message_type: null, reason: 'replied 2h ago — waiting on us', waiting_since: '2026-06-10T08:00:00Z' }],
    [{ id: 4, company_id: 'shop-a', message_type: 'reorder_nudge', queue_tier: 3, queue_reason: '90d since last order' }],
    companiesById,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 1);
});

test('mergePendingDraftEntries defaults tier/reason when the draft has none', () => {
  const out = mergePendingDraftEntries([],
    [{ id: 2, company_id: 'aff-d', message_type: 'affiliate_invite', queue_tier: null, queue_reason: null }],
    companiesById,
  );
  assert.equal(out[0].tier, 3);
  assert.equal(out[0].reason, 'pending draft awaiting review');
});

// ── scheduled follow-ups are machine work, not queue work ───────────────────
//
// The automatic ladder writes a `scheduled_send_at` and sends the draft itself,
// in the recipient's mid-morning, behind guards that all run at send time. It is
// not a decision waiting on an operator, so it must not render as one.
test('a scheduled follow-up still on schedule is hidden from the queue', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const out = mergePendingDraftEntries([],
    [{ id: 137, company_id: 'org-c', message_type: 'followup_1', queue_tier: 4, queue_reason: 'no reply 33d after intro_outreach', scheduled_send_at: '2026-08-27T14:00:00Z' }],
    companiesById, now,
  );
  assert.deepEqual(out, [], 'a send that is going to happen on its own is not the operator’s plate');
});

// The other half, and the one that matters more: on 2026-08-27 three scheduled
// follow-ups were held on every fifteen-minute tick by a guard that could never
// pass, and the panel was the only surface where that was visible at all.
// Hiding scheduled sends must never hide scheduled sends that are FAILING.
test('a scheduled follow-up long past its slot comes back, marked stuck', () => {
  const now = new Date('2026-08-27T20:00:00Z');
  const out = mergePendingDraftEntries([],
    [{ id: 137, company_id: 'org-c', message_type: 'followup_1', queue_tier: 4, queue_reason: 'no reply 33d after intro_outreach', scheduled_send_at: '2026-08-27T09:46:00Z' }],
    companiesById, now,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].send_stuck, true);
  assert.match(out[0].reason, /stuck/, 'it must not present itself as fresh work');
});

test('the stale grace is wide enough that a send in flight is not called stuck', () => {
  const scheduled = new Date('2026-08-27T09:46:00Z');
  const justInside = new Date(scheduled.getTime() + (SCHEDULED_STALE_HOURS - 1) * 3600 * 1000);
  const out = mergePendingDraftEntries([],
    [{ id: 137, company_id: 'org-c', message_type: 'followup_1', queue_tier: 4, scheduled_send_at: scheduled.toISOString() }],
    companiesById, justInside,
  );
  assert.deepEqual(out, []);
});

test('an unscheduled pending draft is unaffected — it IS review waiting to happen', () => {
  const out = mergePendingDraftEntries([],
    [{ id: 136, company_id: 'org-c', message_type: 'followup_1', queue_tier: 4, queue_reason: 'no reply 28d after intro_outreach', scheduled_send_at: null }],
    companiesById, new Date('2026-08-27T20:00:00Z'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'no reply 28d after intro_outreach');
  assert.ok(!out[0].send_stuck);
});

// A draft-ready row is one click from sent; an empty row is work not started.
// Synthetic entries used to be appended with a comparator that returned 0 past
// tier, so a stable sort sank every ready draft below every empty row in its
// tier and the panel read as though the empty ones were more urgent.
test('mergePendingDraftEntries sorts draft-ready companies above empty ones in the same tier', () => {
  const empty = (id, name) => ({ company_id: id, company_name: name, channel: 'lgbtq_org', tier: 3, message_type: 'community_checkin', reason: 'back_to_school window, no prior outbound' });
  const out = mergePendingDraftEntries(
    [empty('empty-1', 'Empty One'), empty('empty-2', 'Empty Two')],
    [{ id: 9, company_id: 'org-c', message_type: 'community_checkin', queue_tier: 3, queue_reason: 'partner re-engagement round' }],
    companiesById,
  );
  assert.equal(out[0].company_id, 'org-c', 'the ready draft must come first');
  assert.deepEqual(out.map(e => e.company_id), ['org-c', 'empty-1', 'empty-2']);
});

test('a ready draft does not jump ahead of a more urgent tier', () => {
  const out = mergePendingDraftEntries(
    [{ company_id: 'shop-a', company_name: 'Shop A', channel: 'wholesale', tier: 1, message_type: null, reason: 'replied — waiting on us', waiting_since: '2026-08-01T00:00:00Z' }],
    [{ id: 9, company_id: 'org-c', message_type: 'community_checkin', queue_tier: 3, queue_reason: 'pride window' }],
    companiesById,
  );
  assert.deepEqual(out.map(e => e.company_id), ['shop-a', 'org-c'], 'a person waiting still outranks a ready draft');
});

test('Tier 1 stays oldest-first, and readiness only breaks a genuine tie', () => {
  const out = mergePendingDraftEntries(
    [
      { company_id: 'newer', company_name: 'Newer', channel: 'lgbtq_org', tier: 1, reason: 'waiting', waiting_since: '2026-08-09T00:00:00Z' },
      { company_id: 'older', company_name: 'Older', channel: 'lgbtq_org', tier: 1, reason: 'waiting', waiting_since: '2026-08-01T00:00:00Z' },
    ],
    [{ id: 9, company_id: 'newer', message_type: 'reply', queue_tier: 1 }],
    companiesById,
  );
  assert.deepEqual(out.map(e => e.company_id), ['older', 'newer'],
    'an older unanswered person outranks a newer one even when the newer has a draft');
});

test('mergePendingDraftEntries ignores drafts whose company is out of scope (channel filter)', () => {
  const out = mergePendingDraftEntries([],
    [{ id: 3, company_id: 'unknown-co', message_type: 'intro_pitch', queue_tier: 4 }],
    companiesById,
  );
  assert.deepEqual(out, []);
});

// ── sanitizeSearchTerm ──────────────────────────────────────────────────────
// These characters are PostgREST filter syntax, not search input. Left in, a
// term containing one corrupts the .or() query rather than failing loudly.

test('sanitizeSearchTerm strips PostgREST filter metacharacters', () => {
  assert.equal(sanitizeSearchTerm('Zoe, and Company'), 'Zoe and Company');
  assert.equal(sanitizeSearchTerm('shop (uk)'), 'shop uk');
  assert.equal(sanitizeSearchTerm('a*b%c"d\\e'), 'a b c d e');
});

test('sanitizeSearchTerm keeps characters that are real in emails and domains', () => {
  assert.equal(sanitizeSearchTerm('jane.doe+shop@example.co.uk'), 'jane.doe+shop@example.co.uk');
  assert.equal(sanitizeSearchTerm('early-to-bed'), 'early-to-bed');
});

test('sanitizeSearchTerm collapses whitespace and trims', () => {
  assert.equal(sanitizeSearchTerm('  trans   pride  '), 'trans pride');
  assert.equal(sanitizeSearchTerm(null), '');
  assert.equal(sanitizeSearchTerm(undefined), '');
});

// ── rollupThreads / companyThreadStatus ─────────────────────────────────────

test('rollupThreads counts open vs closed and keeps the latest activity', () => {
  const out = rollupThreads([
    { company_id: 'a', status: 'closed', last_message_at: '2026-03-01T00:00:00Z' },
    { company_id: 'a', status: 'open', last_message_at: '2026-07-01T00:00:00Z' },
    { company_id: 'a', status: 'closed', last_message_at: '2026-05-01T00:00:00Z' },
    { company_id: 'b', status: 'closed', last_message_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.deepEqual(out.get('a'), { open: 1, closed: 2, last_message_at: '2026-07-01T00:00:00Z' });
  assert.deepEqual(out.get('b'), { open: 0, closed: 1, last_message_at: '2026-01-01T00:00:00Z' });
});

test('rollupThreads treats an unknown status as open, never dropping a thread', () => {
  const out = rollupThreads([{ company_id: 'a', status: null, last_message_at: null }]);
  assert.equal(out.get('a').open, 1);
});

test('rollupThreads handles empty input', () => {
  assert.equal(rollupThreads([]).size, 0);
  assert.equal(rollupThreads(null).size, 0);
});

test('companyThreadStatus distinguishes never / open / inactive', () => {
  assert.equal(companyThreadStatus(undefined), 'never');
  assert.equal(companyThreadStatus({ open: 0, closed: 0 }), 'never');
  assert.equal(companyThreadStatus({ open: 1, closed: 4 }), 'open');
  assert.equal(companyThreadStatus({ open: 0, closed: 3 }), 'inactive');
});

// ── matchReason ─────────────────────────────────────────────────────────────
// Searching an email is useless if the row only echoes the company name back:
// the operator needs to see WHICH contact carried that address.

const company = {
  id: 'early-to-bed', name: 'Early to Bed', website: 'https://early2bed.com',
  general_email: 'hello@early2bed.com',
};
const contacts = [{ email: 'jane@early2bed.com', full_name: 'Jane Doe' }];
const threads = [{ subject: 'Purchase Order #11580' }];

test('matchReason stays quiet when the company name already explains the hit', () => {
  assert.equal(matchReason(company, contacts, threads, 'early to bed'), null);
});

test('matchReason names the contact behind an email or person match', () => {
  assert.equal(matchReason(company, contacts, threads, 'jane@early2bed.com'), 'contact: Jane Doe <jane@early2bed.com>');
  assert.equal(matchReason(company, contacts, threads, 'jane doe'), 'contact: Jane Doe <jane@early2bed.com>');
});

test('matchReason falls back through general email, site, thread subject, id', () => {
  assert.equal(matchReason(company, [], [], 'hello@'), 'email: hello@early2bed.com');
  // A domain search hits the general email too; naming the address is the more
  // useful answer, so email is checked before website.
  assert.equal(matchReason(company, [], [], 'early2bed.com'), 'email: hello@early2bed.com');
  assert.equal(matchReason({ ...company, general_email: null }, [], [], 'early2bed.com'), 'site: early2bed.com');
  assert.equal(matchReason(company, [], threads, '11580'), 'thread: Purchase Order #11580');
  assert.equal(matchReason({ id: 'uk-mermaids', name: 'Mermaids' }, [], [], 'uk-'), 'id: uk-mermaids');
});

test('matchReason is case-insensitive and null for an empty query', () => {
  assert.equal(matchReason(company, contacts, threads, 'JANE@EARLY2BED.COM'), 'contact: Jane Doe <jane@early2bed.com>');
  assert.equal(matchReason(company, contacts, threads, ''), null);
});

// ── companyStage ────────────────────────────────────────────────────────────
// Relationship stage ONLY. Conversation state is a separate, composable filter:
// folding them together hid an active retailer with 13 concluded threads under
// `active`, which is exactly the company the closed-thread view exists to find.

test('companyStage reads relationship_state and nothing else', () => {
  assert.equal(companyStage({ relationship_state: 'active' }), 'active');
  assert.equal(companyStage({ relationship_state: 'lost' }), 'lost');
});

test('companyStage calls in_contact a lead — it cannot mean live contact', () => {
  // 180 companies carry in_contact; 172 have never had a conversation.
  assert.equal(companyStage({ relationship_state: 'in_contact' }), 'lead');
  assert.equal(companyStage({}), 'lead');
  assert.equal(companyStage({ relationship_state: null }), 'lead');
});

test('companyStage is independent of conversation history', () => {
  // The regression that motivated the split: an account whose threads all ended
  // is still an account, and companyThreadStatus is what says it went quiet.
  const account = { relationship_state: 'active' };
  assert.equal(companyStage(account), 'active');
  assert.equal(companyThreadStatus({ open: 0, closed: 13 }), 'inactive');
});

// ── deferred companies must not come back via the pending-draft merge ────────
// The panel does not render assembleQueue's output — it renders
// mergePendingDraftEntries, which adds any company holding a pending draft
// WITHOUT consulting the cadence, using the tier/reason frozen on the draft row.
// So pausing a company cleared it from the cadence and the panel still showed
// it, at its old tier, with a stale "now due" reason.

const NOW_D = new Date('2026-08-19T12:00:00Z');

test('a paused company with a stale pending draft stays out of the queue', () => {
  const companies = new Map([['bra-room', {
    id: 'bra-room', name: 'The Bra Room', relationship_type: 'wholesale',
    outreach_paused_at: '2026-08-19T10:00:00Z',
  }]]);
  const merged = mergePendingDraftEntries([], [
    { company_id: 'bra-room', queue_tier: 1, queue_reason: 'promised check-in now due (164d)' },
  ], companies);
  assert.deepEqual(merged, [], 'the pause must survive a leftover draft');
});

test('a snoozed company with a pending draft stays out too', () => {
  const companies = new Map([['fenway', {
    id: 'fenway', name: 'Fenway Health', relationship_type: 'lgbtq_org',
    snoozed_until: '2026-11-01', snoozed_at: '2026-08-19T10:00:00Z',
  }]]);
  const merged = mergePendingDraftEntries([], [{ company_id: 'fenway', queue_tier: 3 }], companies);
  assert.deepEqual(merged, []);
});

test('a lapsed snooze lets the draft show again', () => {
  const companies = new Map([['fenway', {
    id: 'fenway', name: 'Fenway Health', relationship_type: 'lgbtq_org',
    snoozed_until: '2026-01-01', snoozed_at: '2025-12-01T00:00:00Z',
  }]]);
  const merged = mergePendingDraftEntries([], [{ company_id: 'fenway', queue_tier: 3 }], companies);
  assert.equal(merged.length, 1);
});

// The case the exclusion must NOT break: they wrote after the pause, so the
// cadence put them in `queue` legitimately, and a draft exists for that reply.
test('a paused company that replied still shows, with its live Tier 1', () => {
  const companies = new Map([['bra-room', {
    id: 'bra-room', name: 'The Bra Room', relationship_type: 'wholesale',
    outreach_paused_at: '2026-08-01T00:00:00Z',
  }]]);
  const realEntry = { company_id: 'bra-room', company_name: 'The Bra Room', tier: 1, waiting_since: '2026-08-18T00:00:00Z' };
  const merged = mergePendingDraftEntries([realEntry], [{ company_id: 'bra-room', queue_tier: 3 }], companies);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tier, 1, 'the live cadence entry wins, not the frozen draft tier');
});

// On Me is the case this exclusion exists for. Pause and snooze supersede the
// pending draft in triage, so for them the merge guard is a backstop; On Me
// deliberately KEEPS its draft, so without the guard every claimed company would
// be merged straight back into the queue it was claimed out of.
test('a claimed company keeps its draft and still stays out of the queue', () => {
  const companies = new Map([['she-bop', {
    id: 'she-bop', name: 'She Bop', relationship_type: 'wholesale',
    on_me_at: '2026-08-19T10:00:00Z',
  }]]);
  const merged = mergePendingDraftEntries([], [
    { company_id: 'she-bop', queue_tier: 1, queue_reason: 'replied 51d ago — waiting on us' },
  ], companies);
  assert.deepEqual(merged, [], 'On Me must not be undone by the draft it deliberately kept');
});

test('an unpaused company with a pending draft still shows', () => {
  const companies = new Map([['x', { id: 'x', name: 'X', relationship_type: 'wholesale' }]]);
  const merged = mergePendingDraftEntries([], [{ company_id: 'x', queue_tier: 4 }], companies);
  assert.equal(merged.length, 1, 'control: the deferral is what excluded the others');
});

// ── a thread born from a machine ────────────────────────────────────────────
// Gmail threads on subject, so an out-of-office ("Out of Office Re: ...")
// opens a thread of its own with nothing in it a person can act on. The Gmail
// discovery path has always created those closed; live Pub/Sub inbound never
// did, so every auto-reply arriving in real time left a thread to close by
// hand. Four had accumulated, including a calendar acceptance for a call that
// was already booked.
const { classifyInbound, NON_REPLY_INBOUND_TYPES } = require('../../b2b-outreach/lib/replyCorrelation');

test('an out-of-office is classified as a non-reply', () => {
  assert.equal(classifyInbound({ subject: 'Out of Office Re: Donation partner inquiry',
    body: 'Hello! Thank you for reaching out! I am out of town due to a family emergency.' }), 'auto_reply');
  assert.ok(NON_REPLY_INBOUND_TYPES.has('auto_reply'));
});

test('a calendar acceptance is a non-reply, so booking a call cannot queue itself', () => {
  assert.equal(classifyInbound({ subject: 'Accepted: RUBIES x Lumenus Foundation', body: '' }), 'calendar_notice');
});

test('a human reply inside an auto-reply thread stays a reply', () => {
  // The guard that keeps this safe: only a thread whose FIRST message is
  // machine-generated is born closed. A person writing back must never be
  // swallowed by the subject line they happen to be replying under.
  assert.equal(classifyInbound({ subject: 'Re: Out of Office Re: Donation partner inquiry',
    body: 'Hi Jamie, back now — Wednesday works for the call.' }), null);
});
