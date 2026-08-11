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

// --- tool_gap (closenessJudge) ---------------------------------------------
// The companion to the "no fact when a system of record owns it" rule: the
// judge names the tool that should have answered, so a correction becomes a
// data ticket instead of vanishing.

test('parseJudgeVerdict: extracts tool_gap alongside a nulled candidate_fact', () => {
  const v = parseJudgeVerdict(JSON.stringify({
    category: 'factual_correction',
    draft_may_be_right: false,
    severity: 'medium',
    rationale: 'Draft guessed which style is cut higher.',
    candidate_fact: null,
    tool_gap: 'compare_products returns no leg-opening comparison.',
  }));
  assert.strictEqual(v.candidate_fact, null);
  assert.strictEqual(v.tool_gap, 'compare_products returns no leg-opening comparison.');
});

test('parseJudgeVerdict: absent, null, blank and non-string tool_gap all become null', () => {
  const base = { category: 'cosmetic', severity: 'low', rationale: 'r' };
  for (const tool_gap of [undefined, null, '', '   ', 42, {}, []]) {
    const v = parseJudgeVerdict(JSON.stringify({ ...base, tool_gap }));
    assert.strictEqual(v.tool_gap, null, `expected null for ${JSON.stringify(tool_gap)}`);
  }
});

test('parseJudgeVerdict: tool_gap is trimmed and capped at 500 chars', () => {
  const v = parseJudgeVerdict(JSON.stringify({
    category: 'substantive', severity: 'low', rationale: 'r',
    tool_gap: '  ' + 'x'.repeat(600) + '  ',
  }));
  assert.strictEqual(v.tool_gap.length, 500);
  assert.strictEqual(v.tool_gap[0], 'x');
});

// --- tool_gap column tolerance (judgeDaily) ---------------------------------
// The column arrives via a hand-applied migration, so a runtime deployed ahead
// of it must degrade rather than fail every judge write.
const { isMissingToolGapColumn, insertJudgment } = require('../../lib/judgeDaily');

test('isMissingToolGapColumn: recognises the schema-cache and undefined-column errors', () => {
  assert.strictEqual(isMissingToolGapColumn({ code: 'PGRST204', message: '' }), true);
  assert.strictEqual(isMissingToolGapColumn({ code: '42703', message: '' }), true);
  assert.strictEqual(isMissingToolGapColumn({ code: 'XX', message: "column 'tool_gap' does not exist" }), true);
});

test('isMissingToolGapColumn: unrelated errors and no error pass through', () => {
  assert.strictEqual(isMissingToolGapColumn(null), false);
  assert.strictEqual(isMissingToolGapColumn(undefined), false);
  assert.strictEqual(isMissingToolGapColumn({ code: '23505', message: 'duplicate key' }), false);
});

test('insertJudgment: retries without tool_gap when the column is absent, keeping the verdict', async () => {
  const attempts = [];
  const sb = {
    from: () => ({
      insert: (payload) => {
        attempts.push(payload);
        return attempts.length === 1
          ? Promise.resolve({ error: { code: 'PGRST204', message: "tool_gap not found" } })
          : Promise.resolve({ error: null });
      },
    }),
  };
  const base = { draft_id: 1, category: 'substantive' };
  const res = await insertJudgment(sb, base, 'compare_products has no leg-opening data');

  assert.strictEqual(res.error, null, 'verdict must still be stored');
  assert.strictEqual(attempts.length, 2, 'should retry exactly once');
  assert.strictEqual(attempts[0].tool_gap, 'compare_products has no leg-opening data');
  assert.ok(!('tool_gap' in attempts[1]), 'retry must drop the missing column');
  assert.strictEqual(attempts[1].category, 'substantive', 'retry keeps the rest of the verdict');
});

test('insertJudgment: once the column is known absent, later writes skip it entirely', async () => {
  // Runs after the test above, which latched the flag — one probe per process.
  const attempts = [];
  const sb = { from: () => ({ insert: (p) => { attempts.push(p); return Promise.resolve({ error: null }); } }) };
  await insertJudgment(sb, { draft_id: 2 }, 'another gap');
  assert.strictEqual(attempts.length, 1, 'no wasted round-trip');
  assert.ok(!('tool_gap' in attempts[0]));
});
