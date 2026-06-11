const { test } = require('node:test');
const assert = require('node:assert');
const { buildBatchPrompt, parseBatchVerdicts } = require('../../b2b-discovery/prefilter');

const rows = [
  { id: 'a1', company_name: 'Hotel Flor Tampa', city: 'Tampa', state: 'FL', source: 'google-maps' },
  { id: 'b2', company_name: 'Honey Birdette', city: 'Tampa', state: 'FL', website_domain: 'honeybirdette.com' },
];

test('buildBatchPrompt emits one JSON line per business with id and name', () => {
  const prompt = buildBatchPrompt(rows);
  const lines = prompt.split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).id, 'a1');
  assert.match(lines[1], /Honey Birdette/);
});

test('parseBatchVerdicts maps verdicts by id', () => {
  const out = parseBatchVerdicts('[{"id":"a1","keep":false,"reason":"hotel"},{"id":"b2","keep":true,"reason":"lingerie retailer"}]', rows);
  assert.deepEqual(out.map(v => v.keep), [false, true]);
  assert.equal(out[0].reason, 'hotel');
});

test('rows missing from the model reply are KEPT (conservative default)', () => {
  const out = parseBatchVerdicts('[{"id":"a1","keep":false,"reason":"hotel"}]', rows);
  assert.equal(out[1].keep, true);
  assert.match(out[1].reason, /kept by default/);
});

test('garbage replies keep everything', () => {
  const out = parseBatchVerdicts('I cannot help with that.', rows);
  assert.deepEqual(out.map(v => v.keep), [true, true]);
});

test('fenced JSON is tolerated', () => {
  const out = parseBatchVerdicts('```json\n[{"id":"a1","keep":false,"reason":"hotel"},{"id":"b2","keep":true,"reason":"fit"}]\n```', rows);
  assert.equal(out[0].keep, false);
});
