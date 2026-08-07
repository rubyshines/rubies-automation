/**
 * Follow-up visibility tests (2026-07-08).
 *
 * Follow-up sends were invisible in the dashboard: the conversation snapshot
 * only rebuilt at intake (customer replies), and the Stage 2 personal email
 * exists only in SendGrid/Gmail. Pins:
 *  - Stage 1 refreshes the ticket's conversation snapshot after sending.
 *  - Stage 2 writes an internal note to Gorgias (the durable record of the
 *    off-Gorgias send) before closing, then refreshes the snapshot.
 *  - Both are best-effort: a visibility failure never fails the stage.
 *
 * Run: node --test customer-service/test/followUpVisibility.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

// ---------------------------------------------------------------------------
// Stubs (installed before requiring the module under test)
// ---------------------------------------------------------------------------
const stub = (relPath, exports) => {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// Recording supabase stub. Chains resolve from per-table queues; every
// update() is recorded as ['update', table, patch, eqArgs].
const state = { writes: [], queues: {} };
function makeBuilder(table) {
  const b = {
    _op: null, _patch: null, _eq: [],
    select: () => b,
    order: () => b,
    limit: () => b,
    in: () => b,
    insert: (row) => { b._op = 'insert'; state.writes.push(['insert', table, row]); return b; },
    update: (patch) => { b._op = 'update'; b._patch = patch; return b; },
    eq: (...args) => {
      b._eq.push(args);
      if (b._op === 'update') {
        state.writes.push(['update', table, b._patch, args]);
        return Promise.resolve({ error: null });
      }
      return b;
    },
    maybeSingle: () => Promise.resolve({ data: (state.queues[table] || []).shift() ?? null, error: null }),
    single: () => Promise.resolve({ data: (state.queues[table] || []).shift() ?? null, error: null }),
    then: (resolve) => resolve({ data: null, error: null }), // bare awaited insert
  };
  return b;
}
stub('../../shared/supabaseClient', { getSupabaseClient: () => ({ from: makeBuilder }) });
stub('../intake/processGorgiasTickets', {
  getAiBotUserId: async () => 777,
  buildConversationHistorySnapshot: (messages) => messages.map(m => ({ id: m.id, sender: 'x' })),
});
stub('../../shared/sendgridClient', { getSendgridClient: () => ({ send: async () => {} }) });

const { executeStage1, executeStage2, buildPersonalFollowUpEmail } = require('../lib/followUp');
const { SITE_URL, SITE_LABEL } = require('../lib/signatures');

// Recording gorgias stub
function makeGorgias({ failMessages = false, failNote = false } = {}) {
  const calls = [];
  return {
    calls,
    createTicketReply: async () => { calls.push('reply'); return { id: 555 }; },
    snoozeTicket: async () => { calls.push('snooze'); },
    getTicketMessages: async () => {
      calls.push('getMessages');
      if (failMessages) throw new Error('gorgias down');
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    },
    addInternalNote: async (id, note) => {
      if (failNote) throw new Error('note failed');
      calls.push(['note', note]);
    },
    closeTicket: async () => { calls.push('close'); },
    assignTicket: async () => { calls.push('assign'); },
    addTicketTag: async () => { calls.push('tag'); },
  };
}

const TICKET = { id: 42, gorgias_ticket_id: 900001, customer_email: 'c@x.com', customer_name: null };
const SENT_DRAFT = { id: 10, sent_at: '2026-07-01T00:00:00Z', customer_name: 'Skye', customer_email: 'c@x.com', order_number: '#1' };
const CARE_DRAFT = { id: 11, sent_at: '2026-07-04T00:00:00Z', customer_name: 'Skye', customer_email: 'c@x.com', order_number: '#1', previous_draft_id: 10 };

beforeEach(() => { state.writes.length = 0; state.queues = {}; });

describe('Stage 1 visibility', () => {
  it('refreshes the conversation snapshot after sending', async () => {
    state.queues.cs_ai_drafts = [SENT_DRAFT, { id: 11 }]; // maybeSingle draft, insert .single
    const gorgias = makeGorgias();

    const res = await executeStage1(gorgias, TICKET);

    assert.equal(res.sent, true);
    assert.ok(gorgias.calls.includes('getMessages'), 'must re-fetch messages for the snapshot');
    const snapUpdate = state.writes.find(w =>
      w[0] === 'update' && w[1] === 'cs_tickets' && w[2].conversation_history);
    assert.ok(snapUpdate, 'cs_tickets must receive a conversation_history refresh');
    assert.equal(snapUpdate[2].conversation_history.length, 3);
    assert.equal(snapUpdate[2].message_count, 3);
    assert.deepEqual(snapUpdate[3], ['gorgias_ticket_id', 900001]);
  });

  it('still succeeds when the snapshot refresh fails', async () => {
    state.queues.cs_ai_drafts = [SENT_DRAFT, { id: 11 }];
    const gorgias = makeGorgias({ failMessages: true });

    const res = await executeStage1(gorgias, TICKET);

    assert.equal(res.sent, true, 'visibility failure must not fail the stage');
  });
});

describe('Stage 2 visibility', () => {
  it('writes a Gorgias internal note about the jamie@ email before closing, then refreshes', async () => {
    state.queues.cs_ai_drafts = [
      CARE_DRAFT,                       // maybeSingle: stage-1 care draft
      { sent_response: 'original reply text' }, // single: original draft
      { id: 12 },                       // single: stage-2 insert
    ];
    const gorgias = makeGorgias();

    const res = await executeStage2(gorgias, TICKET);

    assert.equal(res.sent, true);
    const note = gorgias.calls.find(c => Array.isArray(c) && c[0] === 'note');
    assert.ok(note, 'must add an internal note');
    assert.match(note[1], /jamie@rubyshines\.com/);
    assert.match(note[1], /Gmail/);
    assert.ok(gorgias.calls.indexOf(note) < gorgias.calls.indexOf('close'), 'note precedes close');
    const snapUpdate = state.writes.find(w =>
      w[0] === 'update' && w[1] === 'cs_tickets' && w[2].conversation_history);
    assert.ok(snapUpdate, 'cs_tickets must receive a conversation_history refresh');
  });

  it('still sends and closes when the note fails', async () => {
    state.queues.cs_ai_drafts = [
      CARE_DRAFT,
      { sent_response: 'original reply text' },
      { id: 12 },
    ];
    const gorgias = makeGorgias({ failNote: true });

    const res = await executeStage2(gorgias, TICKET);

    assert.equal(res.sent, true, 'note failure must not fail the stage');
    assert.ok(gorgias.calls.includes('close'), 'ticket still closes');
  });
});

/**
 * Stage 2 quotes the previous reply, which is STORED AS MARKDOWN — the shared
 * signature renders the site as [rubyshines.com](https://rubyshines.com), and
 * the advisor writes product links the same way. Every other send path runs
 * that through autoLinkProducts; this one escaped it and quoted it verbatim,
 * so a real customer read the raw markdown inside the quote (2026-08-06).
 */
describe('Stage 2 quoted reply rendering', () => {
  const ORIGINAL = `Hi Steph,

Try the [AJ](https://rubyshines.com/products/the-aj-shaping-underwear) in a size L.

**Ultimately your comfort is most important.**

Talk soon,

Jamie Alexander, RUBIES Founder
[${SITE_LABEL}](${SITE_URL})`;

  it('renders markdown links in the quote as real anchors', () => {
    const { html } = buildPersonalFollowUpEmail('Steph', ORIGINAL);
    assert.ok(html.includes(`<a href="${SITE_URL}"`), 'site link is a real anchor');
    assert.ok(html.includes('>AJ</a>'), 'product link is a real anchor');
    assert.ok(!html.includes(']('), 'no markdown link syntax survives into the HTML');
    assert.ok(!html.includes('**'), 'no bold markers survive into the HTML');
  });

  it('flattens markdown in the plain-text half, keeping addresses readable', () => {
    const { text } = buildPersonalFollowUpEmail('Steph', ORIGINAL);
    assert.ok(!text.includes(']('), 'no markdown link syntax in text/plain');
    assert.ok(!text.includes('**'), 'no bold markers in text/plain');
    // Label repeats the URL, so it collapses to the label the signature uses.
    assert.ok(text.includes(`\n${SITE_LABEL}`), 'site reads as the bare label');
    assert.ok(!text.includes(`${SITE_LABEL} (${SITE_URL})`), 'site is not duplicated');
    // A label that is NOT the URL keeps both, so the address is never lost.
    assert.ok(
      text.includes('AJ (https://rubyshines.com/products/the-aj-shaping-underwear)'),
      'product link keeps its address alongside the label',
    );
  });

  it('still escapes markup in the quoted body', () => {
    const { html } = buildPersonalFollowUpEmail('Steph', 'Sizes < 30 fit best <b>here</b>');
    assert.ok(html.includes('&lt;b&gt;here&lt;/b&gt;'), 'raw HTML in the quote stays inert');
    assert.ok(html.includes('Sizes &lt; 30'));
  });

  it('greets without a name and survives an empty quote', () => {
    const { text, html } = buildPersonalFollowUpEmail(null, '');
    assert.match(text, /^Hi there,/);
    assert.ok(html.startsWith('<p>Hi there,</p>'));
  });
});
