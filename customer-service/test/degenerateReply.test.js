// isDegenerateReply — guards the customer-facing draft slot against
// degraded-inference replies that parse fine but carry no content
// (observed 2026-06-12: schema-valid JSON with customer_reply ",").
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isDegenerateReply } = require('../lib/advisorOutputSchema');

describe('isDegenerateReply', () => {
  it('flags single punctuation tokens', () => {
    assert.equal(isDegenerateReply(','), true);
    assert.equal(isDegenerateReply(':'), true);
    assert.equal(isDegenerateReply('...'), true);
  });

  it('flags empty and whitespace-only replies', () => {
    assert.equal(isDegenerateReply(''), true);
    assert.equal(isDegenerateReply('   \n\n  '), true);
    assert.equal(isDegenerateReply(null), true);
    assert.equal(isDegenerateReply(undefined), true);
  });

  it('flags fragments far below any real reply', () => {
    assert.equal(isDegenerateReply('ok'), true);
    assert.equal(isDegenerateReply('Hi,'), true);
  });

  it('passes the shortest legitimate reply shape (post-action closing)', () => {
    assert.equal(
      isDegenerateReply("You're welcome! Take care, Jamie Alexander, RUBIES Founder"),
      false
    );
  });

  it('passes a normal customer email', () => {
    assert.equal(
      isDegenerateReply('Hi,\n\nI looked into your order and it ships tomorrow.\n\nTalk soon,\nJamie Alexander, RUBIES Founder'),
      false
    );
  });
});
