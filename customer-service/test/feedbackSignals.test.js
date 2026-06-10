const { test } = require('node:test');
const assert = require('node:assert');
const { buildSendFeedbackRow, buildManualSendFeedbackRow, normalizeForCompare } = require('../lib/feedbackSignals');

const baseDraft = {
  id: 42,
  gorgias_ticket_id: 9001,
  draft_response: 'Hi there,\n\nThe medium will have 2" less fabric. Want me to send it?\n\nJamie',
  advisor_status: 'ready',
  confidence: 'high',
  message_type: 'exchange',
  turn_number: 1,
  operator_steer: null,
  draft_history: [],
};

test('unedited send logs sent_<after> with regen/steer fields', () => {
  const row = buildSendFeedbackRow(baseDraft, baseDraft.draft_response, { afterAction: 'snooze' });
  assert.equal(row.action, 'sent_snooze');
  assert.equal(row.draft_id, 42);
  assert.equal(row.operator_steer, null);
  assert.equal(row.regen_count, 0);
  assert.equal(row.original_response, baseDraft.draft_response);
  assert.equal(row.final_response, baseDraft.draft_response);
});

test('whitespace-only changes do NOT count as edited', () => {
  const row = buildSendFeedbackRow(baseDraft, baseDraft.draft_response.replace(/\n\n/g, '\n \n ') + '  ', { afterAction: 'close' });
  assert.equal(row.action, 'sent_close');
});

test('real edits count as edited', () => {
  const row = buildSendFeedbackRow(baseDraft, 'Hi there, totally different reply. Jamie', { afterAction: 'snooze' });
  assert.equal(row.action, 'edited_snooze');
});

test('steered draft sent unedited still logs edited (original differs from active draft)', () => {
  const steered = { ...baseDraft, operator_steer: 'offer the L instead', draft_history: [{}, {}] };
  const row = buildSendFeedbackRow(steered, steered.draft_response, {
    originalResponse: 'Hi there, the small will have 4" less. Jamie', // first pre-steer draft
    afterAction: 'snooze',
  });
  assert.equal(row.action, 'edited_snooze');
  assert.equal(row.operator_steer, 'offer the L instead');
  assert.equal(row.regen_count, 2);
  assert.match(row.original_response, /small/);
});

test('manual send with bypassed active draft logs bypassed_<after> and carries draft context', () => {
  const row = buildManualSendFeedbackRow({
    activeDraft: { ...baseDraft, operator_steer: 'warmer', draft_history: [{}] },
    gorgiasTicketId: 9001,
    message: 'Hey, I took care of this personally. Jamie',
    afterAction: 'close',
  });
  assert.equal(row.action, 'bypassed_close');
  assert.equal(row.draft_id, 42);
  assert.equal(row.original_response, baseDraft.draft_response);
  assert.equal(row.final_response, 'Hey, I took care of this personally. Jamie');
  assert.equal(row.message_type, 'exchange');
  assert.equal(row.operator_steer, 'warmer');
  assert.equal(row.regen_count, 1);
});

test('manual send with no draft logs manual_<after> with empty original', () => {
  const row = buildManualSendFeedbackRow({
    activeDraft: null,
    manualDraftId: 77,
    gorgiasTicketId: 9002,
    message: 'Quick note from Jamie',
    afterAction: 'snooze',
  });
  assert.equal(row.action, 'manual_snooze');
  assert.equal(row.draft_id, 77);
  assert.equal(row.original_response, '');
  assert.equal(row.confidence, null);
  assert.equal(row.regen_count, 0);
});

test('normalizeForCompare collapses whitespace', () => {
  assert.equal(normalizeForCompare('  a\n\nb  c '), 'a b c');
});
