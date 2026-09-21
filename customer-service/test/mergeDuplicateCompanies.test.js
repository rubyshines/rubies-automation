const { test } = require('node:test');
const assert = require('node:assert');
const { planMerges, mergedInto } = require('../../b2b-outreach/sync/mergeDuplicateCompanies');

// Which row survives a duplicate pair is a human decision, recorded in the
// loser's triage_reason by the 2026-08-11 sweep. This pass carries that out and
// never re-derives it: picking a winner by row count or name similarity is how
// two unrelated orgs get fused.

test('reads the survivor a tombstone names, and nothing else', () => {
  assert.equal(mergedInto('merged into lgbtq-bagly-boston-alliance-of-lgbtq-youth 2026-08-11 (duplicate row, same domain bagly.org)'), 'lgbtq-bagly-boston-alliance-of-lgbtq-youth');
  assert.equal(mergedInto('merged into self-serve-toys'), 'self-serve-toys');
  assert.equal(mergedInto('bulk admission: donation_form cohort'), null);
  assert.equal(mergedInto('round 1 cold intro, vetted by Jamie 2026-09-09'), null);
  assert.equal(mergedInto(null), null);
  assert.equal(mergedInto(''), null);
  assert.equal(mergedInto('we merged into a bigger org'), null, 'must be the recorded prefix, not prose');
});

test('plans a merge only when the named survivor exists', () => {
  const companies = [
    { id: 'keep', name: 'Keep', triage_reason: 'bulk admission: donation_form cohort' },
    { id: 'dup', name: 'Dup', triage_reason: 'merged into keep 2026-08-11 (duplicate row)' },
    { id: 'dangling', name: 'Dangling', triage_reason: 'merged into gone-long-ago 2026-08-11' },
    { id: 'selfref', name: 'Self', triage_reason: 'merged into selfref 2026-08-11' },
    { id: 'plain', name: 'Plain', triage_reason: null },
  ];
  const { merges, problems } = planMerges(companies);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].dup.id, 'dup');
  assert.equal(merges[0].keep.id, 'keep');
  assert.deepEqual(problems.map(p => p.id).sort(), ['dangling', 'selfref']);
});

test('a survivor that is itself a tombstone still resolves to the row it names', () => {
  // Hugh Lane had two tombstones pointing at one survivor; neither may consume
  // the other, and both must land on the same live row.
  const companies = [
    { id: 'live', name: 'Hugh Lane Wellness Foundation', triage_reason: null },
    { id: 'dup-a', name: 'Hugh Lane', triage_reason: 'merged into live 2026-08-11' },
    { id: 'dup-b', name: 'Hugh Lane Wellness Foundation', triage_reason: 'merged into live 2026-08-11' },
  ];
  const { merges, problems } = planMerges(companies);
  assert.equal(problems.length, 0);
  assert.deepEqual(merges.map(m => m.keep.id), ['live', 'live']);
  assert.deepEqual(merges.map(m => m.dup.id).sort(), ['dup-a', 'dup-b']);
});

test('nothing is planned from an empty book', () => {
  assert.deepEqual(planMerges([]), { merges: [], problems: [] });
});
