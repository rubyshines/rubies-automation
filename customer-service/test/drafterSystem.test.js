/**
 * Tests for the AI Draft System — poller helpers, edit distance, confidence.
 *
 * Run: node --test customer-service/test/drafterSystem.test.js
 *   or: npm run test:drafter
 *
 * These are unit tests — no API calls, no Supabase, no Gorgias.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Extract pure functions from poller (they're module-scoped, so we re-implement
// the same logic here for testing — the poller's copies are the source of truth)
// ---------------------------------------------------------------------------

function computeEditDistance(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);
  const maxLen = Math.max(wordsA.length, wordsB.length);
  if (maxLen === 0) return 0;
  const m = wordsA.length, n = wordsB.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = wordsA[i - 1] === wordsB[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n] / maxLen;
}

function computeConfidence(structured) {
  if (structured.status === 'ready') {
    const allResolved = structured.prescription?.items?.every(i =>
      i.state === 'CONFIRMED' || i.state === 'REFUND_CONFIRMED' || i.state === 'ACKNOWLEDGED'
    );
    return allResolved ? 'high' : 'medium';
  }
  if (structured.status === 'needs_info') return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Edit distance tests
// ---------------------------------------------------------------------------

describe('computeEditDistance', () => {
  it('identical strings return 0', () => {
    assert.equal(computeEditDistance('hello world', 'hello world'), 0);
  });

  it('completely different strings return ~1', () => {
    const dist = computeEditDistance('hello world', 'foo bar baz qux');
    assert.ok(dist > 0.8, `Expected > 0.8, got ${dist}`);
  });

  it('both empty returns 0', () => {
    assert.equal(computeEditDistance('', ''), 0);
  });

  it('one empty returns 1', () => {
    assert.equal(computeEditDistance('hello', ''), 1);
    assert.equal(computeEditDistance('', 'hello'), 1);
  });

  it('both null returns 0', () => {
    assert.equal(computeEditDistance(null, null), 0);
  });

  it('one null returns 1', () => {
    assert.equal(computeEditDistance('hello', null), 1);
  });

  it('small edit has low distance', () => {
    const draft = 'Thanks Alex! The next size up for the AJ is the 12 which has 1.5" more fabric around the waist.';
    const edited = 'Thanks Alex! The next size up for the AJ is the 12 which has 1.5" more fabric around the waist. Shall I set that up?';
    const dist = computeEditDistance(draft, edited);
    assert.ok(dist <= 0.2, `Expected <= 0.2, got ${dist}`);
  });

  it('major rewrite has high distance', () => {
    const draft = 'Thanks Alex! The next size up for the AJ is the 12.';
    const rewrite = 'Hi there, I would recommend trying the Charlie in a size 8 instead. The AJ might not be the best fit for what you need.';
    const dist = computeEditDistance(draft, rewrite);
    assert.ok(dist > 0.5, `Expected > 0.5, got ${dist}`);
  });

  it('is case insensitive', () => {
    assert.equal(computeEditDistance('Hello World', 'hello world'), 0);
  });

  it('single word change is proportional', () => {
    const dist = computeEditDistance('the quick brown fox', 'the slow brown fox');
    assert.equal(dist, 1 / 4); // 1 substitution out of 4 words
  });
});

// ---------------------------------------------------------------------------
// Confidence calculation tests
// ---------------------------------------------------------------------------

describe('computeConfidence', () => {
  it('ready with all CONFIRMED items returns high', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [
        { state: 'CONFIRMED' },
        { state: 'CONFIRMED' },
      ]},
    }), 'high');
  });

  it('ready with all REFUND_CONFIRMED returns high', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [{ state: 'REFUND_CONFIRMED' }] },
    }), 'high');
  });

  it('ready with mixed CONFIRMED + REFUND_CONFIRMED returns high', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [
        { state: 'CONFIRMED' },
        { state: 'REFUND_CONFIRMED' },
      ]},
    }), 'high');
  });

  it('ready with AWAITING items returns medium', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [
        { state: 'CONFIRMED' },
        { state: 'AWAITING_SIZE_CONFIRMATION' },
      ]},
    }), 'medium');
  });

  it('needs_info returns medium', () => {
    assert.equal(computeConfidence({
      status: 'needs_info',
      prescription: { items: [] },
    }), 'medium');
  });

  it('gathering returns low', () => {
    assert.equal(computeConfidence({
      status: 'gathering',
      prescription: { items: [] },
    }), 'low');
  });

  it('ready with no items returns high (vacuously true)', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [] },
    }), 'high');
  });

  it('ready with ACKNOWLEDGED returns high', () => {
    assert.equal(computeConfidence({
      status: 'ready',
      prescription: { items: [{ state: 'ACKNOWLEDGED' }] },
    }), 'high');
  });
});

// ---------------------------------------------------------------------------
// Follow-up draft text tests
// ---------------------------------------------------------------------------

describe('follow-up draft text', () => {
  function buildFollowUp(customerName) {
    const greeting = customerName ? `Hi ${customerName}` : 'Hi there';
    return `${greeting}, just checking in! Did you have any questions about the exchange? Happy to help if so.`;
  }

  it('includes customer name when known', () => {
    const text = buildFollowUp('Sarah');
    assert.ok(text.startsWith('Hi Sarah'));
  });

  it('uses generic greeting when no name', () => {
    const text = buildFollowUp(null);
    assert.ok(text.startsWith('Hi there'));
  });
});

// ---------------------------------------------------------------------------
// Gorgias message filtering tests
// ---------------------------------------------------------------------------

describe('message filtering logic', () => {
  function isCustomerMessage(msg) {
    return msg.source?.type === 'customer' || msg.sender?.type === 'customer';
  }

  function isAgentReply(msg) {
    return !isCustomerMessage(msg) && msg.channel !== 'internal-note';
  }

  it('detects customer messages by source.type', () => {
    assert.ok(isCustomerMessage({ source: { type: 'customer' } }));
  });

  it('detects customer messages by sender.type', () => {
    assert.ok(isCustomerMessage({ sender: { type: 'customer' } }));
  });

  it('agent email is not a customer message', () => {
    assert.ok(!isCustomerMessage({ source: { type: 'email' }, sender: { type: 'agent' } }));
  });

  it('internal notes are not agent replies', () => {
    assert.ok(!isAgentReply({ source: { type: 'agent' }, channel: 'internal-note' }));
  });

  it('agent emails are agent replies', () => {
    assert.ok(isAgentReply({ source: { type: 'agent' }, channel: 'email' }));
  });
});
