const { test } = require('node:test');
const assert = require('node:assert');
const { buildJudgeUserMessage, parseJudgeVerdict, excerptConversation, judgeDraftVsSent, CATEGORIES } = require('../lib/closenessJudge');

test('identical drafts short-circuit without an AI call', async () => {
  const verdict = await judgeDraftVsSent({
    draftResponse: 'Hi,\n\nThe medium works.  Jamie',
    sentResponse: 'Hi, The medium works. Jamie',
    conversationHistory: [],
  });
  assert.equal(verdict.category, 'identical');
  assert.equal(verdict.judge_model, 'deterministic');
});

test('judge user message contains conversation, draft, and sent blocks', () => {
  const msg = buildJudgeUserMessage({
    conversationHistory: [
      { sender: 'customer', body: 'It is too tight around the waist' },
      { sender: 'agent', body: 'Sorry to hear that!' },
    ],
    draftResponse: 'DRAFT BODY',
    sentResponse: 'SENT BODY',
    messageType: 'exchange',
  });
  assert.match(msg, /Ticket type: exchange/);
  assert.match(msg, /CUSTOMER: It is too tight/);
  assert.match(msg, /JAMIE: Sorry to hear/);
  assert.match(msg, /--- AI DRAFT ---\nDRAFT BODY/);
  assert.match(msg, /--- SENT \(ground truth\) ---\nSENT BODY/);
});

test('excerptConversation truncates long bodies and caps message count', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ sender: 'customer', body: `msg${i} ` + 'x'.repeat(700) }));
  const out = excerptConversation(history);
  assert.ok(!out.includes('msg0')); // only last 6 kept
  assert.ok(out.includes('msg9'));
  for (const line of out.split('\n')) assert.ok(line.length <= 620);
});

test('parseJudgeVerdict handles fenced JSON and clamps fields', () => {
  const v = parseJudgeVerdict('```json\n{"category":"substantive","draft_may_be_right":true,"severity":"weird","rationale":"Different sizing advice."}\n```');
  assert.equal(v.category, 'substantive');
  assert.equal(v.draft_may_be_right, true);
  assert.equal(v.severity, 'low'); // invalid severity clamped
  assert.equal(v.rationale, 'Different sizing advice.');
});

test('parseJudgeVerdict rejects unknown categories', () => {
  assert.throws(() => parseJudgeVerdict('{"category":"vibes","severity":"low","rationale":"x"}'), /invalid category/);
});

test('category list matches schema comment', () => {
  assert.deepEqual(CATEGORIES, ['identical', 'cosmetic', 'substantive', 'factual_correction', 'action_divergence']);
});
