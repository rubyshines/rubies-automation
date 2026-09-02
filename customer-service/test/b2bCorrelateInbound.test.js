const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Stub the Supabase singleton before requiring the module under test.
const CLIENT_PATH = require.resolve('../../shared/supabaseClient');
let state;

function makeClient() {
  const ok = (data) => Promise.resolve({ data, error: null });
  return {
    from(table) {
      const q = {
        _table: table, _filters: {},
        select() { return q; },
        eq(col, val) { q._filters[col] = val; return q; },
        ilike(col, pat) { q._filters['ilike:' + col] = pat; return q; },
        maybeSingle() {
          if (table === 'b2b_contacts') {
            const hit = state.contacts.find(c => c.email === q._filters.email);
            return ok(hit ? { company_id: hit.company_id } : null);
          }
          if (table === 'b2b_companies') {
            const hit = state.companies.find(c => c.general_email === q._filters.general_email);
            return ok(hit ? { id: hit.id } : null);
          }
          if (table === 'b2b_threads') {
            // Honours company_id when the caller scopes by it — the whole point
            // of the fix is that a company only ever matches its OWN row, so a
            // stub that ignored the filter would green-light the old bug.
            const hit = state.threads.find(t =>
              t.gmail_thread_id === q._filters.gmail_thread_id
              && (q._filters.company_id === undefined || t.company_id === q._filters.company_id));
            return ok(hit || null);
          }
          return ok(null);
        },
        // The domain-fallback lookups are the only ilike() reads; the bounce
        // branch reads b2b_threads as a plain list (it must see EVERY owner of a
        // shared Gmail thread to know the answer is ambiguous).
        then(resolve) {
          if (table === 'b2b_threads') {
            return resolve({
              data: state.threads.filter(t => t.gmail_thread_id === q._filters.gmail_thread_id),
              error: null,
            });
          }
          const pat = (q._filters['ilike:website'] || q._filters['ilike:email'] || '').replace(/%/g, '');
          if (table === 'b2b_companies') {
            return resolve({ data: state.companies.filter(c => (c.website || '').includes(pat)), error: null });
          }
          if (table === 'b2b_contacts') {
            return resolve({ data: state.contacts.filter(c => (c.email || '').endsWith(pat)), error: null });
          }
          return resolve({ data: [], error: null });
        },
        insert(row) {
          state.inserts.push({ table, row });
          if (table === 'b2b_threads') {
            const created = { id: state.threads.length + 900, ...row };
            state.threads.push(created);
            return { select: () => ({ single: () => ok({ id: created.id }) }) };
          }
          return ok(null);
        },
        upsert(row) { state.upserts.push({ table, row }); return ok(null); },
        update(patch) {
          // Chainable + thenable, because the initiating-draft dismissal runs
          // .update().eq().eq().in().is().select() while older callers await a
          // single .eq(). Filters are recorded so a test can assert WHAT was
          // targeted, not just that an update happened.
          const rec = { table, patch, filters: {} };
          state.updates.push(rec);
          const u = {
            eq(col, val) { rec.filters[col] = val; return u; },
            in(col, vals) { rec.filters['in:' + col] = vals; return u; },
            is(col, val) { rec.filters['is:' + col] = val; return u; },
            select() { return u; },
            then(resolve) { return resolve({ data: [], error: null }); },
          };
          return u;
        },
      };
      return q;
    },
  };
}

require.cache[CLIENT_PATH] = {
  id: CLIENT_PATH, filename: CLIENT_PATH, loaded: true, exports: { getSupabaseClient: makeClient },
};
const { correlateInbound } = require('../../b2b-outreach/lib/replyCorrelation');

function reset(over = {}) {
  state = {
    companies: [], contacts: [], threads: [],
    inserts: [], upserts: [], updates: [], ...over,
  };
}

const MSG = (over = {}) => ({
  gmail_message_id: 'm1', gmail_thread_id: 't1',
  from_email: 'rachel@socirc.ca', to_email: 'jamie@rubyshines.com',
  subject: 'Re: Pride Party', body_text: 'Hi Jamie, following up.',
  received_at: '2026-08-12T10:00:00Z', ...over,
});

test('exact contact match still wins and does not auto-add anything', async () => {
  reset({ contacts: [{ email: 'rachel@socirc.ca', company_id: 'socirc' }] });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.company_id, 'socirc');
  assert.strictEqual(state.upserts.length, 0, 'a known address must not be re-added');
});

// 16 of 45 uncorrelated threads were companies we already knew, writing from an
// unregistered address. Four then showed "no prior outbound" in the queue.
test('an unregistered colleague at a known company domain now correlates', async () => {
  reset({ companies: [{ id: 'socirc', website: 'https://socirc.ca', relationship_state: 'active' }] });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.company_id, 'socirc');
});

test('the domain fallback registers the new address as a non-primary contact', async () => {
  reset({ companies: [{ id: 'socirc', website: 'https://socirc.ca', relationship_state: 'active' }] });
  await correlateInbound(MSG());
  const added = state.upserts.find(u => u.table === 'b2b_contacts');
  assert.ok(added, 'the address should be registered for next time');
  assert.strictEqual(added.row.email, 'rachel@socirc.ca');
  assert.strictEqual(added.row.company_id, 'socirc');
  assert.strictEqual(added.row.is_primary, false, 'must not displace the person we correspond with');
  assert.strictEqual(added.row.source, 'inbound_domain_match');
});

test('it also matches via a peer contact when the company has no website', async () => {
  reset({
    companies: [{ id: 'socirc', website: null, relationship_state: 'active' }],
    contacts: [{ email: 'someone@socirc.ca', company_id: 'socirc' }],
  });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.company_id, 'socirc');
});

// The whole reason domain matching is safe is that shared domains are excluded.
test('a free-mail sender never domain-matches, even with a gmail contact on file', async () => {
  reset({ contacts: [{ email: 'someoneelse@gmail.com', company_id: 'some-other-org' }] });
  const r = await correlateInbound(MSG({ from_email: 'katie.mcmenamin@yahoo.co.nz' }));
  assert.strictEqual(r.matched, false, 'yahoo.co.nz identifies nobody');
  assert.strictEqual(state.upserts.length, 0);
});

test('a shortener or mail-provider website never pulls a company in', async () => {
  reset({ companies: [{ id: 'mcminnville', website: 'https://bit.ly/m/mactrans', relationship_state: 'active' }] });
  const r = await correlateInbound(MSG({ from_email: 'someone@bit.ly' }));
  assert.strictEqual(r.matched, false);
});

test('a retired duplicate row never claims the mail', async () => {
  reset({ companies: [{ id: 'socirc-dupe', website: 'https://socirc.ca', relationship_state: 'lost' }] });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.matched, false, 'a merged-away row must not absorb inbound');
});

test('a genuinely unknown org domain stays unmatched for a human to triage', async () => {
  reset({ companies: [{ id: 'socirc', website: 'https://socirc.ca', relationship_state: 'active' }] });
  const r = await correlateInbound(MSG({ from_email: 'brenna.dolan@onepeloton.com' }));
  assert.strictEqual(r.matched, false);
});

test('a subdomain sender does not match a different org on the same host', async () => {
  reset({ companies: [{ id: 'thp', website: 'https://thprojekt.wordpress.com/thp-en/', relationship_state: 'active' }] });
  const r = await correlateInbound(MSG({ from_email: 'someone@othergroup.wordpress.com' }));
  assert.strictEqual(r.matched, false);
});

// ── shared Gmail threads ────────────────────────────────────────────────────
// Gmail threads on subject, so one conversation regularly holds two orgs — 13 of
// ours do. The thread lookup used to key on gmail_thread_id alone, so the second
// org's replies were filed under the FIRST org's relationship: 105 messages, 8.9%
// of the corpus, were in that state before this was fixed.

test('a reply on a thread another company owns gets its own thread, not theirs', async () => {
  reset({
    companies: [{ id: 'socirc', website: 'https://socirc.ca', relationship_state: 'active' }],
    threads: [{ id: 500, company_id: 'tdsb-gsd-team', gmail_thread_id: 't1' }],
  });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.company_id, 'socirc');
  assert.notStrictEqual(r.thread_id, 500, "must not file SoCirC's reply under TDSB's thread");
  const created = state.inserts.find(i => i.table === 'b2b_threads');
  assert.ok(created, 'a thread row for this company should be created');
  assert.strictEqual(created.row.company_id, 'socirc');
  assert.strictEqual(created.row.gmail_thread_id, 't1', 'same Gmail conversation, separate relationship');
});

test('a reply on the company\'s own thread still attaches to it', async () => {
  reset({
    companies: [{ id: 'socirc', website: 'https://socirc.ca', relationship_state: 'active' }],
    threads: [
      { id: 500, company_id: 'tdsb-gsd-team', gmail_thread_id: 't1' },
      { id: 501, company_id: 'socirc', gmail_thread_id: 't1' },
    ],
  });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.thread_id, 501);
  assert.strictEqual(state.inserts.filter(i => i.table === 'b2b_threads').length, 0, 'no duplicate row');
});

// The bounce branch is deliberately unscoped — it is trying to DISCOVER the
// company. On a shared thread that would pick one at random, and marking the
// wrong org's contact as lost pauses their cadence.
test('a hard bounce on a single-owner thread still correlates', async () => {
  reset({ threads: [{ id: 500, company_id: 'socirc', gmail_thread_id: 't1' }] });
  const r = await correlateInbound(MSG({
    from_email: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    body_text: 'Address not found. 550 5.1.1 The email account that you tried to reach does not exist.',
  }));
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.company_id, 'socirc');
});

test('a hard bounce on a thread two orgs share guesses nobody', async () => {
  reset({
    threads: [
      { id: 500, company_id: 'socirc', gmail_thread_id: 't1' },
      { id: 501, company_id: 'tdsb-gsd-team', gmail_thread_id: 't1' },
    ],
  });
  const r = await correlateInbound(MSG({
    from_email: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    body_text: 'Address not found. 550 5.1.1 The email account that you tried to reach does not exist.',
  }));
  assert.strictEqual(r.matched, false, 'ambiguous means unknown, not "pick one"');
});

// ── initiating-draft dismissal on a genuine reply (2026-09-02) ──────────────
// A human writing in makes a waiting cold intro / check-in obsolete: the
// conversation is now live, and live conversations are operator-written.

test('a genuine reply dismisses pending initiating drafts for the company', async () => {
  reset({ contacts: [{ email: 'rachel@socirc.ca', company_id: 'socirc' }] });
  const r = await correlateInbound(MSG());
  assert.strictEqual(r.matched, true);
  const dismiss = state.updates.find(u => u.table === 'b2b_drafts' && u.patch.status === 'dismissed');
  assert.ok(dismiss, 'expected a b2b_drafts dismissal update');
  assert.strictEqual(dismiss.filters.company_id, 'socirc');
  assert.strictEqual(dismiss.filters.status, 'pending');
  assert.deepEqual(dismiss.filters['in:message_type'],
    ['intro_outreach', 'community_checkin', 're_approach', 'reorder_nudge']);
  // Scheduled ladder drafts are the send pass's problem, never dismissed here.
  assert.strictEqual(dismiss.filters['is:scheduled_send_at'], null);
});

test('an auto-reply does NOT dismiss initiating drafts', async () => {
  reset({ contacts: [{ email: 'rachel@socirc.ca', company_id: 'socirc' }] });
  const r = await correlateInbound(MSG({
    subject: 'Out of Office Re: Pride Party',
    body_text: 'I am out of the office until Monday with limited email access.',
  }));
  assert.strictEqual(r.matched, true);
  const dismiss = state.updates.find(u => u.table === 'b2b_drafts' && u.patch.status === 'dismissed');
  assert.strictEqual(dismiss, undefined, 'an OOO must not kill the waiting intro');
});
