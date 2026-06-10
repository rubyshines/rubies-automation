const { test } = require('node:test');
const assert = require('node:assert');

const {
  isOutreachNote,
  markOutreachSent,
  resolveOnTicketClose,
  reconcileNotes,
} = require('../lib/noteLifecycle');

// ---------------------------------------------------------------------------
// Minimal chainable Supabase stub. Configure per-table rows; capture inserts.
// ---------------------------------------------------------------------------

function makeStub({ notes = [], orders = [], tickets = [] } = {}) {
  const inserts = [];
  const tables = {
    order_alert_notes: notes,
    orders,
    cs_tickets: tickets,
  };

  function builder(table) {
    const state = { table, filters: [], rangeFrom: 0, rangeTo: Infinity };
    const api = {
      select() { return api; },
      order() { return api; },
      eq(col, val) { state.filters.push(r => r[col] === val); return api; },
      in(col, vals) {
        const set = new Set(vals.map(String));
        state.filters.push(r => set.has(String(r[col])));
        return api;
      },
      range(from, to) { state.rangeFrom = from; state.rangeTo = to; return api; },
      insert(row) {
        inserts.push({ table, row });
        tables[table] = [...(tables[table] || []), row];
        return { then: (fn) => fn({ data: null, error: null }) };
      },
      then(fn) {
        let rows = (tables[state.table] || []).filter(r => state.filters.every(f => f(r)));
        rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
        return fn({ data: rows, error: null });
      },
    };
    return api;
  }

  return { from: builder, _inserts: inserts };
}

function note(orderNumber, text, { author = 'operator', resolved = false, created_at = '2026-06-01T00:00:00Z' } = {}) {
  return { order_number: orderNumber, note: text, author, resolved, created_at };
}

// Notes are returned newest-first by the real query; the stub doesn't sort,
// so list newest first in fixtures.

// ---------------------------------------------------------------------------
// isOutreachNote
// ---------------------------------------------------------------------------

test('isOutreachNote: auto author always matches', () => {
  assert.equal(isOutreachNote(note(1, 'anything at all', { author: 'auto' })), true);
});

test('isOutreachNote: matches staging and sending note text', () => {
  assert.equal(isOutreachNote(note(1, '[auto-draft] Unnotified pre-order outreach drafted — awaiting send (Case A)')), true);
  assert.equal(isOutreachNote(note(1, 'Address-confirmation outreach drafted (v2) — pending operator review')), true);
  assert.equal(isOutreachNote(note(1, 'Outreach sent (ticket #12) — awaiting customer reply')), true);
});

test('isOutreachNote: operator judgment notes do not match', () => {
  assert.equal(isOutreachNote(note(1, 'Passport shipment mishandled — awaiting reship decision')), false);
  assert.equal(isOutreachNote(note(1, 'Warehouse hold placed: Customer requested hold')), false);
  assert.equal(isOutreachNote(null), false);
});

// ---------------------------------------------------------------------------
// markOutreachSent
// ---------------------------------------------------------------------------

test('markOutreachSent: supersedes an unresolved auto-draft note', async () => {
  const sb = makeStub({ notes: [note(31399, '[auto-draft] Unnotified pre-order outreach drafted', { author: 'auto' })] });
  const result = await markOutreachSent({ supabase: sb, orderNumber: '#31399', csTicketId: 77 });
  assert.equal(result.superseded, true);
  assert.equal(sb._inserts.length, 1);
  const row = sb._inserts[0].row;
  assert.equal(row.order_number, 31399);
  assert.equal(row.resolved, false);
  assert.equal(row.author, 'operator');
  assert.match(row.note, /^Outreach sent \(ticket #77\)/);
});

test('markOutreachSent: no-op when latest note is not outreach-related', async () => {
  const sb = makeStub({ notes: [note(30872, 'Waiting on response — Passport tracking not showing movement')] });
  const result = await markOutreachSent({ supabase: sb, orderNumber: 30872 });
  assert.equal(result.superseded, false);
  assert.equal(sb._inserts.length, 0);
});

test('markOutreachSent: no-op when already superseded (idempotent)', async () => {
  const sb = makeStub({ notes: [note(31399, 'Outreach sent (ticket #77) — awaiting customer reply')] });
  const result = await markOutreachSent({ supabase: sb, orderNumber: 31399, csTicketId: 77 });
  assert.equal(result.superseded, false);
  assert.equal(sb._inserts.length, 0);
});

test('markOutreachSent: no-op with no notes or bad order number', async () => {
  const sb = makeStub();
  assert.deepEqual(await markOutreachSent({ supabase: sb, orderNumber: 12345 }), { superseded: false });
  assert.deepEqual(await markOutreachSent({ supabase: sb, orderNumber: 'D6720' }), { superseded: false });
  assert.equal(sb._inserts.length, 0);
});

// ---------------------------------------------------------------------------
// resolveOnTicketClose
// ---------------------------------------------------------------------------

test('resolveOnTicketClose: resolves an open outreach-sent note', async () => {
  const sb = makeStub({ notes: [note(31399, 'Outreach sent (ticket #77) — awaiting customer reply')] });
  const result = await resolveOnTicketClose({ supabase: sb, orderNumber: 31399, csTicketId: 77 });
  assert.equal(result.resolved, true);
  const row = sb._inserts[0].row;
  assert.equal(row.resolved, true);
  assert.equal(row.author, 'auto');
});

test('resolveOnTicketClose: skips when another ticket for the order is still active', async () => {
  const sb = makeStub({
    notes: [note(31273, 'Address-confirmation outreach drafted (v2) — pending operator review')],
    tickets: [
      { id: 1680, order_number: '31273', status: 'closed' },
      { id: 1681, order_number: '31273', status: 'snoozed' },
    ],
  });
  const result = await resolveOnTicketClose({ supabase: sb, orderNumber: 31273, csTicketId: 1680 });
  assert.equal(result.resolved, false);
  assert.equal(sb._inserts.length, 0);
});

test('resolveOnTicketClose: leaves operator judgment notes alone', async () => {
  const sb = makeStub({ notes: [note(30870, 'Passport shipment mishandled — awaiting reship decision')] });
  const result = await resolveOnTicketClose({ supabase: sb, orderNumber: 30870, csTicketId: 1426 });
  assert.equal(result.resolved, false);
  assert.equal(sb._inserts.length, 0);
});

// ---------------------------------------------------------------------------
// reconcileNotes
// ---------------------------------------------------------------------------

test('reconcileNotes R1: auto note + shipped order → resolved', async () => {
  const sb = makeStub({
    notes: [note(31170, '[auto-draft] Unnotified pre-order outreach drafted (Case B)', { author: 'auto' })],
    orders: [{ order_number: 31170, fulfillment_status: 'FULFILLED', cancelled_at: null }],
  });
  const { resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].rule, 'order_done');
  assert.equal(sb._inserts[0].row.resolved, true);
});

test('reconcileNotes R1: auto note + cancelled order → resolved', async () => {
  const sb = makeStub({
    notes: [note(31171, 'Auto-resolved: previous order match', { author: 'auto' })],
    orders: [{ order_number: 31171, fulfillment_status: 'UNFULFILLED', cancelled_at: '2026-06-01' }],
  });
  const { resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(resolved.length, 1);
  assert.match(resolved[0].reason, /cancelled/i);
});

test('reconcileNotes R1: auto note + unfulfilled order stays open', async () => {
  const sb = makeStub({
    notes: [note(31399, '[auto-draft] outreach drafted', { author: 'auto' })],
    orders: [{ order_number: 31399, fulfillment_status: 'UNFULFILLED', cancelled_at: null }],
  });
  const { resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(resolved.length, 0);
});

test('reconcileNotes R2: outreach note + all tickets closed → resolved', async () => {
  const sb = makeStub({
    notes: [note(31117, '[auto-draft] outreach drafted (Case A)', { author: 'auto' })],
    orders: [{ order_number: 31117, fulfillment_status: 'UNFULFILLED', cancelled_at: null }],
    tickets: [{ id: 1403, order_number: '31117', status: 'closed' }],
  });
  const { resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].rule, 'tickets_closed');
});

test('reconcileNotes R2: open ticket blocks resolution', async () => {
  const sb = makeStub({
    notes: [note(31273, 'Address-confirmation outreach drafted (v2) — pending operator review')],
    orders: [{ order_number: 31273, fulfillment_status: 'UNFULFILLED', cancelled_at: null }],
    tickets: [
      { id: 1680, order_number: '31273', status: 'open' },
      { id: 1681, order_number: '31273', status: 'snoozed' },
    ],
  });
  const { resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(resolved.length, 0);
});

test('reconcileNotes: operator judgment note with no tickets is never touched', async () => {
  const sb = makeStub({
    notes: [note(30883, 'Passport shipment mishandled — awaiting reship decision')],
    orders: [{ order_number: 30883, fulfillment_status: 'FULFILLED', cancelled_at: null }],
  });
  const { resolved, checked } = await reconcileNotes({ supabase: sb });
  assert.equal(checked, 1);
  assert.equal(resolved.length, 0);
});

test('reconcileNotes: latest-note-wins — already resolved orders are skipped', async () => {
  const sb = makeStub({
    notes: [
      // newest first, as the real query returns
      note(31259, 'Pre-order outreach addressed by Jamie', { resolved: true, created_at: '2026-06-10T00:00:00Z' }),
      note(31259, '[auto-draft] outreach drafted (Case B)', { author: 'auto', created_at: '2026-06-05T00:00:00Z' }),
    ],
    orders: [{ order_number: 31259, fulfillment_status: 'UNFULFILLED', cancelled_at: null }],
  });
  const { checked, resolved } = await reconcileNotes({ supabase: sb });
  assert.equal(checked, 0);
  assert.equal(resolved.length, 0);
});
