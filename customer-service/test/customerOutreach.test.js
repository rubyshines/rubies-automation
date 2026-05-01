/**
 * Unit tests for lib/customerOutreach.js — outbound CS ticket pipeline.
 *
 * Run: node --test customer-service/test/customerOutreach.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub gorgiasClient, supabaseClient, and the intake snapshot helper BEFORE
// requiring customerOutreach.
// ---------------------------------------------------------------------------

const gorgiasPath = require.resolve('../import/gorgiasClient');
const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const intakePath = require.resolve('../intake/processGorgiasTickets');

const gorgiasCalls = { createOutboundTicket: [], snoozeTicket: [], getTicketMessages: [] };
let createOutboundTicketImpl = async (args) => {
  gorgiasCalls.createOutboundTicket.push(args);
  return { id: 9001 };
};
let snoozeTicketImpl = async (id, days) => {
  gorgiasCalls.snoozeTicket.push({ id, days });
  return { id, snoozed: true };
};
let getTicketMessagesImpl = async (id) => {
  gorgiasCalls.getTicketMessages.push({ id });
  return [
    {
      id: 50001,
      from_agent: true,
      channel: 'email',
      created_datetime: '2026-04-29T12:00:00Z',
      stripped_text: 'Outbound body plain',
      body_text: 'Outbound body plain',
      body_html: '<p>Outbound body plain</p>',
      stripped_html: '<p>Outbound body plain</p>',
      sender: { email: 'care@rubyshines.com' },
      via: 'api',
      attachments: [],
    },
  ];
};

require.cache[gorgiasPath] = {
  id: gorgiasPath,
  filename: gorgiasPath,
  loaded: true,
  exports: {
    createOutboundTicket: (args) => createOutboundTicketImpl(args),
    snoozeTicket: (id, days) => snoozeTicketImpl(id, days),
    getTicketMessages: (id) => getTicketMessagesImpl(id),
    stripHtml: (s) => String(s || '').replace(/<[^>]+>/g, '').trim(),
  },
};

require.cache[intakePath] = {
  id: intakePath,
  filename: intakePath,
  loaded: true,
  exports: {
    buildConversationHistorySnapshot: (messages) => messages.map(m => ({
      id: m.id,
      sender: m.from_agent === false ? 'customer' : 'agent',
      is_bot: false,
      body_html: m.body_html,
      body: m.body_text,
      created_at: m.created_datetime,
      channel: m.channel,
      attachments: [],
    })),
  },
};

// ---------------------------------------------------------------------------
// Mock supabase — fluent builder that records every call.
// ---------------------------------------------------------------------------

let supabaseCalls = [];
let supabaseResults = {}; // keyed by `${table}.${op}` — overrides per test

function makeMockSupabase() {
  function fromFn(table) {
    const ctx = { table, op: null, payload: null, filters: [], selectCols: null };

    const builder = {
      upsert(payload, opts) {
        ctx.op = 'upsert';
        ctx.payload = payload;
        ctx.opts = opts;
        return this;
      },
      insert(payload) {
        ctx.op = 'insert';
        ctx.payload = payload;
        return this;
      },
      update(payload) {
        ctx.op = 'update';
        ctx.payload = payload;
        return this;
      },
      select(cols) {
        ctx.selectCols = cols;
        return this;
      },
      eq(col, val) {
        ctx.filters.push({ col, val });
        return this;
      },
      single() {
        return this._finalize(true);
      },
      _finalize(isSingle) {
        supabaseCalls.push({ ...ctx });
        const key = `${ctx.table}.${ctx.op}`;
        const override = supabaseResults[key];
        if (override) return Promise.resolve(override);
        // Default success: synthesize a row id
        if (ctx.op === 'upsert' || ctx.op === 'insert') {
          if (isSingle) return Promise.resolve({ data: { id: nextRowId() }, error: null });
          return Promise.resolve({ data: [{ id: nextRowId() }], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        // Allow `await` without .single()
        return this._finalize(false).then(resolve, reject);
      },
    };
    return builder;
  }

  return { from: fromFn };
}

let _idCounter = 100;
function nextRowId() { return _idCounter++; }

require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: {
    getSupabaseClient: () => makeMockSupabase(),
  },
};

// Now require the module under test.
const { sendIncidentOutreach, seedOutboundDraft } = require('../lib/customerOutreach');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetCallTrackers() {
  gorgiasCalls.createOutboundTicket = [];
  gorgiasCalls.snoozeTicket = [];
  gorgiasCalls.getTicketMessages = [];
  supabaseCalls = [];
  supabaseResults = {};
  _idCounter = 100;
  createOutboundTicketImpl = async (args) => {
    gorgiasCalls.createOutboundTicket.push(args);
    return { id: 9001 };
  };
  snoozeTicketImpl = async (id, days) => {
    gorgiasCalls.snoozeTicket.push({ id, days });
    return { id, snoozed: true };
  };
  getTicketMessagesImpl = async (id) => {
    gorgiasCalls.getTicketMessages.push({ id });
    return [
      {
        id: 50001,
        from_agent: true,
        channel: 'email',
        created_datetime: '2026-04-29T12:00:00Z',
        stripped_text: 'Outbound body plain',
        body_text: 'Outbound body plain',
        body_html: '<p>Outbound body plain</p>',
        stripped_html: '<p>Outbound body plain</p>',
        sender: { email: 'care@rubyshines.com' },
        via: 'api',
        attachments: [],
      },
    ];
  };
}

const SAMPLE_OUTREACH = {
  order_number: '12345',
  customer_email: 'customer@example.com',
  customer_name: 'Real Customer',
  subject: 'ACTION required',
  html_body: '<p>Hi,</p><p>Body.</p>',
  plain_body: 'Hi,\n\nBody.',
  summary: 'Naomi backorder — awaiting customer choice',
};

function findCall(table, op) {
  return supabaseCalls.find(c => c.table === table && c.op === op);
}

function findAllCalls(table, op) {
  return supabaseCalls.filter(c => c.table === table && c.op === op);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendIncidentOutreach — dry_run mode', () => {
  beforeEach(resetCallTrackers);

  it('performs zero writes and zero Gorgias calls', async () => {
    const result = await sendIncidentOutreach({ outreaches: [SAMPLE_OUTREACH] });
    assert.equal(result.mode, 'dry_run');
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.sent, 0);
    assert.equal(gorgiasCalls.createOutboundTicket.length, 0);
    assert.equal(gorgiasCalls.snoozeTicket.length, 0);
    assert.equal(supabaseCalls.length, 0);
  });
});

describe('sendIncidentOutreach — test_send mode', () => {
  beforeEach(resetCallTrackers);

  it('creates the Gorgias ticket but performs NO durable writes (no snooze, no cs_tickets, no cs_ai_drafts, no order_alert_notes)', async () => {
    const result = await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH],
      noteText: 'should be ignored in test_send',
      tags: ['test-tag'],
      testRecipient: 'jamie@example.com',
    });

    assert.equal(result.mode, 'test_send');
    assert.equal(result.summary.sent, 1);
    assert.equal(result.summary.failed, 0);

    // Gorgias create called, with recipient overridden to test address
    assert.equal(gorgiasCalls.createOutboundTicket.length, 1);
    assert.equal(gorgiasCalls.createOutboundTicket[0].customerEmail, 'jamie@example.com');
    assert.equal(gorgiasCalls.createOutboundTicket[0].customerName, 'Test Recipient');

    // No snooze, no message fetch, no Supabase writes
    assert.equal(gorgiasCalls.snoozeTicket.length, 0);
    assert.equal(gorgiasCalls.getTicketMessages.length, 0);
    assert.equal(supabaseCalls.length, 0);
  });
});

describe('sendIncidentOutreach — live mode', () => {
  beforeEach(resetCallTrackers);

  it('creates Gorgias ticket, snoozes 3 days, writes cs_tickets + cs_ai_drafts + order_alert_notes', async () => {
    const result = await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH],
      noteText: 'Naomi backorder outreach sent',
      author: 'jamie',
      tags: ['naomi-backorder-apr2026'],
      send: true,
    });

    assert.equal(result.mode, 'live');
    assert.equal(result.summary.sent, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.results[0].status, 'sent');
    assert.equal(result.results[0].ticket_id, 9001);
    assert.ok(result.results[0].cs_ticket_id, 'cs_ticket_id should be populated');

    // Gorgias create with real customer email
    assert.equal(gorgiasCalls.createOutboundTicket.length, 1);
    assert.equal(gorgiasCalls.createOutboundTicket[0].customerEmail, 'customer@example.com');
    assert.equal(gorgiasCalls.createOutboundTicket[0].customerName, 'Real Customer');

    // Snoozed 3 days
    assert.equal(gorgiasCalls.snoozeTicket.length, 1);
    assert.equal(gorgiasCalls.snoozeTicket[0].id, 9001);
    assert.equal(gorgiasCalls.snoozeTicket[0].days, 3);

    // Messages fetched
    assert.equal(gorgiasCalls.getTicketMessages.length, 1);

    // cs_tickets upserted with operator-initiated snoozed shape
    const ticketsUpsert = findCall('cs_tickets', 'upsert');
    assert.ok(ticketsUpsert, 'cs_tickets upsert should have happened');
    assert.equal(ticketsUpsert.payload.gorgias_ticket_id, 9001);
    assert.equal(ticketsUpsert.payload.status, 'snoozed');
    assert.equal(ticketsUpsert.payload.initiated_by, 'operator');
    assert.equal(ticketsUpsert.payload.has_agent_reply, true);
    assert.equal(ticketsUpsert.payload.follow_up_stage, 0);
    assert.equal(ticketsUpsert.payload.message_type, 'outbound_outreach');
    assert.equal(ticketsUpsert.payload.customer_email, 'customer@example.com');
    assert.equal(ticketsUpsert.payload.customer_name, 'Real Customer');
    assert.equal(ticketsUpsert.payload.order_number, '12345');
    assert.equal(ticketsUpsert.payload.summary, 'Naomi backorder — awaiting customer choice');
    assert.equal(ticketsUpsert.payload.last_customer_message_at, null);
    assert.ok(ticketsUpsert.payload.snoozed_at, 'snoozed_at should be set');
    assert.ok(ticketsUpsert.payload.viewed_at, 'viewed_at should be set');
    assert.ok(Array.isArray(ticketsUpsert.payload.conversation_history));
    assert.equal(ticketsUpsert.payload.conversation_history.length, 1);
    assert.equal(ticketsUpsert.payload.conversation_history[0].sender, 'agent');
    assert.equal(ticketsUpsert.opts?.onConflict, 'gorgias_ticket_id');

    // cs_ai_drafts inserted with sent advisor_draft shape
    const draftsInsert = findCall('cs_ai_drafts', 'insert');
    assert.ok(draftsInsert, 'cs_ai_drafts insert should have happened');
    assert.equal(draftsInsert.payload.gorgias_ticket_id, 9001);
    assert.equal(draftsInsert.payload.gorgias_message_id, 50001);
    assert.equal(draftsInsert.payload.draft_kind, 'advisor_draft');
    assert.equal(draftsInsert.payload.status, 'sent');
    assert.equal(draftsInsert.payload.source, 'operator_outreach');
    assert.equal(draftsInsert.payload.confidence, 'high');
    assert.equal(draftsInsert.payload.advisor_status, 'ready');
    assert.equal(draftsInsert.payload.message_type, 'outbound_outreach');
    // Outbound-initiated tickets seed an empty draft_response (nothing to send
    // until the customer replies). sent_response preserves the audit record.
    assert.equal(draftsInsert.payload.draft_response, '');
    assert.equal(draftsInsert.payload.sent_response, 'Hi,\n\nBody.');
    assert.ok(draftsInsert.payload.sent_at, 'sent_at should be set');
    assert.equal(draftsInsert.payload.structured_output.status, 'outbound_initiated');
    assert.equal(draftsInsert.payload.structured_output.source, 'operator_outreach');
    assert.equal(draftsInsert.payload.ticket_id, ticketsUpsert._returnedId || draftsInsert.payload.ticket_id);

    // active_draft_id linked back to ticket
    const ticketsUpdate = findCall('cs_tickets', 'update');
    assert.ok(ticketsUpdate, 'cs_tickets update for active_draft_id should have happened');
    assert.ok('active_draft_id' in ticketsUpdate.payload);

    // order_alert_notes inserted
    const notesInsert = findCall('order_alert_notes', 'insert');
    assert.ok(notesInsert);
    assert.equal(notesInsert.payload.order_number, '12345');
    assert.equal(notesInsert.payload.note, 'Naomi backorder outreach sent');
    assert.equal(notesInsert.payload.author, 'jamie');
    assert.equal(notesInsert.payload.resolved, false);
  });

  it('strips leading # from order_number on cs_tickets row', async () => {
    await sendIncidentOutreach({
      outreaches: [{ ...SAMPLE_OUTREACH, order_number: '#12345' }],
      send: true,
    });
    const ticketsUpsert = findCall('cs_tickets', 'upsert');
    assert.equal(ticketsUpsert.payload.order_number, '12345');
  });

  it('skips order_alert_notes write when noteText is omitted', async () => {
    await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH],
      send: true,
      // no noteText
    });
    assert.equal(findCall('order_alert_notes', 'insert'), undefined);
    // pipeline writes still happened
    assert.ok(findCall('cs_tickets', 'upsert'));
    assert.ok(findCall('cs_ai_drafts', 'insert'));
  });

  it('aborts with status=failed when Gorgias create throws — no Supabase writes, no snooze', async () => {
    createOutboundTicketImpl = async () => { throw new Error('Gorgias 500'); };

    const result = await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH],
      noteText: 'should not write',
      send: true,
    });

    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.sent, 0);
    assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].error, /Gorgias 500/);
    assert.equal(gorgiasCalls.snoozeTicket.length, 0);
    assert.equal(supabaseCalls.length, 0);
  });

  it('marks result pipeline_failed when cs_tickets upsert errors but still writes order_alert_notes', async () => {
    supabaseResults['cs_tickets.upsert'] = { data: null, error: { message: 'unique constraint blew up' } };

    const result = await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH],
      noteText: 'still write',
      send: true,
    });

    assert.equal(result.summary.sent, 1);
    assert.equal(result.results[0].status, 'pipeline_failed');
    assert.match(result.results[0].pipeline_error, /unique constraint blew up/);

    // cs_ai_drafts insert and active_draft_id update should NOT have happened
    assert.equal(findCall('cs_ai_drafts', 'insert'), undefined);
    assert.equal(findCall('cs_tickets', 'update'), undefined);

    // order_alert_notes still written
    assert.ok(findCall('order_alert_notes', 'insert'));
  });

  it('processes multiple outreaches with rate-limit pacing between them', async () => {
    const t0 = Date.now();
    const result = await sendIncidentOutreach({
      outreaches: [SAMPLE_OUTREACH, { ...SAMPLE_OUTREACH, order_number: '12346' }],
      send: true,
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.summary.sent, 2);
    assert.equal(gorgiasCalls.createOutboundTicket.length, 2);
    assert.equal(gorgiasCalls.snoozeTicket.length, 2);
    assert.equal(findAllCalls('cs_tickets', 'upsert').length, 2);
    assert.equal(findAllCalls('cs_ai_drafts', 'insert').length, 2);
    // Pacing: at least 600ms between iterations
    assert.ok(elapsed >= 600, `expected >=600ms with pacing, got ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// seedOutboundDraft — operator-initiated draft staging (no Gorgias write).
// ---------------------------------------------------------------------------

describe('seedOutboundDraft', () => {
  beforeEach(resetCallTrackers);

  const BASE_DRAFT = {
    orderNumber: '12345',
    customerEmail: 'jane@example.com',
    customerName: 'Jane Doe',
    subject: 'About your recent order',
    plainBody: 'Hi,\n\nQuick heads-up about your order.\n\nTake care,\nJamie',
    summary: 'Back-order heads-up',
    steer: 'Naomi back-order — offer cancel or swap',
    noteText: 'Proactive outreach drafted',
  };

  it('inserts cs_tickets + cs_ai_drafts + order_alert_notes with NO Gorgias side effects', async () => {
    const result = await seedOutboundDraft(BASE_DRAFT);

    assert.equal(result.ok, true);
    assert.ok(result.cs_ticket_id);
    assert.ok(result.cs_draft_id);
    assert.match(result.dashboard_url, /#ticket-\d+$/);

    // Critically: zero Gorgias calls
    assert.equal(gorgiasCalls.createOutboundTicket.length, 0);
    assert.equal(gorgiasCalls.snoozeTicket.length, 0);
    assert.equal(gorgiasCalls.getTicketMessages.length, 0);

    // cs_tickets insert with operator-initiated open shape, gorgias_ticket_id NULL
    const ticketsInsert = findCall('cs_tickets', 'insert');
    assert.ok(ticketsInsert);
    assert.equal(ticketsInsert.payload.gorgias_ticket_id, null);
    assert.equal(ticketsInsert.payload.status, 'open');
    assert.equal(ticketsInsert.payload.initiated_by, 'operator');
    assert.equal(ticketsInsert.payload.has_agent_reply, false);
    assert.equal(ticketsInsert.payload.message_type, 'proactive_outreach');
    assert.equal(ticketsInsert.payload.customer_email, 'jane@example.com');
    assert.equal(ticketsInsert.payload.customer_name, 'Jane Doe');
    assert.equal(ticketsInsert.payload.order_number, '12345');
    assert.equal(ticketsInsert.payload.summary, 'Back-order heads-up');
    assert.deepEqual(ticketsInsert.payload.conversation_history, []);

    // cs_ai_drafts insert with pending advisor_draft + draft body in draft_response (not sent_response)
    const draftsInsert = findCall('cs_ai_drafts', 'insert');
    assert.ok(draftsInsert);
    assert.equal(draftsInsert.payload.gorgias_ticket_id, null);
    assert.equal(draftsInsert.payload.gorgias_message_id, null);
    assert.equal(draftsInsert.payload.draft_kind, 'advisor_draft');
    assert.equal(draftsInsert.payload.status, 'pending');
    assert.equal(draftsInsert.payload.source, 'operator_outreach');
    assert.equal(draftsInsert.payload.message_type, 'proactive_outreach');
    assert.equal(draftsInsert.payload.draft_response, BASE_DRAFT.plainBody);
    assert.equal(draftsInsert.payload.sent_response, null);
    assert.equal(draftsInsert.payload.structured_output.subject, 'About your recent order');
    assert.equal(draftsInsert.payload.structured_output.operator_steer, BASE_DRAFT.steer);
    assert.equal(draftsInsert.payload.operator_steer, BASE_DRAFT.steer);

    // active_draft_id linked back
    const ticketsUpdate = findCall('cs_tickets', 'update');
    assert.ok(ticketsUpdate);
    assert.ok('active_draft_id' in ticketsUpdate.payload);

    // order_alert_notes inserted as unresolved
    const notesInsert = findCall('order_alert_notes', 'insert');
    assert.ok(notesInsert);
    assert.equal(notesInsert.payload.order_number, '12345');
    assert.equal(notesInsert.payload.note, 'Proactive outreach drafted');
    assert.equal(notesInsert.payload.resolved, false);
    assert.equal(notesInsert.payload.author, 'operator');
  });

  it('strips leading # from order_number on cs_tickets', async () => {
    await seedOutboundDraft({ ...BASE_DRAFT, orderNumber: '#12345' });
    const ticketsInsert = findCall('cs_tickets', 'insert');
    assert.equal(ticketsInsert.payload.order_number, '12345');
  });

  it('skips order_alert_notes write when noteText is omitted', async () => {
    const result = await seedOutboundDraft({ ...BASE_DRAFT, noteText: undefined });
    assert.equal(result.ok, true);
    assert.equal(findCall('order_alert_notes', 'insert'), undefined);
    assert.ok(findCall('cs_tickets', 'insert'));
    assert.ok(findCall('cs_ai_drafts', 'insert'));
  });

  it('returns error when cs_tickets insert fails — and does NOT proceed to drafts insert', async () => {
    supabaseResults['cs_tickets.insert'] = { data: null, error: { message: 'ticket insert blew up' } };

    const result = await seedOutboundDraft(BASE_DRAFT);
    assert.equal(result.ok, false);
    assert.match(result.error, /ticket insert blew up/);
    assert.equal(findCall('cs_ai_drafts', 'insert'), undefined);
    assert.equal(findCall('order_alert_notes', 'insert'), undefined);
  });

  it('throws when required fields are missing', async () => {
    await assert.rejects(seedOutboundDraft({ ...BASE_DRAFT, customerEmail: undefined }), /customerEmail is required/);
    await assert.rejects(seedOutboundDraft({ ...BASE_DRAFT, subject: undefined }), /subject is required/);
    await assert.rejects(seedOutboundDraft({ ...BASE_DRAFT, plainBody: undefined }), /plainBody is required/);
  });
});
