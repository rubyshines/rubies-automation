/**
 * The duplicate-outreach guard.
 *
 * Proactive outreach is the one CS action with no inbound message anchoring
 * it, so nothing forces a look at what the customer has already been told. On
 * 2026-09-15 a pre-order delay wave wrote to a customer three weeks into an
 * open thread about the same two items, and to another who had been told the
 * same news twenty minutes earlier. Both times the evidence was one query away.
 *
 * Run: node --test customer-service/test/recentContact.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const NOW = new Date('2026-09-15T18:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// A Supabase stub covering only what the helper uses: .from().select().eq()/.in()
function fakeSupabase(tickets, { error = null } = {}) {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: (_col, value) => Promise.resolve(
          error ? { data: null, error: { message: error } }
            : { data: tickets.filter((t) => t.customer_email === value), error: null }),
        in: (_col, values) => Promise.resolve(
          error ? { data: null, error: { message: error } }
            : { data: tickets.filter((t) => values.includes(t.customer_email)), error: null }),
      };
      return builder;
    },
  };
}

const { recentAgentMessages, recentAgentMessagesForMany, describeRecentContact } = require('../lib/recentContact');

const TICKETS = [
  {
    id: 3220,
    order_number: '#32705',
    customer_email: 'cathy@example.com',
    conversation_history: [
      { sender: 'customer', created_at: daysAgo(29), body: 'Checking on my two orders' },
      { sender: 'agent', created_at: daysAgo(28), body: 'Both are pre-orders, the gaff follows later' },
      { sender: 'agent', created_at: daysAgo(20), body: 'Your order shipped expedited' },
    ],
  },
  {
    id: 1000,
    order_number: 31000,
    customer_email: 'cathy@example.com',
    conversation_history: [
      { sender: 'agent', created_at: daysAgo(400), body: 'Ancient history' },
    ],
  },
  {
    id: 2000,
    order_number: 32000,
    customer_email: 'quiet@example.com',
    conversation_history: [
      { sender: 'customer', created_at: daysAgo(2), body: 'Any update? (we never replied)' },
    ],
  },
];

describe('recentAgentMessages', () => {
  it('returns our messages inside the window, newest first', async () => {
    const { messages, error } = await recentAgentMessages('cathy@example.com', { now: NOW, supabase: fakeSupabase(TICKETS) });
    assert.equal(error, null);
    assert.equal(messages.length, 2);
    assert.ok(messages[0].sent_at > messages[1].sent_at, 'newest first');
    assert.equal(messages[0].ticket_id, 3220);
    assert.equal(messages[0].order_number, 32705, 'a leading # is stripped');
  });

  it('ignores messages older than the window', async () => {
    const { messages } = await recentAgentMessages('cathy@example.com', { now: NOW, windowDays: 25, supabase: fakeSupabase(TICKETS) });
    assert.equal(messages.length, 1, 'the 28-day-old message falls outside a 25-day window');
  });

  it('does not count the customer writing to us', async () => {
    // Someone awaiting a reply is not a duplicate risk — the guard must not
    // block outreach to them.
    const { messages } = await recentAgentMessages('quiet@example.com', { now: NOW, supabase: fakeSupabase(TICKETS) });
    assert.deepEqual(messages, []);
  });

  it('reports a lookup failure instead of returning a clean record', async () => {
    // The dangerous failure: a guard that cannot read its source looks exactly
    // like "nothing was ever sent".
    const { messages, error } = await recentAgentMessages('cathy@example.com', { now: NOW, supabase: fakeSupabase([], { error: 'connection reset' }) });
    assert.deepEqual(messages, []);
    assert.match(error, /connection reset/);
  });

  it('treats now as an upper bound, so replaying a past decision is honest', async () => {
    // Without this, asking "what did we know at 16:45?" returns messages sent
    // at 16:48 and the guard looks like it would have fired when it would not.
    const later = [{
      id: 4000, order_number: 33000, customer_email: 'future@example.com',
      conversation_history: [{ sender: 'agent', created_at: '2026-09-15T20:00:00Z', body: 'sent later' }],
    }];
    const { messages } = await recentAgentMessages('future@example.com', {
      now: new Date('2026-09-15T16:45:00Z'), supabase: fakeSupabase(later),
    });
    assert.deepEqual(messages, []);
  });

  it('is quiet for a customer with no history at all', async () => {
    const { messages, error } = await recentAgentMessages('new@example.com', { now: NOW, supabase: fakeSupabase(TICKETS) });
    assert.deepEqual(messages, []);
    assert.equal(error, null);
  });
});

describe('recentAgentMessagesForMany', () => {
  it('buckets a whole wave by email in one query', async () => {
    const { byEmail, error } = await recentAgentMessagesForMany(
      ['cathy@example.com', 'quiet@example.com', 'new@example.com'],
      { now: NOW, supabase: fakeSupabase(TICKETS) });
    assert.equal(error, null);
    assert.equal(byEmail.get('cathy@example.com').length, 2);
    assert.deepEqual(byEmail.get('quiet@example.com'), []);
    assert.deepEqual(byEmail.get('new@example.com'), [], 'an email with no tickets still gets a bucket');
  });

  it('surfaces a lookup failure', async () => {
    const { error } = await recentAgentMessagesForMany(['cathy@example.com'], { now: NOW, supabase: fakeSupabase([], { error: 'timeout' }) });
    assert.match(error, /timeout/);
  });
});

describe('describeRecentContact', () => {
  it('renders one readable line per message', async () => {
    const { messages } = await recentAgentMessages('cathy@example.com', { now: NOW, supabase: fakeSupabase(TICKETS) });
    const lines = describeRecentContact(messages);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /ticket 3220/);
    assert.match(lines[0], /#32705/);
    assert.match(lines[0], /Your order shipped expedited/);
  });
});

// ---------------------------------------------------------------------------
// The guard inside create_outreach_ticket
// ---------------------------------------------------------------------------

describe('create_outreach_ticket refuses to write over a live conversation', () => {
  const toolPath = require.resolve('../lib/tools/createOutreachTicket');
  const recentPath = require.resolve('../lib/recentContact');
  const supabasePath = require.resolve('../../shared/supabaseClient');
  const composePath = require.resolve('../lib/composeOutboundDraft');
  const contextPath = require.resolve('../lib/contextBuilder');
  const outreachPath = require.resolve('../lib/customerOutreach');

  function loadTool({ contact, onCompose }) {
    for (const p of [toolPath, recentPath, supabasePath, composePath, contextPath, outreachPath]) delete require.cache[p];

    require.cache[supabasePath] = {
      id: supabasePath, filename: supabasePath, loaded: true,
      exports: {
        getSupabaseClient: () => ({
          from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { customer_email: 'cathy@example.com', order_number: 32705 }, error: null }) }) }) }),
        }),
      },
    };
    require.cache[recentPath] = {
      id: recentPath, filename: recentPath, loaded: true,
      exports: {
        DEFAULT_WINDOW_DAYS: 30,
        recentAgentMessages: async () => contact,
        describeRecentContact: (m) => m.map((x) => `- ${x.sent_at} ticket ${x.ticket_id}`),
      },
    };
    require.cache[contextPath] = {
      id: contextPath, filename: contextPath, loaded: true,
      exports: { buildContext: async () => ({ targetOrder: { name: '#32705' }, customer: { firstName: 'Cathy' } }) },
    };
    require.cache[composePath] = {
      id: composePath, filename: composePath, loaded: true,
      exports: { composeOutboundDraft: async (...a) => { onCompose?.(...a); return { subject: 's', plain_body: 'b', html_body: '<p>b</p>', summary: 'sum' }; } },
    };
    require.cache[outreachPath] = {
      id: outreachPath, filename: outreachPath, loaded: true,
      exports: { seedOutboundDraft: async () => ({ ok: true, dashboard_url: 'http://x/#ticket-1' }) },
    };

    const tool = require(toolPath).find((t) => t.name === 'create_outreach_ticket');
    return tool.handler;
  }

  const PRIOR = [{ ticket_id: 3220, order_number: 32705, sent_at: '2026-08-26T03:18:00.000Z', body: 'Everything is taken care of' }];

  it('refuses, and does not pay for a draft, when we wrote recently', async () => {
    let composed = 0;
    const handler = loadTool({ contact: { messages: PRIOR, error: null }, onCompose: () => { composed++; } });
    const res = await handler({ order_number: '32705', steer: 'pre-order delay' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /already wrote to cathy@example\.com/i);
    assert.match(res.content[0].text, /ticket 3220/);
    assert.equal(composed, 0, 'the refusal must come before the model call');
  });

  it('proceeds when the caller acknowledges the history, and says so in the result', async () => {
    const handler = loadTool({ contact: { messages: PRIOR, error: null } });
    const res = await handler({ order_number: '32705', steer: 'genuinely new', acknowledge_recent_contact: true });
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /Draft outreach ready/);
    assert.match(res.content[0].text, /acknowledged/i, 'the staged draft still records that we knew');
  });

  it('refuses when the history lookup itself fails', async () => {
    let composed = 0;
    const handler = loadTool({ contact: { messages: [], error: 'connection reset' }, onCompose: () => { composed++; } });
    const res = await handler({ order_number: '32705', steer: 'pre-order delay' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /connection reset/);
    assert.equal(composed, 0);
  });

  it('stays out of the way for a customer we have not written to', async () => {
    const handler = loadTool({ contact: { messages: [], error: null } });
    const res = await handler({ order_number: '32705', steer: 'first contact' });
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /Draft outreach ready/);
    assert.doesNotMatch(res.content[0].text, /acknowledged/i);
  });
});
