const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// buildContexts is the expensive half of fetchOnMe (six queries against real
// tables) and none of it is what this file is about, so it is stubbed at the
// module boundary before queueService is required. What IS under test is the
// decision fetchOnMe makes per claimed company — which is exactly where the
// 2026-08-26 bug lived — and, since 2026-09-10, that the list is read from the
// commitments table rather than a stamp on the company.
const CONTEXT_PATH = require.resolve('../../b2b-outreach/lib/queueContext');
let contexts = new Map();
require.cache[CONTEXT_PATH] = {
  id: CONTEXT_PATH, filename: CONTEXT_PATH, loaded: true, exports: {
    buildContexts: async () => contexts,
  },
};

const { fetchOnMe } = require('../../b2b-outreach/lib/queueService');

// Minimal Supabase double: the three tables fetchOnMe reads. Every builder
// method returns `this` and the object is thenable, so it satisfies both
// `await q` after conditional chaining and the `await sb.from(...)...` shape.
function stubSb({ companies = [], drafts = [], commitments = [] } = {}) {
  const make = rows => ({
    select() { return this; },
    not(col, op, val) { return make(rows.filter(r => r[col] !== val)); },
    order(col, { ascending = true } = {}) {
      return make([...rows].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (ascending ? 1 : -1)));
    },
    limit() { return this; },
    eq(col, val) { return make(rows.filter(r => r[col] === val)); },
    in(col, vals) { return make(rows.filter(r => vals.includes(r[col]))); },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  });
  return {
    from(table) {
      if (table === 'b2b_companies') return make(companies);
      if (table === 'b2b_drafts') return make(drafts);
      if (table === 'b2b_commitments') return make(commitments);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const CLAIMED_AT = '2026-08-26T18:07:36Z';
const gsrc = (over = {}) => ({
  id: 'gsrc', name: 'GSRC', relationship_type: 'lgbtq_org',
  relationship_next_step: 'Send tabling cards', ...over,
});
const owed = (over = {}) => ({
  id: 1, company_id: 'gsrc', owner: 'me', status: 'open', source: 'claim',
  text: 'Send tabling cards', created_at: CLAIMED_AT, ...over,
});

test('a claimed company with no reply since is on the list, unflagged, carrying its items', async () => {
  contexts = new Map([['gsrc', { lastInboundAt: '2026-08-19T19:31:22Z' }]]);
  const { entries } = await fetchOnMe(stubSb({ companies: [gsrc()], commitments: [owed()] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].replied_since_claim, false, 'the message he claimed is not a new one');
  assert.equal(entries[0].next_step, 'Send tabling cards');
  assert.equal(entries[0].count, 1);
  assert.equal(entries[0].commitments[0].text, 'Send tabling cards');
  assert.equal(entries[0].on_me_at, CLAIMED_AT, 'the claim date is the oldest open item');
});

// The regression. GSRC replied "Awesome, thanks so much!" three minutes after
// being claimed, which used to retire a claim whose subject was the tabling
// cards Jamie had just promised them — leaving the panel banner saying ON YOU
// while the list it belonged to had dropped it.
test('a reply after the claim keeps the row, and flags it', async () => {
  contexts = new Map([['gsrc', { lastInboundAt: '2026-08-26T18:10:21Z' }]]);
  const { entries } = await fetchOnMe(stubSb({ companies: [gsrc()], commitments: [owed()] }));
  assert.equal(entries.length, 1, 'an acknowledgement is not the work — the claim stands');
  assert.equal(entries[0].replied_since_claim, true, 'and the row has to say they wrote');
});

test('a company whose only open items are theirs is not on me', async () => {
  contexts = new Map([['gsrc', {}]]);
  const { entries } = await fetchOnMe(stubSb({ companies: [gsrc()], commitments: [owed({ owner: 'them' })] }));
  assert.equal(entries.length, 0);
});

test('rows come back oldest claim first, with the pending draft attached', async () => {
  contexts = new Map([['gsrc', {}], ['old', {}]]);
  const { entries } = await fetchOnMe(stubSb({
    companies: [gsrc(), gsrc({ id: 'old', name: 'Older' })],
    commitments: [owed(), owed({ id: 2, company_id: 'old', created_at: '2026-08-01T00:00:00Z' })],
    drafts: [{ id: 7, company_id: 'gsrc', subject: 'Re: donations', body: 'Hi there', status: 'pending' }],
  }));
  assert.deepEqual(entries.map(e => e.company_id), ['old', 'gsrc'],
    'the point of this list is age, so the oldest claim leads');
  assert.equal(entries[1].draft?.id, 7, 'On Me keeps its draft, unlike pause and snooze');
});

test('a cadence hand-off is badged as such, with its note as the reason', async () => {
  contexts = new Map([['gsrc', {}]]);
  const { entries } = await fetchOnMe(stubSb({
    companies: [gsrc()],
    commitments: [owed({ source: 'cadence', text: '3 unanswered since 2026-08-19' })],
  }));
  assert.equal(entries[0].claimed_by, 'cadence');
  assert.equal(entries[0].claim_note, '3 unanswered since 2026-08-19');
});
