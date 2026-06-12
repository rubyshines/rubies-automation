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

const { createLoadShedBreaker } = require('../lib/advisorOutputSchema');

describe('createLoadShedBreaker', () => {
  it('is inactive until tripped', () => {
    const b = createLoadShedBreaker(10_000);
    assert.equal(b.active(1_000_000), false);
  });

  it('is active within the cooldown window after a trip', () => {
    const b = createLoadShedBreaker(10_000);
    b.trip(1_000_000);
    assert.equal(b.active(1_000_000 + 1), true);
    assert.equal(b.active(1_000_000 + 9_999), true);
  });

  it('resets after the cooldown elapses', () => {
    const b = createLoadShedBreaker(10_000);
    b.trip(1_000_000);
    assert.equal(b.active(1_000_000 + 10_000), false);
  });

  it('a new trip extends the window', () => {
    const b = createLoadShedBreaker(10_000);
    b.trip(1_000_000);
    b.trip(1_000_000 + 8_000);
    assert.equal(b.active(1_000_000 + 15_000), true);
  });
});
