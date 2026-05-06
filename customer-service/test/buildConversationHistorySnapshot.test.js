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
  it('prefers stripped_html over body_html for customer email messages', () => {
    // Trust Gorgias's stripped_* fields — they've already separated new content
    // from quoted reply chains. Avoids client-side regex/DOM gymnastics that
    // break on edge cases (email links inside "On … wrote:", template markers
    // nested in quoted blocks, etc.).
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
    assert.equal(snapshot.body_html, CUSTOMER_STRIPPED_HTML);
    assert.equal(snapshot.sender, 'customer');
    // The quoted "Please provide us..." must NOT appear in stored html.
    assert.ok(!snapshot.body_html.includes('Please provide us with'),
      'quoted reply content leaked into stored body_html');
    assert.ok(!snapshot.body_html.includes('gmail_quote'),
      'gmail_quote wrapper leaked into stored body_html');
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

  it('falls back to body_html when stripped_html is empty', () => {
    const html = '<div>Only have raw body</div>';
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 3,
      from_agent: false,
      channel: 'email',
      via: 'email',
      created_datetime: '2026-04-24T21:15:24+00:00',
      body_html: html,
      stripped_html: '',
    }]);
    assert.equal(snapshot.body_html, html);
  });

  it('falls back to email-reply-parser when Gorgias returns empty stripped fields (non-English locale)', () => {
    // Gorgias's stripper is English-biased and returns empty stripped_text/html
    // for replies with non-English attribution lines (e.g. Danish "Den ... skrev :",
    // French "Le ... a écrit :"). Without library fallback, we'd store the entire
    // quoted Klaviyo campaign as the customer's message and feed it to the advisor.
    const danishReply = `I would like to order these for my daughter.\n\nAll the best,\nCamilla\n\nDen 5. maj 2026 kl. 02.00 skrev RUBIES :\n\nNow ready to order!\n[Big marketing campaign body that should be stripped]\nLots of testimonials, image URLs, etc.`;
    const [snapshot] = buildConversationHistorySnapshot([{
      id: 5,
      from_agent: false,
      channel: 'email',
      via: 'email',
      created_datetime: '2026-05-05T10:28:00+00:00',
      body_text: danishReply,
      body_html: `<p>${danishReply.replace(/\n/g, '<br>')}</p>`,
      stripped_text: '',
      stripped_html: '',
    }]);
    assert.match(snapshot.body, /I would like to order these/);
    assert.match(snapshot.body, /Camilla/);
    assert.doesNotMatch(snapshot.body, /Now ready to order/);
    assert.doesNotMatch(snapshot.body, /testimonials/);
    // body_html is dropped so the dashboard renders the cleaned text rather than
    // the full quoted HTML.
    assert.equal(snapshot.body_html, null);
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
