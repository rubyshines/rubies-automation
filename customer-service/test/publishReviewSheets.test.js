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

const os = require('node:os');
const { loadConflictTopics, loadUnpublished } = require('../import/publishReviewSheets');

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbmine-'));
  fs.mkdirSync(path.join(dir, 'verdicts'));
  fs.writeFileSync(path.join(dir, 'conflicts-full.json'), JSON.stringify([
    { fact: 'Refunds take 2-3 days.', date: '2026-01-06', seen: 2, conflict_with: 'newer says 5-10' },
    { fact: 'Refunds take 2-5 days.', date: '2026-04-26', seen: 1, conflict_with: 'same week said 5-10' },
    { fact: 'Uncovered odd conflict.', date: '2022-01-01', seen: 1, conflict_with: 'whatever' },
  ]));
  fs.writeFileSync(path.join(dir, 'conflict-topics.json'), JSON.stringify({
    topics: [{ title: 'Refund timing', idx: [0, 1], question: 'How long do refunds take?', my_read: 'Newest = 5-10.', ruling_prefill: 'yes?' }],
  }));
  fs.writeFileSync(path.join(dir, 'verdicts', 'policy.jsonl'), [
    JSON.stringify({ verdict: 'unpublished', fact: 'Exchanges are free.', category: 'policy', seen: 21, date: '2026-06-01' }),
    JSON.stringify({ verdict: 'unpublished', fact: 'Rare fact.', category: 'policy', seen: 1, date: '2026-05-01' }),
    JSON.stringify({ verdict: 'conflict', fact: 'Should not appear.', category: 'policy', seen: 9 }),
    JSON.stringify({ verdict: 'drop', fact: 'Nor this.', category: 'policy' }),
  ].join('\n'));
  return dir;
}

test('loadConflictTopics merges by topic and composes dated evidence', () => {
  const topics = loadConflictTopics(fixtureDir());
  const refund = topics.find(t => t.title === 'Refund timing');
  assert.ok(refund);
  assert.match(refund.evidence, /\[2026-01-06, 2x\] Refunds take 2-3 days\./);
  assert.match(refund.evidence, /\[2026-04-26\] Refunds take 2-5 days\./);
  assert.match(refund.evidence, /vs: newer says 5-10/);
  assert.strictEqual(refund.ruling_prefill, 'yes?');
});

test('loadConflictTopics gives uncovered conflicts their own safety row', () => {
  const topics = loadConflictTopics(fixtureDir());
  assert.strictEqual(topics.length, 2);
  const safety = topics.find(t => t.title.startsWith('Uncovered odd conflict'));
  assert.ok(safety, 'uncovered conflict got its own topic row');
});

test('loadUnpublished keeps only unpublished verdicts, buckets by seen', () => {
  const rows = loadUnpublished(fixtureDir());
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].fact, 'Exchanges are free.');
  assert.strictEqual(rows[0].bucket, 'high-signal');
  assert.strictEqual(rows[1].bucket, 'long-tail');
});
