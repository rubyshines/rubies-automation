const test = require('node:test');
const assert = require('node:assert');

const { validateRecord, CATEGORIES } = require('../import/loadKbCandidates');

const goodCandidate = {
  slug: 'main',
  title: 'RUBIES Size Guide',
  category: 'sizing',
  content: 'To find your size, measure around the fullest part of your hips while standing.',
};

const goodExtracted = {
  source_id: 'page:size-guide',
  source_hash: 'abc123',
  decision: 'extracted',
  candidates: [goodCandidate],
};

test('accepts a valid extracted record (object and JSONL string)', () => {
  assert.strictEqual(validateRecord(goodExtracted).ok, true);
  assert.strictEqual(validateRecord(JSON.stringify(goodExtracted)).ok, true);
});

test('accepts a valid dropped record, requires a reason', () => {
  const dropped = { source_id: 'website:/pages/shop-adults', source_hash: 'h', decision: 'dropped', reason: 'listing page' };
  assert.strictEqual(validateRecord(dropped).ok, true);
  const noReason = { ...dropped, reason: undefined };
  assert.match(validateRecord(noReason).errors.join(';'), /without reason/);
});

test('rejects malformed JSON and non-objects', () => {
  assert.strictEqual(validateRecord('not json{').ok, false);
  assert.strictEqual(validateRecord(null).ok, false);
});

test('rejects missing source fields and bad decision', () => {
  assert.match(validateRecord({ decision: 'extracted', candidates: [goodCandidate] }).errors.join(';'), /source_id/);
  assert.match(validateRecord({ ...goodExtracted, decision: 'kept' }).errors.join(';'), /bad decision/);
});

test('dropped record must not carry candidates', () => {
  const rec = { source_id: 'x', source_hash: 'h', decision: 'dropped', reason: 'r', candidates: [goodCandidate] };
  assert.match(validateRecord(rec).errors.join(';'), /must not carry candidates/);
});

test('extracted record needs at least one candidate', () => {
  assert.match(validateRecord({ ...goodExtracted, candidates: [] }).errors.join(';'), /needs candidates/);
});

test('rejects bad slugs and duplicate slugs', () => {
  const badSlug = { ...goodExtracted, candidates: [{ ...goodCandidate, slug: 'Main Topic!' }] };
  assert.match(validateRecord(badSlug).errors.join(';'), /bad slug/);
  const dup = { ...goodExtracted, candidates: [goodCandidate, { ...goodCandidate, title: 'Other' }] };
  assert.match(validateRecord(dup).errors.join(';'), /duplicate slug/);
});

test('rejects unknown category', () => {
  const rec = { ...goodExtracted, candidates: [{ ...goodCandidate, category: 'random' }] };
  assert.match(validateRecord(rec).errors.join(';'), /bad category/);
  assert.ok(CATEGORIES.includes('sizing'));
});

test('enforces content length bounds', () => {
  const short = { ...goodExtracted, candidates: [{ ...goodCandidate, content: 'too short' }] };
  assert.match(validateRecord(short).errors.join(';'), /chars/);
  const long = { ...goodExtracted, candidates: [{ ...goodCandidate, content: 'x'.repeat(8001) }] };
  assert.match(validateRecord(long).errors.join(';'), /chars/);
});

test('collects multiple errors in one pass', () => {
  const rec = {
    source_id: 'x',
    source_hash: 'h',
    decision: 'extracted',
    candidates: [{ slug: 'ok-slug', title: '', category: 'nope', content: 'short' }],
  };
  const res = validateRecord(rec);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.length >= 3);
});
