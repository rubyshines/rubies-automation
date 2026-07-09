/**
 * Knowledge-loop deterministic units:
 *  - buildFactsBlock (aiAdvisor) — prompt rendering of approved facts
 *  - parseJudgeVerdict (closenessJudge) — candidate_fact extraction
 *  - normalizeFact (judgeDaily) — dedupe normalization
 * DB paths (advisorFacts.js CRUD) are exercised via input validation only —
 * Supabase calls stay out of unit tests per repo convention.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { buildFactsBlock } = require('../lib/aiAdvisor');
const { parseJudgeVerdict } = require('../lib/closenessJudge');
const { normalizeFact } = require('../../lib/judgeDaily');

test('buildFactsBlock: empty input renders nothing', () => {
  assert.strictEqual(buildFactsBlock([]), '');
  assert.strictEqual(buildFactsBlock(null), '');
  assert.strictEqual(buildFactsBlock(undefined), '');
});

test('buildFactsBlock: groups by category with labels and bullets', () => {
  const block = buildFactsBlock([
    { fact: 'All tops have a pad pouch.', category: 'product' },
    { fact: 'US orders ship USPS.', category: 'shipping' },
    { fact: 'Second product fact.', category: 'product' },
  ]);
  assert.match(block, /## OPERATOR FACTS/);
  assert.match(block, /Products:\n- All tops have a pad pouch\.\n- Second product fact\./);
  assert.match(block, /Shipping:\n- US orders ship USPS\./);
});

test('buildFactsBlock: unknown/missing category falls back gracefully', () => {
  const block = buildFactsBlock([{ fact: 'A fact.' }, { fact: 'B fact.', category: 'weird_cat' }]);
  assert.match(block, /General:\n- A fact\./);
  assert.match(block, /weird_cat:\n- B fact\./);
});

test('parseJudgeVerdict: extracts candidate_fact when present', () => {
  const v = parseJudgeVerdict(JSON.stringify({
    category: 'factual_correction', draft_may_be_right: false, severity: 'high',
    rationale: 'Sent corrected the pad pouch claim.',
    candidate_fact: 'All RUBIES tops have a built-in pouch for breast pads.',
  }));
  assert.strictEqual(v.candidate_fact, 'All RUBIES tops have a built-in pouch for breast pads.');
});

test('parseJudgeVerdict: null/absent/blank candidate_fact normalizes to null', () => {
  for (const cf of [null, undefined, '', '   ']) {
    const v = parseJudgeVerdict(JSON.stringify({
      category: 'cosmetic', severity: 'low', rationale: 'r', candidate_fact: cf,
    }));
    assert.strictEqual(v.candidate_fact, null, `candidate_fact ${JSON.stringify(cf)} should normalize to null`);
  }
});

test('parseJudgeVerdict: candidate_fact capped at 500 chars', () => {
  const v = parseJudgeVerdict(JSON.stringify({
    category: 'factual_correction', severity: 'low', rationale: 'r',
    candidate_fact: 'x'.repeat(900),
  }));
  assert.strictEqual(v.candidate_fact.length, 500);
});

test('normalizeFact: case/punctuation-insensitive', () => {
  assert.strictEqual(
    normalizeFact('All RUBIES tops have a built-in pouch!'),
    normalizeFact('all rubies tops have a built in pouch'),
  );
  assert.strictEqual(normalizeFact('  '), '');
});
