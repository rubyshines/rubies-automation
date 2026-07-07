/**
 * Unit tests for the continuation transplant (2026-07-07 eaten-replies incident).
 *
 * When a customer's reply fails to thread and spawns a fresh Gorgias ticket,
 * transplantContinuation moves the message onto the surviving ticket instead
 * of closing it away. Two orderings are load-bearing and pinned here:
 *
 * 1. Transplant BEFORE reopen — reopening a snoozed survivor first fires a
 *    snoozed→open webhook whose latest message is still our agent reply,
 *    which gorgiasTicketUpdated reads as snooze expiry and answers with a
 *    Stage 1 "just following up" nudge.
 * 2. All Gorgias writes before any Supabase write (split-brain rule).
 *
 * Run: node --test customer-service/test/ticketContinuation.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { transplantContinuation, buildTransplantMessages } = require('../lib/ticketContinuation');

function makeHarness({ failOn } = {}) {
  const ops = [];
  const maybeFail = (op) => {
    if (failOn === op) throw new Error(`gorgias ${op} failed`);
  };
  const gorgias = {
    addTicketMessage: async (id, msg) => { maybeFail('addTicketMessage'); ops.push(['transplant', id, msg]); },
    addInternalNote: async (id, note) => { maybeFail('addInternalNote'); ops.push(['note', id, note]); },
    reopenTicket: async (id) => { maybeFail('reopenTicket'); ops.push(['reopen', id]); },
    closeTicket: async (id) => { maybeFail('closeTicket'); ops.push(['close', id]); },
  };
  const supabase = {
    from: (table) => ({
      update: (patch) => ({
        eq: async (col, val) => { ops.push(['supabase', table, patch, col, val]); return { error: null }; },
      }),
    }),
  };
  return { ops, gorgias, supabase };
}

const SURVIVOR = { id: 2154, gorgias_ticket_id: 105738229 };
const MESSAGES = [
  { text: 'Yes, the youth size 11 please!', sentDatetime: '2026-06-28T16:14:00Z', attachments: [] },
];

describe('transplantContinuation', () => {
  it('transplants, notes, reopens survivor, closes stray, then resets Supabase — in that order', async () => {
    const { ops, gorgias, supabase } = makeHarness();

    await transplantContinuation({
      gorgias, supabase,
      newTicketId: 105776387,
      survivor: SURVIVOR,
      customerEmail: 'nancy@example.com',
      customerName: 'Nancy',
      customerMessages: MESSAGES,
    });

    const kinds = ops.map(o => o[0]);
    const idx = (k) => kinds.indexOf(k);

    // The transplanted message lands on the survivor as a customer message
    const transplant = ops.find(o => o[0] === 'transplant');
    assert.equal(transplant[1], 105738229);
    assert.equal(transplant[2].fromAgent, false);
    assert.equal(transplant[2].fromAddress, 'nancy@example.com');
    assert.equal(transplant[2].bodyText, 'Yes, the youth size 11 please!');
    assert.equal(transplant[2].sentDatetime, '2026-06-28T16:14:00Z');

    // Ordering invariant 1: transplant strictly before reopen
    assert.ok(idx('transplant') < idx('reopen'), 'transplant must precede reopen (Stage 1 misfire guard)');

    // The stray ticket is closed, with a pointer note, after the survivor is set up
    assert.ok(kinds.includes('close'));
    assert.equal(ops.find(o => o[0] === 'close')[1], 105776387);
    assert.ok(idx('reopen') < idx('close'));

    // Ordering invariant 2: the Supabase reset is the LAST operation
    assert.equal(kinds[kinds.length - 1], 'supabase');
    const sb = ops[ops.length - 1];
    assert.equal(sb[1], 'cs_tickets');
    assert.equal(sb[2].status, 'open');
    assert.equal(sb[2].follow_up_stage, 0);
    assert.equal(sb[4], 2154, 'reset targets the survivor row id');
  });

  it('transplants every customer message when the stray ticket has several', async () => {
    const { ops, gorgias, supabase } = makeHarness();
    await transplantContinuation({
      gorgias, supabase,
      newTicketId: 1, survivor: SURVIVOR, customerEmail: 'n@e.com', customerName: null,
      customerMessages: [
        { text: 'first', sentDatetime: '2026-07-01T00:00:00Z', attachments: [] },
        { text: 'second', sentDatetime: '2026-07-01T00:05:00Z', attachments: [] },
      ],
    });
    const transplants = ops.filter(o => o[0] === 'transplant');
    assert.equal(transplants.length, 2);
    assert.deepEqual(transplants.map(t => t[2].bodyText), ['first', 'second']);
  });

  it('does not touch Supabase when a Gorgias write fails (split-brain rule)', async () => {
    const { ops, gorgias, supabase } = makeHarness({ failOn: 'closeTicket' });
    await assert.rejects(() => transplantContinuation({
      gorgias, supabase,
      newTicketId: 1, survivor: SURVIVOR, customerEmail: 'n@e.com', customerName: null,
      customerMessages: MESSAGES,
    }));
    assert.ok(!ops.some(o => o[0] === 'supabase'), 'Supabase must not be written after a Gorgias failure');
  });

  it('refuses to run with nothing to transplant', async () => {
    const { ops, gorgias, supabase } = makeHarness();
    await assert.rejects(() => transplantContinuation({
      gorgias, supabase,
      newTicketId: 1, survivor: SURVIVOR, customerEmail: 'n@e.com', customerName: null,
      customerMessages: [],
    }));
    assert.equal(ops.length, 0);
  });
});

describe('buildTransplantMessages', () => {
  const extract = (m) => m.body_text || '';

  it('keeps customer messages with text, drops agent messages and internal notes', () => {
    const messages = [
      { from_agent: false, channel: 'email', body_text: 'my reply', created_datetime: '2026-07-01T00:00:00Z', attachments: [{ url: 'x' }] },
      { from_agent: true, channel: 'email', body_text: 'agent reply' },
      { from_agent: false, channel: 'internal-note', body_text: 'note' },
      { from_agent: false, channel: 'email', body_text: '   ' },
    ];
    const out = buildTransplantMessages(messages, extract);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'my reply');
    assert.equal(out[0].sentDatetime, '2026-07-01T00:00:00Z');
    assert.deepEqual(out[0].attachments, [{ url: 'x' }]);
  });

  it('handles missing input', () => {
    assert.deepEqual(buildTransplantMessages(null, extract), []);
    assert.deepEqual(buildTransplantMessages([], extract), []);
  });
});
