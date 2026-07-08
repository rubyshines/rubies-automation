const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dayBounds, classifyFeedback, pct, classifyOutcome } = require('../lib/statsHelpers');

// ---------------------------------------------------------------------------
// dayBounds
// ---------------------------------------------------------------------------

describe('dayBounds', () => {
  it('returns start/end/date for a given date string', () => {
    const result = dayBounds('2026-04-15');
    assert.equal(result.date, '2026-04-15');
    assert.equal(result.start, '2026-04-15T00:00:00Z');
    assert.equal(result.end, '2026-04-15T23:59:59.999Z');
  });

  it('falls back to today when no date provided', () => {
    const result = dayBounds();
    assert.ok(result.date.match(/^\d{4}-\d{2}-\d{2}$/));
    assert.ok(result.start.includes('T00:00:00Z'));
    assert.ok(result.end.includes('T23:59:59.999Z'));
  });

  it('falls back to today for null', () => {
    const result = dayBounds(null);
    assert.ok(result.date.match(/^\d{4}-\d{2}-\d{2}$/));
  });
});

// ---------------------------------------------------------------------------
// classifyFeedback
// ---------------------------------------------------------------------------

describe('classifyFeedback', () => {
  it('classifies compound sent actions as noEdit', () => {
    const result = classifyFeedback([
      { action: 'sent_snooze' },
      { action: 'sent_close' },
    ]);
    assert.equal(result.noEdit, 2);
    assert.equal(result.edited, 0);
  });

  it('classifies compound edited actions as edited', () => {
    const result = classifyFeedback([
      { action: 'edited_snooze' },
      { action: 'edited_close' },
    ]);
    assert.equal(result.edited, 2);
    assert.equal(result.noEdit, 0);
  });

  it('classifies exact-match actions', () => {
    const result = classifyFeedback([
      { action: 'released' },
      { action: 'closed_no_reply' },
      { action: 'spam' },
      { action: 'deleted' },
    ]);
    assert.equal(result.released, 1);
    assert.equal(result.closedNoReply, 1);
    assert.equal(result.spam, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.noEdit, 0);
    assert.equal(result.edited, 0);
  });

  it('handles empty array', () => {
    const result = classifyFeedback([]);
    assert.equal(result.noEdit, 0);
    assert.equal(result.edited, 0);
    assert.equal(result.released, 0);
    assert.equal(result.spam, 0);
  });

  it('handles null/undefined actions gracefully', () => {
    const result = classifyFeedback([
      { action: null },
      { action: undefined },
      {},
    ]);
    assert.equal(result.noEdit, 0);
    assert.equal(result.edited, 0);
  });

  it('handles a mixed realistic batch', () => {
    const result = classifyFeedback([
      { action: 'sent_snooze' },
      { action: 'sent_close' },
      { action: 'sent_snooze' },
      { action: 'edited_snooze' },
      { action: 'released' },
      { action: 'spam' },
      { action: 'closed_no_reply' },
    ]);
    assert.equal(result.noEdit, 3);
    assert.equal(result.edited, 1);
    assert.equal(result.released, 1);
    assert.equal(result.spam, 1);
    assert.equal(result.closedNoReply, 1);
    assert.equal(result.deleted, 0);
  });
});

// ---------------------------------------------------------------------------
// pct
// ---------------------------------------------------------------------------

describe('pct', () => {
  it('calculates percentage with one decimal', () => {
    assert.equal(pct(3, 10), '30.0%');
  });

  it('returns N/A when total is 0', () => {
    assert.equal(pct(5, 0), 'N/A');
  });

  it('returns 100.0% for perfect score', () => {
    assert.equal(pct(10, 10), '100.0%');
  });

  it('returns 0.0% for zero numerator', () => {
    assert.equal(pct(0, 10), '0.0%');
  });

  it('handles fractional percentages', () => {
    assert.equal(pct(1, 3), '33.3%');
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome
// ---------------------------------------------------------------------------

describe('classifyOutcome', () => {
  it('returns redirected when redirect count > 0 regardless of action', () => {
    assert.equal(classifyOutcome('sent_snooze', 2), 'redirected');
    assert.equal(classifyOutcome('edited_close', 1), 'redirected');
  });

  it('classifies sent_ actions as no_edit', () => {
    assert.equal(classifyOutcome('sent_snooze', 0), 'no_edit');
    assert.equal(classifyOutcome('sent_close', 0), 'no_edit');
  });

  it('classifies edited_ actions as edited', () => {
    assert.equal(classifyOutcome('edited_snooze', 0), 'edited');
    assert.equal(classifyOutcome('edited_close', 0), 'edited');
  });

  it('classifies exact-match actions', () => {
    assert.equal(classifyOutcome('released', 0), 'released');
    assert.equal(classifyOutcome('closed_no_reply', 0), 'closed_no_reply');
    assert.equal(classifyOutcome('spam', 0), 'spam');
    assert.equal(classifyOutcome('deleted', 0), 'deleted');
  });

  it('returns unknown for unrecognized actions', () => {
    assert.equal(classifyOutcome('something_weird', 0), 'unknown');
    assert.equal(classifyOutcome(null, 0), 'unknown');
    assert.equal(classifyOutcome(undefined, 0), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Previously-uncounted action families (bypassed_*/manual_*/auto_*)
// ---------------------------------------------------------------------------

describe('classifyOutcome — full action vocabulary', () => {
  it('classifies bypassed variants (bare + compound)', () => {
    assert.equal(classifyOutcome('bypassed', 0), 'bypassed');
    assert.equal(classifyOutcome('bypassed_snooze', 0), 'bypassed');
    assert.equal(classifyOutcome('bypassed_close', 0), 'bypassed');
  });

  it('classifies manual variants (compound + backfilled)', () => {
    assert.equal(classifyOutcome('manual_snooze', 0), 'manual');
    assert.equal(classifyOutcome('manual_backfilled', 0), 'manual');
  });

  it('classifies auto-close and auto-follow-up', () => {
    assert.equal(classifyOutcome('auto_close_thank_you', 0), 'auto_closed');
    assert.equal(classifyOutcome('auto_follow_up_stage1', 0), 'auto_follow_up');
    assert.equal(classifyOutcome('auto_follow_up_stage2', 0), 'auto_follow_up');
  });

  it('classifies bare sent (detect_bypasses writer) as no_edit', () => {
    assert.equal(classifyOutcome('sent', 0), 'no_edit');
  });

  it('classifies returned_to_inbox', () => {
    assert.equal(classifyOutcome('returned_to_inbox', 0), 'returned_to_inbox');
  });
});

describe('classifyFeedback — new counters', () => {
  it('counts the previously-invisible families', () => {
    const result = classifyFeedback([
      { action: 'bypassed_snooze' },
      { action: 'bypassed' },
      { action: 'manual_close' },
      { action: 'manual_backfilled' },
      { action: 'auto_close_thank_you' },
      { action: 'auto_follow_up_stage1' },
      { action: 'returned_to_inbox' },
      { action: 'something_else' },
    ]);
    assert.equal(result.bypassed, 2);
    assert.equal(result.manual, 2);
    assert.equal(result.autoClosed, 1);
    assert.equal(result.autoFollowUp, 1);
    assert.equal(result.returnedToInbox, 1);
    assert.equal(result.unknown, 1);
    assert.equal(result.noEdit, 0);
  });
});
