'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runSpamGate } = require('../sync/lib/spamGate');
const { fetchOpenSpamTickets } = require('../sync/lib/gorgiasDriftCore');

// The regression these pin (2026-09-08): a spam-flagged ticket the gate had
// already rescued got a customer follow-up reply. Gorgias delivers no webhook
// for a customer message on a spam-flagged ticket, and the gate skipped the
// ticket as "already in our system — the drift machinery owns it", which is
// report-only. The reply sat undrafted for three days while the digest listed
// it as a real miss every morning. The gate now compares message counts on
// tickets it already knows and runs intake when Gorgias holds more.

const cust = (id, body = 'hi') => ({ id, from_agent: false, channel: 'email', body_text: body });
const agent = (id) => ({ id, from_agent: true, channel: 'email', body_text: 'reply' });

function harness({
  spamTickets = [],
  advisorRows = [],
  drafts = [],
  known = () => false,
  triage = async () => ({ disposition: 'real_miss', reason: 'customer' }),
  messagesByTicket = {},
  processResult = () => ({ skipped: false }),
} = {}) {
  const calls = { processTicket: [], triage: [], getTicketMessages: [], hasOrderHistory: [] };
  const supabase = {
    from: (table) => ({
      select: () => ({
        in: async () => ({ data: table === 'cs_ai_drafts' ? drafts : [], error: null }),
      }),
    }),
  };
  const gorgias = {
    getTicketMessages: async (id) => { calls.getTicketMessages.push(id); return messagesByTicket[id] || []; },
    delay: async () => {},
  };
  const deps = {
    supabase,
    gorgias,
    aiBotId: 42,
    log: () => {},
    warn: () => {},
    hasOrderHistory: async (_sb, email) => { calls.hasOrderHistory.push(email); return known(email); },
    triageDriftTicket: async (args) => { calls.triage.push(args.ticket.id); return triage(args); },
    processTicket: async (_sb, ticket, aiBotId, existingIds) => {
      calls.processTicket.push({ id: ticket.id, aiBotId, existingIds: [...existingIds] });
      return processResult(ticket);
    },
    fetchSpam: async (_g, opts) => { calls.fetchOpts = opts; return spamTickets; },
    fetchAdvisor: async (_sb, ids, cols) => {
      calls.advisorCols = cols;
      const byGorgiasId = new Map();
      for (const r of advisorRows) if (ids.includes(r.gorgias_ticket_id)) byGorgiasId.set(r.gorgias_ticket_id, r);
      return { rows: advisorRows, byGorgiasId };
    },
  };
  return { deps, calls };
}

const ticket = (id, email) => ({ id, spam: true, status: 'open', customer: { email } });

test('spam gate: a follow-up reply on a ticket already rescued is drafted, without re-triage', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(115791324, 'bea@dolphin26.com')],
    advisorRows: [{ id: 3511, gorgias_ticket_id: 115791324, conversation_history: [
      { sender: 'customer', channel: 'email' }, { sender: 'agent', channel: 'email' },
    ] }],
    drafts: [{ gorgias_ticket_id: 115791324, gorgias_message_id: 1 }],
    messagesByTicket: { 115791324: [cust(1), agent(2), cust(3, 'thank you for your lovely reply')] },
  });
  const r = await runSpamGate(deps);
  assert.deepStrictEqual(calls.processTicket.map(p => p.id), [115791324]);
  assert.deepStrictEqual(calls.processTicket[0].existingIds, [1], 'existing draft ids reach intake so the new message is the one drafted');
  assert.strictEqual(calls.triage.length, 0, 'a ticket we already judged is not judged again');
  assert.strictEqual(r.spamRecovered.length, 1);
  assert.match(r.spamRecovered[0].via, /follow-up reply \(G:2 vs A:1\)/);
  assert.ok(r.recoveredIds.has(115791324), 'recovered ids let the caller drop it from the real-miss report');
  assert.match(calls.advisorCols, /conversation_history/, 'the count needs the advisor history');
});

test('spam gate: a known ticket with nothing new is left to the follow-up engine', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'a@b.c')],
    advisorRows: [{ id: 1, gorgias_ticket_id: 1, conversation_history: [{ sender: 'customer', channel: 'email' }] }],
    messagesByTicket: { 1: [cust(1), agent(2)] },
  });
  const r = await runSpamGate(deps);
  assert.strictEqual(calls.processTicket.length, 0);
  assert.strictEqual(calls.triage.length, 0);
  assert.strictEqual(r.spamRecovered.length, 0);
});

test('spam gate: internal notes never count as customer messages on either side', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'a@b.c')],
    advisorRows: [{ id: 1, gorgias_ticket_id: 1, conversation_history: [
      { sender: 'customer', channel: 'email' }, { sender: 'agent', channel: 'internal-note' },
    ] }],
    messagesByTicket: { 1: [cust(1), { id: 2, from_agent: false, channel: 'internal-note' }] },
  });
  await runSpamGate(deps);
  assert.strictEqual(calls.processTicket.length, 0);
});

test('spam gate: a known customer not yet in our system is drafted with no triage', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(116301552, 'raingonen@gmail.com')],
    known: (email) => email === 'raingonen@gmail.com',
  });
  const r = await runSpamGate(deps);
  assert.deepStrictEqual(calls.processTicket.map(p => p.id), [116301552]);
  assert.strictEqual(calls.triage.length, 0);
  assert.strictEqual(r.spamRecovered[0].via, 'known customer');
});

test('spam gate: an unknown sender is triaged; junk is auto-resolved, a customer verdict is drafted', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'sales@pitch.example'), ticket(2, 'newperson@gmail.com')],
    triage: async ({ ticket: t }) => t.id === 1
      ? { disposition: 'vendor_spam', reason: 'cold pitch' }
      : { disposition: 'real_miss', reason: 'customer' },
    messagesByTicket: { 1: [cust(1)], 2: [cust(2)] },
  });
  const r = await runSpamGate(deps);
  assert.deepStrictEqual(calls.triage, [1, 2]);
  assert.deepStrictEqual(calls.processTicket.map(p => p.id), [2]);
  assert.strictEqual(r.autoResolved.length, 1);
  assert.match(r.autoResolved[0].reason, /^spam-flagged: /);
  assert.strictEqual(r.spamRecovered[0].via, 'triage: customer');
});

test('spam gate: dry run lists every action and writes nothing', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'known@x.y'), ticket(2, 'unknown@x.y'), ticket(3, 'rescued@x.y')],
    known: (email) => email === 'known@x.y',
    advisorRows: [{ id: 3, gorgias_ticket_id: 3, conversation_history: [{ sender: 'customer', channel: 'email' }] }],
    messagesByTicket: { 3: [cust(1), agent(2), cust(3)] },
  });
  const r = await runSpamGate({ ...deps, dryRun: true });
  assert.strictEqual(calls.processTicket.length, 0);
  assert.strictEqual(calls.triage.length, 0);
  assert.deepStrictEqual(r.wouldGate.map(w => w.action), [
    'draft (known customer)',
    'triage (unknown sender)',
    'draft (follow-up reply (G:2 vs A:1))',
  ]);
});

test('spam gate: one failing ticket does not stop the pass', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'a@x.y'), ticket(2, 'b@x.y')],
    known: () => true,
    processResult: (t) => { if (t.id === 1) throw new Error('boom'); return { skipped: false }; },
  });
  const r = await runSpamGate(deps);
  assert.deepStrictEqual(calls.processTicket.map(p => p.id), [1, 2]);
  assert.deepStrictEqual(r.spamRecovered.map(s => s.ticketId), [2]);
});

test('spam gate: the per-run cap bounds triage spend', async () => {
  const { deps, calls } = harness({
    spamTickets: [ticket(1, 'a@x'), ticket(2, 'b@x'), ticket(3, 'c@x')],
    triage: async () => ({ disposition: 'junk', reason: 'probe' }),
  });
  const r = await runSpamGate({ ...deps, maxPerRun: 2 });
  assert.strictEqual(calls.triage.length, 2);
  assert.strictEqual(r.candidates, 2);
});

test('spam gate: the fast path asks Gorgias for tickets updated since the last tick', async () => {
  const since = new Date('2026-09-08T12:00:00Z');
  const { deps, calls } = harness({ spamTickets: [] });
  await runSpamGate({ ...deps, updatedAfter: since });
  assert.deepStrictEqual(calls.fetchOpts, { since, field: 'updated_datetime' });
  const full = harness({ spamTickets: [] });
  await runSpamGate(full.deps);
  assert.strictEqual(full.calls.fetchOpts, undefined, 'the nightly run keeps the default created-date floor');
});

// ── fetchOpenSpamTickets fast-path ordering ──
//
// The fast path needs "touched since the last tick", which is an
// updated_datetime walk: a three-day-old ticket that just got a reply is new
// activity even though its created date is far past any short window.

function gorgiasStub(pages) {
  let call = 0;
  const seen = [];
  return {
    getTickets: async (opts) => {
      seen.push(opts);
      const page = pages[call] || { data: [], nextCursor: null };
      call++;
      return page;
    },
    delay: async () => {},
    calls: () => call,
    seen,
  };
}

test('fetchOpenSpamTickets: an explicit since + field walks and floors on that field', async () => {
  const since = new Date('2026-09-08T12:00:00Z');
  const g = gorgiasStub([
    {
      data: [
        { id: 1, spam: true, status: 'open', created_datetime: '2026-09-04T08:00:00Z', updated_datetime: '2026-09-08T12:30:00Z' }, // old ticket, fresh reply
        { id: 2, spam: true, status: 'open', created_datetime: '2026-09-08T12:10:00Z', updated_datetime: '2026-09-08T12:10:00Z' },
        { id: 3, spam: true, status: 'open', created_datetime: '2026-09-08T11:00:00Z', updated_datetime: '2026-09-08T11:00:00Z' }, // before the tick
      ],
      nextCursor: 'more',
    },
    { data: [{ id: 4, spam: true, status: 'open', created_datetime: '2026-09-08T10:00:00Z', updated_datetime: '2026-09-08T10:00:00Z' }], nextCursor: 'x' },
  ]);
  const found = await fetchOpenSpamTickets(g, { since, field: 'updated_datetime' });
  assert.deepStrictEqual(found.map(t => t.id), [1, 2]);
  assert.strictEqual(g.seen[0].order_by, 'updated_datetime:desc');
  assert.strictEqual(g.calls(), 1, 'the first page already crossed the floor');
});
