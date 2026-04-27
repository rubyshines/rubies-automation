/**
 * Unit tests for buildConversationHistorySnapshot — message snapshot built from
 * Gorgias API messages and stored on cs_tickets.conversation_history.
 *
 * Run: node --test customer-service/test/buildConversationHistorySnapshot.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Env required by upstream requires; values don't matter for these tests.
process.env.SUPABASE_URL ||= 'http://test';
process.env.SUPABASE_SERVICE_KEY ||= 'test';
process.env.GORGIAS_DOMAIN ||= 'test';
process.env.GORGIAS_API_KEY ||= 'test';
process.env.GORGIAS_EMAIL ||= 'test@test.com';

const { buildConversationHistorySnapshot } = require('../intake/processGorgiasTickets');

const CUSTOMER_BODY_HTML_WITH_QUOTE = `<div dir="auto">Hello the discount code I forgot to apply was <strong>WELCOME10-88ZJ6G1I</strong></div><div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Fri, Apr 24, 2026 at 5:11 PM RUBIES Customer Care &lt;<a href="mailto:care@rubyshines.com">care@rubyshines.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote"><div>Please provide us with the discount code you forgot to apply so we can further check into this for you.</div></blockquote></div></div>`;

const CUSTOMER_STRIPPED_HTML = `<html><body><div dir="auto">Hello the discount code I forgot to apply was <strong>WELCOME10-88ZJ6G1I</strong></div></body></html>`;

describe('buildConversationHistorySnapshot', () => {
  it('prefers body_html over stripped_html for customer email messages (preserves signatures)', () => {
    // Gorgias stripped_html is too aggressive on customer sign-offs (can remove
    // names/addresses needed for exchanges). We keep body_html and let the
    // dashboard collapse the quoted reply chain client-side. The plain-text
    // body field uses stripped_text — no quoted thread, signatures preserved.
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 1,
      from_agent: false,
      channel: 'email',
      via: 'email',
      created_datetime: '2026-04-24T21:15:24+00:00',
      body_html: CUSTOMER_BODY_HTML_WITH_QUOTE,
      stripped_html: CUSTOMER_STRIPPED_HTML,
      stripped_text: 'Hello the discount code I forgot to apply was WELCOME10-88ZJ6G1I',
      body_text: 'Hello the discount code I forgot to apply was WELCOME10-88ZJ6G1I',
    }]);
    assert.equal(snapshot.body_html, CUSTOMER_BODY_HTML_WITH_QUOTE);
    assert.equal(snapshot.sender, 'customer');
    // Plain-text body comes from stripped_text — no quoted reply chain.
    assert.equal(snapshot.body, 'Hello the discount code I forgot to apply was WELCOME10-88ZJ6G1I');
  });

  it('prefers stripped_html over body_html for agent email messages', () => {
    const agentBody = '<p>Hi, thanks for letting me know!</p>';
    const agentBodyWithQuote = agentBody + '<blockquote>customer quoted text</blockquote>';
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 2,
      from_agent: true,
      channel: 'email',
      via: 'api',
      created_datetime: '2026-04-25T10:48:52+00:00',
      body_html: agentBodyWithQuote,
      stripped_html: agentBody,
      sender: { email: 'jamie@rubyshines.com' },
    }]);
    assert.equal(snapshot.body_html, agentBody);
    assert.equal(snapshot.sender, 'agent');
  });

  it('falls back to stripped_html when body_html is empty for customer', () => {
    const html = '<div>Only have stripped</div>';
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 3,
      from_agent: false,
      channel: 'email',
      via: 'email',
      created_datetime: '2026-04-24T21:15:24+00:00',
      body_html: '',
      stripped_html: html,
    }]);
    assert.equal(snapshot.body_html, html);
  });

  it('nulls body_html for help-center customer messages', () => {
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 4,
      from_agent: false,
      channel: 'help-center',
      via: 'self_service',
      created_datetime: '2026-04-24T21:11:44+00:00',
      body_html: '<div>I forgot to apply my discount code</div>',
      stripped_html: '',
      body_text: 'I forgot to apply my discount code\n---------------------------------------\nOrder: #30229',
    }]);
    assert.equal(snapshot.body_html, null);
    assert.equal(snapshot.sender, 'customer');
  });

  it('classifies internal-note channel as note sender', () => {
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 5,
      from_agent: true,
      channel: 'internal-note',
      via: 'api',
      created_datetime: '2026-04-25T10:48:52+00:00',
      body_html: '<p>private note</p>',
      stripped_html: '<p>private note</p>',
    }]);
    assert.equal(snapshot.sender, 'note');
  });
});
