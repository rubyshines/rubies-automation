const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parseVoiceRules } = require('../import/publishReviewSheets');

const SAMPLE = `# Voice Rules

Intro text.

## Apologies

### [ ] Rule 1: "No problem." opener when nothing went wrong
- **Rule:** Open by granting the request.
- **Evidence:** 122x in 2023-24.
- **Advisor today:** Diverges on the margin.
- **Proposed action:** add to prompt.

### [ ] Rule 2: Never apologize for carriers
- **Rule:** Explain the boundary, then remedy.
- **Proposed action:** needs Jamie's call.

## Exclamations & warmth

### [ ] Rule 3: Mirror the customer's energy
- **Rule:** Reciprocate excitement on relationship beats.
- **Evidence:** All eras.
- **Advisor today:** Metronomic.
- **Proposed action:** add to prompt.
`;

test('parseVoiceRules extracts rules with group, number, title, fields', () => {
  const rules = parseVoiceRules(SAMPLE);
  assert.strictEqual(rules.length, 3);
  assert.deepStrictEqual(rules.map(r => r.num), [1, 2, 3]);
  assert.strictEqual(rules[0].group, 'Apologies');
  assert.strictEqual(rules[2].group, 'Exclamations & warmth');
  assert.match(rules[0].title, /No problem/);
  assert.strictEqual(rules[0].rule, 'Open by granting the request.');
  assert.strictEqual(rules[0].advisor_today, 'Diverges on the margin.');
  assert.strictEqual(rules[0].action, 'add to prompt.');
  // missing optional fields stay empty, not undefined
  assert.strictEqual(rules[1].evidence, '');
});

test('parseVoiceRules handles checked boxes and parenthetical rule titles', () => {
  const rules = parseVoiceRules('## G\n\n### [x] Rule 7 (superseded pattern): historical thing\n- **Rule:** old.\n');
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].num, 7);
  assert.strictEqual(rules[0].title, 'historical thing');
});

test('parseVoiceRules parses the real committed sheet without loss', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '../drafter/voice-rules-2026-07-proposed.md'), 'utf8');
  const rules = parseVoiceRules(md);
  assert.strictEqual(rules.length, 20);
  assert.ok(rules.every(r => r.rule.length > 0), 'every rule has Rule text');
  assert.ok(rules.every(r => r.group.length > 0), 'every rule has a group');
});
