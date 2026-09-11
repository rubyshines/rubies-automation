/**
 * Commitments — the structured list of what Jamie owes and is waiting on
 * (2026-09-10). Pure halves (Next Steps parsing, owner classification, list
 * order) plus the write path against an in-memory Supabase double: dedupe,
 * the derived On Me flag, and the rule that the engine closes theirs, never mine.
 *
 * Run: node --test customer-service/test/b2bCommitments.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../b2b-outreach/lib/commitments');

// ── in-memory Supabase double ───────────────────────────────────────────────
function fakeSb(seed = {}) {
  const tables = { b2b_commitments: [], b2b_companies: [], ...seed };
  let nextId = 100;
  function matches(row, f) {
    return f.every(([op, col, val]) => {
      const v = row[col] ?? null;
      if (op === 'eq') return v === val;
      if (op === 'in') return val.includes(v);
      if (op === 'is') return v === val;
      if (op === 'not_is') return v !== val;
      return true;
    });
  }
  function builder(table) {
    const rows = tables[table];
    const b = { _f: [], _order: null, _limit: null, _op: 'select', _payload: null };
    const chain = fn => { fn(); return b; };
    b.select = () => b;
    b.eq = (c, v) => chain(() => b._f.push(['eq', c, v]));
    b.in = (c, v) => chain(() => b._f.push(['in', c, v]));
    b.is = (c, v) => chain(() => b._f.push(['is', c, v]));
    b.not = (c, op, v) => chain(() => b._f.push(['not_is', c, v]));
    b.order = (c, { ascending = true } = {}) => chain(() => { b._order = [c, ascending]; });
    b.limit = n => chain(() => { b._limit = n; });
    b.insert = row => chain(() => { b._op = 'insert'; b._payload = row; });
    b.update = patch => chain(() => { b._op = 'update'; b._payload = patch; });
    b.delete = () => chain(() => { b._op = 'delete'; });
    function run() {
      if (b._op === 'insert') {
        const row = { id: nextId++, ...b._payload };
        rows.push(row);
        return [row];
      }
      let hit = rows.filter(r => matches(r, b._f));
      if (b._op === 'update') { for (const r of hit) Object.assign(r, b._payload); return hit; }
      if (b._op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return hit; }
      if (b._order) {
        const [c, asc] = b._order;
        hit = [...hit].sort((x, y) => String(x[c] ?? '').localeCompare(String(y[c] ?? '')) * (asc ? 1 : -1));
      }
      if (b._limit) hit = hit.slice(0, b._limit);
      return hit;
    }
    b.maybeSingle = () => Promise.resolve({ data: run()[0] || null, error: null });
    b.single = () => Promise.resolve({ data: run()[0] || null, error: null });
    b.then = res => Promise.resolve({ data: run(), error: null }).then(res);
    return b;
  }
  return { from: t => builder(t), tables };
}

const company = (id, over = {}) => ({ id, name: id.toUpperCase(), relationship_type: 'lgbtq_org', on_me_at: null, on_me_source: null, on_me_note: null, ...over });
const NOW = new Date('2026-09-10T20:00:00Z');

const LEJAG_SUMMARY = `Intro call between RUBIES and Le JAG.

### Le JAG Program Fit
- Only registered LGBTQ+ org on South Shore of Montreal

### Next Steps
- (Jamie Alexander) Send Le JAG ~20 discount codes at 20% off, replenish on request
- (Jamie Alexander) Ship a sample product with a stand for display in Le JAG offices
- (Philippe Girouard) Create printed infographic using RUBIES site content for office visibility
- (Philippe Girouard) Add RUBIES to partners page, gender gear program page, and social media

### Decisions Made
- No tabling at events.`;

// ── pure: parsing ───────────────────────────────────────────────────────────

test('Next Steps bullets become items with the right owner', () => {
  const items = C.parseNextSteps(LEJAG_SUMMARY);
  assert.equal(items.length, 4, 'only the Next Steps section, not Program Fit or Decisions');
  assert.deepEqual(items.map(i => i.owner), ['me', 'me', 'them', 'them']);
  assert.equal(items[0].text, 'Send Le JAG ~20 discount codes at 20% off, replenish on request');
  assert.equal(items[2].owner_name, 'Philippe Girouard');
});

test('a summary with no Next Steps section yields nothing rather than guesses', () => {
  assert.deepEqual(C.parseNextSteps('### Overview\n- lots of things\n- more things'), []);
});

test('an unnamed bullet is theirs, and "Jamie" / "RUBIES" in any form is me', () => {
  assert.equal(C.classifyOwner('Jamie'), 'me');
  assert.equal(C.classifyOwner('RUBIES team'), 'me');
  assert.equal(C.classifyOwner('Dion'), 'them');
  assert.equal(C.classifyOwner(null), 'them');
});

// ── pure: order ─────────────────────────────────────────────────────────────

test('reading order: pinned, overdue, dated, then undated oldest first', () => {
  const rows = [
    { id: 1, text: 'undated new', created_at: '2026-09-09T00:00:00Z' },
    { id: 2, text: 'dated later', due_on: '2026-10-18', created_at: '2026-09-01T00:00:00Z' },
    { id: 3, text: 'overdue', due_on: '2026-09-01', created_at: '2026-08-01T00:00:00Z' },
    { id: 4, text: 'undated old', created_at: '2026-08-15T00:00:00Z' },
    { id: 5, text: 'pinned', pinned_at: '2026-09-10T12:00:00Z', created_at: '2026-09-10T00:00:00Z' },
    { id: 6, text: 'dated soon', due_on: '2026-09-12', created_at: '2026-09-05T00:00:00Z' },
  ];
  assert.deepEqual(C.orderCommitments(rows, NOW).map(r => r.id), [5, 3, 6, 2, 4, 1]);
});

// ── write path ──────────────────────────────────────────────────────────────

test('upsert inserts once, dedupes on normalised text, and sets the derived On Me flag', async () => {
  const sb = fakeSb({ b2b_companies: [company('lejag')] });
  const items = C.parseNextSteps(LEJAG_SUMMARY);
  const first = await C.upsertCommitments(sb, { company_id: 'lejag', items, source: 'meeting', created_by: 'engine', meeting_id: 7, now: NOW });
  assert.equal(first.inserted.length, 4);
  assert.equal(first.inserted[0].meeting_id, 7);
  assert.equal(first.inserted[0].original_text, first.inserted[0].text, 'the captured text is kept beside the editable one');

  const again = await C.upsertCommitments(sb, {
    company_id: 'lejag', source: 'meeting', now: NOW,
    items: [{ owner: 'me', text: 'send le jag ~20 DISCOUNT codes at 20% off, replenish on request!' }],
  });
  assert.equal(again.inserted.length, 0, 'same promise, different punctuation and case: not a second row');
  assert.equal(again.matched.length, 1);

  const c = sb.tables.b2b_companies[0];
  assert.equal(c.on_me_at, NOW.toISOString(), 'the company is on me because I owe it something');
  assert.equal(c.on_me_source, 'operator');
});

test('theirs alone does not put a company on me', async () => {
  const sb = fakeSb({ b2b_companies: [company('swt')] });
  await C.upsertCommitments(sb, { company_id: 'swt', source: 'meeting', now: NOW, items: [{ owner: 'them', text: 'Dion intros Jamie to Affirmations' }] });
  assert.equal(sb.tables.b2b_companies[0].on_me_at, null);
});

test('the engine may complete theirs and never mine; the operator may complete either', async () => {
  const sb = fakeSb({ b2b_companies: [company('swt')] });
  const { inserted } = await C.upsertCommitments(sb, {
    company_id: 'swt', source: 'meeting', now: NOW,
    items: [{ owner: 'me', text: 'Send ~8 pairs for the Oct 18 event' }, { owner: 'them', text: 'Dion intros Jamie to Affirmations' }],
  });
  const [mine, theirs] = inserted;
  await assert.rejects(() => C.completeCommitment(sb, { id: mine.id, by: 'engine', now: NOW }), /owned by me/);
  const done = await C.completeCommitment(sb, { id: theirs.id, by: 'engine', done_message_id: 55, now: NOW });
  assert.equal(done.status, 'done');
  assert.equal(done.done_by, 'engine');
  assert.equal(done.done_message_id, 55);
  assert.equal(sb.tables.b2b_companies[0].on_me_at, NOW.toISOString(), 'still on me: my item is open');

  await C.completeCommitment(sb, { id: mine.id, by: 'operator', now: NOW });
  assert.equal(sb.tables.b2b_companies[0].on_me_at, null, 'the last open me-item closing clears the flag');
});

test('a cadence hand-off shows as such on the derived flag, and Back to queue removes only the stubs', async () => {
  const sb = fakeSb({ b2b_companies: [company('gsrc')] });
  await C.addCommitment(sb, { company_id: 'gsrc', owner: 'me', text: 'Send the QR code you promised', source: 'meeting', now: NOW });
  await C.addCommitment(sb, { company_id: 'gsrc', owner: 'me', text: '2 follow-ups unanswered since 26 Aug', source: 'cadence', created_by: 'engine', now: new Date('2026-09-11T00:00:00Z') });
  let c = sb.tables.b2b_companies[0];
  assert.equal(c.on_me_source, 'cadence');
  assert.equal(c.on_me_note, '2 follow-ups unanswered since 26 Aug');

  const r = await C.abandonClaims(sb, { company_id: 'gsrc' });
  assert.equal(r.removed, 1);
  assert.equal(r.remaining, 1, 'the real promise stays');
  c = sb.tables.b2b_companies[0];
  assert.equal(c.on_me_source, 'operator');
  assert.equal(c.on_me_note, null);
  assert.ok(c.on_me_at, 'still on me while a real item is open');
});

test('a send settles the item the composer was opened from and any reply-claim on that thread, nothing else', async () => {
  const sb = fakeSb({ b2b_companies: [company('lejag')] });
  const codes = await C.addCommitment(sb, { company_id: 'lejag', owner: 'me', text: 'Send 20 codes', source: 'meeting', now: NOW });
  const stand = await C.addCommitment(sb, { company_id: 'lejag', owner: 'me', text: 'Ship the display stand', source: 'meeting', now: NOW });
  const reply = await C.addCommitment(sb, { company_id: 'lejag', owner: 'me', text: 'Reply to Philippe', source: 'claim', thread_id: 9, completes_on_send: true, now: NOW });
  const otherThread = await C.addCommitment(sb, { company_id: 'lejag', owner: 'me', text: 'Reply on the other thread', source: 'claim', thread_id: 10, completes_on_send: true, now: NOW });

  const r = await C.settleOnSend(sb, {
    company_id: 'lejag', thread_id: 9, message_id: 500, now: NOW,
    draft: { structured: { completes_commitment_id: codes.id } },
  });
  assert.deepEqual(r.completed.sort(), [codes.id, reply.id].sort());
  const byId = id => sb.tables.b2b_commitments.find(x => x.id === id);
  assert.equal(byId(codes.id).done_by, 'send');
  assert.equal(byId(codes.id).done_message_id, 500);
  assert.equal(byId(stand.id).status, 'open', 'sending the codes does not ship the stand');
  assert.equal(byId(otherThread.id).status, 'open', 'a reply-claim on another thread is untouched');
});

test('delete hides the row and clears the flag; reopen (Undo) brings it back', async () => {
  const sb = fakeSb({ b2b_companies: [company('x')] });
  const row = await C.addCommitment(sb, { company_id: 'x', owner: 'me', text: 'Wrong capture', now: NOW });
  await C.deleteCommitment(sb, { id: row.id, now: NOW });
  assert.equal(sb.tables.b2b_commitments[0].status, 'deleted', 'kept, so Undo has something to restore');
  assert.equal(sb.tables.b2b_companies[0].on_me_at, null);
  assert.equal((await C.listCommitments(sb, { now: NOW })).length, 0, 'a deleted row is on no list');
  await C.reopenCommitment(sb, { id: row.id, now: NOW });
  assert.equal(sb.tables.b2b_commitments[0].status, 'open');
  assert.equal(sb.tables.b2b_companies[0].on_me_at, NOW.toISOString());

  await C.completeCommitment(sb, { id: row.id, now: NOW });
  assert.equal(sb.tables.b2b_companies[0].on_me_at, null);
  await C.reopenCommitment(sb, { id: row.id, now: NOW });
  assert.equal(sb.tables.b2b_companies[0].on_me_at, NOW.toISOString(), 'Undo on Done is the same reopen');
});

test('list decorates with company, channel, overdue and age; On Me groups by company oldest first', async () => {
  const sb = fakeSb({ b2b_companies: [company('a'), company('b', { relationship_type: 'wholesale' })] });
  await C.addCommitment(sb, { company_id: 'b', owner: 'me', text: 'Older claim', now: new Date('2026-09-01T00:00:00Z') });
  await C.addCommitment(sb, { company_id: 'a', owner: 'me', text: 'Overdue thing', due_on: '2026-09-01', now: NOW });
  await C.addCommitment(sb, { company_id: 'a', owner: 'them', text: 'Their thing', now: NOW });
  await C.addCommitment(sb, { company_id: null, owner: 'me', text: 'General todo', now: NOW });

  const mine = await C.listCommitments(sb, { owner: 'me', now: NOW });
  assert.deepEqual(mine.map(r => r.text), ['Overdue thing', 'Older claim', 'General todo']);
  assert.equal(mine[0].overdue, true);
  assert.equal(mine[0].company_name, 'A');
  assert.equal(mine[1].days_open, 9);
  assert.equal(mine[2].company_name, null, 'a general item has no company');

  const orgsOnly = await C.listCommitments(sb, { owner: 'me', channel: 'lgbtq_org', now: NOW });
  assert.deepEqual(orgsOnly.map(r => r.text), ['Overdue thing']);

  const groups = await C.companiesOnMe(sb, { now: NOW });
  assert.deepEqual(groups.map(g => g.company_id), ['b', 'a'], 'oldest claim first');
  assert.equal(groups[1].count, 1, 'their item does not count toward on me');
  assert.equal(groups[1].items[0].text, 'Overdue thing');
});
