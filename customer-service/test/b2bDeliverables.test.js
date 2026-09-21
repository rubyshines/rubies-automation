/**
 * Deliverables — one piece of work above many promises (2026-09-21). The
 * rules the list's trust rests on, against an in-memory Supabase double:
 * shipping completes no member, a blocked member is never hidden, grouping
 * never moves On Me, and deleting a deliverable detaches rather than cascades.
 *
 * Run: node --test customer-service/test/b2bDeliverables.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../b2b-outreach/lib/commitments');
const D = require('../../b2b-outreach/lib/deliverables');

// ── in-memory Supabase double (as b2bCommitments.test.js, plus deliverables) ─
function fakeSb(seed = {}) {
  const tables = { b2b_commitments: [], b2b_companies: [], b2b_deliverables: [], ...seed };
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
      if (!rows) throw new Error(`relation "${table}" does not exist`);
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
    const wrap = fn => { try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }); } };
    b.maybeSingle = () => wrap(() => ({ data: run()[0] || null, error: null }));
    b.single = () => wrap(() => ({ data: run()[0] || null, error: null }));
    b.then = (res, rej) => wrap(() => ({ data: run(), error: null })).then(res, rej);
    return b;
  }
  return { from: t => builder(t), tables };
}

const company = (id, over = {}) => ({ id, name: id.toUpperCase(), relationship_type: 'lgbtq_org', on_me_at: null, on_me_source: null, on_me_note: null, ...over });
const NOW = new Date('2026-09-21T15:00:00Z');
const at = (iso) => new Date(iso);

// The live shape on 2026-09-21, in miniature: two orgs waiting on the
// affiliate programme, one shipment in the October batch, one of theirs loose.
async function seed() {
  const sb = fakeSb({ b2b_companies: [company('hello-gorgeous'), company('uniting-pride'), company('lejag')] });
  const app = await D.addDeliverable(sb, { name: 'Affiliate programme for orgs', blocks: true, now: NOW });
  const batch = await D.addDeliverable(sb, { name: 'October org shipments', blocks: false, target_on: '2026-10-10', now: NOW });
  const hg = await C.addCommitment(sb, { company_id: 'hello-gorgeous', text: 'Finalise the affiliate details', now: at('2026-09-01T00:00:00Z') });
  const up = await C.addCommitment(sb, { company_id: 'uniting-pride', text: 'Share affiliate details with Emma', now: at('2026-09-02T00:00:00Z') });
  const run = await C.addCommitment(sb, { company_id: 'uniting-pride', text: 'Ship a free starter run', due_on: '2026-10-01', now: at('2026-09-03T00:00:00Z') });
  const theirs = await C.addCommitment(sb, { company_id: 'lejag', owner: 'them', text: 'Philippe: printed infographic', now: at('2026-09-04T00:00:00Z') });
  await D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: app.id, now: NOW });
  await D.attachCommitment(sb, { commitment_id: up.id, deliverable_id: app.id, now: NOW });
  await D.attachCommitment(sb, { commitment_id: run.id, deliverable_id: batch.id, now: NOW });
  return { sb, app, batch, hg, up, run, theirs };
}

const onMeShape = groups => groups.map(g => ({ company_id: g.company_id, count: g.count, on_me_at: g.on_me_at, oldest_text: g.oldest_text }));
const flags = sb => sb.tables.b2b_companies.map(c => [c.id, c.on_me_at, c.on_me_source, c.on_me_note]);

// ── pure ────────────────────────────────────────────────────────────────────

test('a deliverable is overdue only while open and past its target', () => {
  const open = D.decorateDeliverable({ status: 'open', target_on: '2026-09-01', created_at: '2026-08-01T00:00:00Z' }, { open: 2, done: 1 }, NOW);
  assert.equal(open.overdue, true);
  assert.equal(open.open_count, 2);
  assert.equal(open.done_count, 1);
  assert.equal(open.days_open, 51);
  const shipped = D.decorateDeliverable({ status: 'shipped', target_on: '2026-09-01', created_at: '2026-08-01T00:00:00Z' }, undefined, NOW);
  assert.equal(shipped.overdue, false);
  assert.equal(shipped.open_count, 0, 'no counts given: zero, not undefined');
});

// ── blocked is a flag and an order, never a filter ──────────────────────────

test('a blocking member is flagged, still listed, and sorts last; a batch member is as actionable as a loose row', async () => {
  const { sb, hg, up, run, theirs } = await seed();
  const rows = await C.listCommitments(sb, { now: NOW });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rows.length, 4, 'nothing is hidden');
  assert.equal(byId[hg.id].blocked, true);
  assert.equal(byId[hg.id].deliverable_name, 'Affiliate programme for orgs');
  assert.equal(byId[run.id].blocked, false, 'the batch does not block');
  assert.equal(byId[run.id].deliverable_blocks, false);
  assert.equal(byId[theirs.id].deliverable_name, null);
  const mine = rows.filter(r => r.owner === 'me').map(r => r.id);
  assert.deepEqual(mine, [run.id, hg.id, up.id], 'the dated shipment first; the two blocked ones last, oldest first');
});

test('a pin beats blocked: Jamie saying "today" on purpose still wins', async () => {
  const { sb, up, run } = await seed();
  await C.updateCommitment(sb, { id: up.id, pinned: true, now: NOW });
  const mine = (await C.listCommitments(sb, { now: NOW })).filter(r => r.owner === 'me').map(r => r.id);
  assert.equal(mine[0], up.id);
  assert.equal(mine[1], run.id);
});

// ── the ship moment ─────────────────────────────────────────────────────────

test('shipping completes no member: it returns them released, open, and no longer blocked', async () => {
  const { sb, app, hg, up } = await seed();
  const { deliverable, released } = await D.shipDeliverable(sb, { id: app.id, now: NOW });
  assert.equal(deliverable.status, 'shipped');
  assert.equal(deliverable.shipped_at, NOW.toISOString());
  assert.deepEqual(released.map(r => r.id), [hg.id, up.id]);
  for (const r of released) {
    assert.equal(r.status, 'open', 'the app existing is not the same as having written to them');
    assert.equal(r.blocked, false);
    assert.equal(r.deliverable_status, 'shipped');
  }
  const rows = sb.tables.b2b_commitments.filter(r => [hg.id, up.id].includes(r.id));
  assert.ok(rows.every(r => r.status === 'open' && !r.done_at && !r.done_by), 'nothing on the rows changed');

  const again = await D.shipDeliverable(sb, { id: app.id, now: NOW });
  assert.equal(again.deliverable.shipped_at, NOW.toISOString(), 'shipping twice is a no-op, not a second stamp');

  await D.reopenDeliverable(sb, { id: app.id, now: NOW });
  const back = await C.listCommitments(sb, { deliverable_id: app.id, now: NOW });
  assert.ok(back.every(r => r.blocked), 'reopened: its members are blocked again');
});

// ── attach / detach ─────────────────────────────────────────────────────────

test('attach is idempotent, moves between deliverables, refuses a shipped one, and detach loosens', async () => {
  const { sb, app, batch, hg, theirs } = await seed();
  const twice = await D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: app.id, now: NOW });
  assert.equal(twice.deliverable_id, app.id);
  const moved = await D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: batch.id, now: NOW });
  assert.equal(moved.deliverable_id, batch.id, 'one home: attaching elsewhere moves it');

  const asTheirs = await D.attachCommitment(sb, { commitment_id: theirs.id, deliverable_id: app.id, now: NOW });
  assert.equal(asTheirs.deliverable_id, app.id, 'a them-row may belong to a deliverable too');

  await D.shipDeliverable(sb, { id: app.id, now: NOW });
  await assert.rejects(
    () => D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: app.id, now: NOW }),
    /has shipped/, 'new work after the ship stays loose',
  );

  const loose = await D.detachCommitment(sb, { commitment_id: hg.id, now: NOW });
  assert.equal(loose.deliverable_id, null);
  await assert.rejects(() => D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: 999, now: NOW }), /not found/);
});

// ── On Me does not learn about deliverables ─────────────────────────────────

test('On Me is unchanged by attaching, shipping, reopening or deleting', async () => {
  const sb = fakeSb({ b2b_companies: [company('hello-gorgeous'), company('uniting-pride'), company('lejag')] });
  const hg = await C.addCommitment(sb, { company_id: 'hello-gorgeous', text: 'Finalise the affiliate details', now: at('2026-09-01T00:00:00Z') });
  const up = await C.addCommitment(sb, { company_id: 'uniting-pride', text: 'Share affiliate details with Emma', now: at('2026-09-02T00:00:00Z') });
  await C.addCommitment(sb, { company_id: 'lejag', owner: 'them', text: 'Philippe: printed infographic', now: at('2026-09-04T00:00:00Z') });
  const before = onMeShape(await C.companiesOnMe(sb, { now: NOW }));
  const flagsBefore = flags(sb);
  assert.equal(before.length, 2, 'two companies on me, none for a them-only company');

  const app = await D.addDeliverable(sb, { name: 'Affiliate programme for orgs', now: NOW });
  await D.attachCommitment(sb, { commitment_id: hg.id, deliverable_id: app.id, now: NOW });
  await D.attachCommitment(sb, { commitment_id: up.id, deliverable_id: app.id, now: NOW });
  assert.deepEqual(onMeShape(await C.companiesOnMe(sb, { now: NOW })), before, 'blocked or not, he still owes them');
  assert.deepEqual(flags(sb), flagsBefore);

  await D.shipDeliverable(sb, { id: app.id, now: NOW });
  assert.deepEqual(onMeShape(await C.companiesOnMe(sb, { now: NOW })), before);
  await D.reopenDeliverable(sb, { id: app.id, now: NOW });
  assert.deepEqual(onMeShape(await C.companiesOnMe(sb, { now: NOW })), before);
  await D.deleteDeliverable(sb, { id: app.id, now: NOW });
  assert.deepEqual(onMeShape(await C.companiesOnMe(sb, { now: NOW })), before);
  assert.deepEqual(flags(sb), flagsBefore, 'the denormalised flag was never rewritten');
});

// ── delete detaches, never cascades ─────────────────────────────────────────

test('deleting a deliverable detaches its members and leaves each as it was', async () => {
  const { sb, app, hg, up } = await seed();
  await C.completeCommitment(sb, { id: hg.id, by: 'operator', now: NOW });
  const { deleted, detached } = await D.deleteDeliverable(sb, { id: app.id, now: NOW });
  assert.equal(deleted.id, app.id);
  assert.equal(detached, 2, 'done members detach too');
  const rows = Object.fromEntries(sb.tables.b2b_commitments.map(r => [r.id, r]));
  assert.equal(rows[hg.id].status, 'done');
  assert.equal(rows[up.id].status, 'open');
  assert.equal(rows[hg.id].deliverable_id, null);
  assert.equal(rows[up.id].deliverable_id, null);
  assert.equal(sb.tables.b2b_deliverables.some(d => d.id === app.id), false);
  const listed = await C.listCommitments(sb, { now: NOW });
  assert.ok(listed.every(r => !r.blocked && r.deliverable_name === null || r.deliverable_name === 'October org shipments'));
});

// ── the list of deliverables ────────────────────────────────────────────────

test('the list carries member counts, open oldest first, shipped most recent first', async () => {
  const { sb, app, batch, hg } = await seed();
  let open = await D.listDeliverables(sb, { now: NOW });
  assert.deepEqual(open.map(d => [d.id, d.open_count, d.done_count]), [[app.id, 2, 0], [batch.id, 1, 0]]);
  await C.completeCommitment(sb, { id: hg.id, by: 'operator', now: NOW });
  open = await D.listDeliverables(sb, { now: NOW });
  assert.deepEqual(open.find(d => d.id === app.id).open_count, 1);
  assert.deepEqual(open.find(d => d.id === app.id).done_count, 1);

  await D.shipDeliverable(sb, { id: batch.id, now: at('2026-09-22T00:00:00Z') });
  await D.shipDeliverable(sb, { id: app.id, now: at('2026-09-23T00:00:00Z') });
  const shipped = await D.listDeliverables(sb, { status: 'shipped', now: NOW });
  assert.deepEqual(shipped.map(d => d.id), [app.id, batch.id]);
  assert.equal((await D.listDeliverables(sb, { now: NOW })).length, 0);
  assert.equal((await D.listDeliverables(sb, { status: 'all', now: NOW })).length, 2);
});

// ── before the migration ────────────────────────────────────────────────────

test('without the deliverables table the To do list still renders, with no folds', async () => {
  const sb = fakeSb({ b2b_companies: [company('lejag')] });
  delete sb.tables.b2b_deliverables;
  const row = await C.addCommitment(sb, { company_id: 'lejag', text: 'Ship the stand', now: NOW });
  row.deliverable_id = 5; // a stale FK from nowhere
  const rows = await C.listCommitments(sb, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blocked, false);
  assert.equal(rows[0].deliverable_name, null);
});
