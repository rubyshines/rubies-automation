const { test } = require('node:test');
const assert = require('node:assert');
const { draftSnippet, attachDrafts, mergePendingDraftEntries } = require('../../b2b-outreach/lib/queueService');

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

test('mergePendingDraftEntries ignores drafts whose company is out of scope (channel filter)', () => {
  const out = mergePendingDraftEntries([],
    [{ id: 3, company_id: 'unknown-co', message_type: 'intro_pitch', queue_tier: 4 }],
    companiesById,
  );
  assert.deepEqual(out, []);
});
