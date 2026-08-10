/**
 * Guards on the lean prompt transform (arm B of the 2x2 model/prompt eval).
 *
 * The transform is a diff over the shipped prompt, which is the only thing
 * that makes the two arms comparable — if it ever silently no-ops or cuts the
 * wrong block, the eval measures something nobody chose. Every anchor it
 * depends on is asserted here, so a prompt edit that moves a heading breaks a
 * test instead of quietly changing the experiment.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { leanTransform, exemplarBlock, stripEnvelope } = require('../../eval/leanPrompt');
const { buildSystemPrompt } = require('../lib/aiAdvisor');

// One tone sample is enough to produce the block the transform replaces.
const TONE = [{ situation: 'refund_confirm', context: 'x', agent_message: 'No problem. I sent over a refund.' }];
const shipped = () => buildSystemPrompt(TONE, null, {}).staticPart;

test('lean cuts the register lectures but keeps the founder rulings inside them', () => {
  const lean = leanTransform(shipped());

  assert.ok(!lean.includes('## RESPONSE LENGTH & REGISTER'), 'register lecture section still present');
  assert.ok(lean.includes('## RESPONSE REGISTER'), 'compressed register core missing');

  // The rulings that have no positive exemplar to learn from must survive.
  assert.ok(lean.includes('ONE MOVE PER MESSAGE'), 'lost the governing one-move rule');
  assert.ok(/"Sorry" is reserved for problems RUBIES caused/.test(lean), 'lost the apology gate');
  assert.ok(/ONE question per response/.test(lean), 'lost the one-question rule');
  assert.ok(/never evaluate the person/i.test(lean), 'lost the performed-empathy ruling');
});

test('lean keeps every mechanical and safety style rule', () => {
  const lean = leanTransform(shipped());
  for (const rule of [
    'NEVER use em-dashes',
    'NEVER use emojis',
    "NEVER use the customer's Shopify profile name",
    'Default to they/them',
    'Tool calls precede customer-facing prose',
    'Action tense and structured fields MUST agree',
    'around the belly and just under the belly button',
  ]) assert.ok(lean.includes(rule), `lean dropped a load-bearing style rule: ${rule}`);
});

test('lean leaves policy and anti-hallucination rules intact', () => {
  const cur = shipped();
  const lean = leanTransform(cur);

  for (const heading of [
    '## ANTI-HALLUCINATION RULES',
    '## RUBIES FACTS',
    '## KEY DECISION RULES',
    '## Key Business Rules',
    '## Output Format',
  ]) {
    assert.ok(lean.includes(heading), `lean dropped ${heading}`);
    const section = s => s.slice(s.indexOf(heading), s.indexOf('\n## ', s.indexOf(heading) + 1));
    assert.strictEqual(section(lean), section(cur), `lean modified ${heading}`);
  }
});

test('lean swaps the tone-sample block for the 78 paired exemplars', () => {
  const lean = leanTransform(shipped());
  assert.ok(!lean.includes("Jamie's Actual Writing"), 'tone-sample block survived');
  assert.ok(lean.includes('## How Jamie Replies'), 'exemplar block missing');
  assert.strictEqual((lean.match(/^Customer: /gm) || []).length, 78, 'expected 78 exemplars');
  assert.strictEqual((lean.match(/^Jamie: /gm) || []).length, 78);
});

test('exemplars carry no greeting or signature — the prompt mandates those verbatim', () => {
  for (const entry of exemplarBlock().split('\n\n').filter(s => s.startsWith('['))) {
    const reply = entry.split('\nJamie: ')[1];
    assert.ok(!/^(hi|hey|hello)\b/i.test(reply), `exemplar keeps a greeting: ${reply.slice(0, 60)}`);
    assert.ok(!/RUBIES Founder\s*$/i.test(reply), `exemplar keeps a signature: ${reply.slice(-60)}`);
  }
});

test('stripEnvelope removes greetings and sign-offs, and nothing else', () => {
  assert.strictEqual(stripEnvelope('Hi, Just to confirm would you like me to exchange all 3 items? Talk soon, Jamie Alexander, RUBIES Founder'),
    'Just to confirm would you like me to exchange all 3 items?');
  assert.strictEqual(stripEnvelope('Hi Paula, No problem I just sent over a refund. Take care, Jamie Alexander, RUBIES Founder'),
    'No problem I just sent over a refund.');
  // A body that opens on the word "Thanks" is content, not a sign-off.
  assert.strictEqual(stripEnvelope('Thanks for letting me know. I created the order.'),
    'Thanks for letting me know. I created the order.');
});

test('the transform fails loudly when an anchor it depends on has moved', () => {
  const broken = shipped().replace('## RESPONSE LENGTH & REGISTER (CRITICAL)', '## Response Register (critical)');
  assert.throws(() => leanTransform(broken), /section not found/);

  const newBullet = shipped().replace('- NEVER use emojis.', '- NEVER use emojis.\n- Some new rule nobody classified.');
  assert.throws(() => leanTransform(newBullet), /unclassified writing-style bullet/);
});
