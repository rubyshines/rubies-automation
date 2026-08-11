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

// --- styleSwitchNote (aiAdvisor) -------------------------------------------
// The style-switch note is how compare_products tells the advisor which styles
// are cut with a larger leg opening. It replaced a set of hand-written
// advisor_facts, one per product pair, which could never be complete.
const { styleSwitchNote } = require('../lib/aiAdvisor');

test('styleSwitchNote: returns the note for a target in its own category', () => {
  const config = { styleSwitch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening, recommend for tight legs' } };
  assert.strictEqual(styleSwitchNote(config, 'underwear_bottom'), 'Larger leg opening, recommend for tight legs');
});

test('styleSwitchNote: scoped out of categories it does not apply to', () => {
  // The Flo is a youth underwear answer; it must not surface as a swim option.
  const flo = { styleSwitch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening (youth sizes only)' } };
  assert.strictEqual(styleSwitchNote(flo, 'swim_bottom'), null);
});

test('styleSwitchNote: applies to every category when forCategories is absent', () => {
  const config = { styleSwitch: { isTarget: true, note: 'Larger leg opening' } };
  assert.strictEqual(styleSwitchNote(config, 'swim_bottom'), 'Larger leg opening');
});

test('styleSwitchNote: non-targets and missing config yield null, never undefined', () => {
  assert.strictEqual(styleSwitchNote({ styleSwitch: { isTarget: false, note: 'x' } }, 'underwear_bottom'), null);
  assert.strictEqual(styleSwitchNote({ styleSwitch: null }, 'underwear_bottom'), null);
  assert.strictEqual(styleSwitchNote({}, 'underwear_bottom'), null);
  assert.strictEqual(styleSwitchNote(null, 'underwear_bottom'), null);
});

test('styleSwitchNote: a target with no note text yields null rather than empty string', () => {
  assert.strictEqual(styleSwitchNote({ styleSwitch: { isTarget: true } }, 'underwear_bottom'), null);
});
