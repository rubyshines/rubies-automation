const { test } = require('node:test');
const assert = require('node:assert');
const { findNewModels, diffPricing } = require('../../scripts/check-ai-pricing');

const KNOWN = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

test('findNewModels flags Opus/Sonnet/Haiku ids not in pricing', () => {
  const ids = ['claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-5'];
  assert.deepEqual(findNewModels(ids, KNOWN).sort(), ['claude-haiku-5', 'claude-opus-4-7']);
});

test('findNewModels ignores non-family ids and known ids', () => {
  const ids = ['claude-opus-4-6', 'voyage-3', 'text-embedding-3', 'gpt-4o'];
  assert.deepEqual(findNewModels(ids, KNOWN), []);
});

test('findNewModels handles empty/missing input', () => {
  assert.deepEqual(findNewModels(null, KNOWN), []);
  assert.deepEqual(findNewModels([], KNOWN), []);
});

test('diffPricing detects an input/output rate change on a known model', () => {
  const extracted = { 'claude-opus-4-6': { input: 20, output: 75 } };
  const changes = diffPricing(extracted, KNOWN);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { model: 'claude-opus-4-6', field: 'input', ours: 15, theirs: 20 });
});

test('diffPricing ignores unknown models (handled by findNewModels) and unchanged rates', () => {
  const extracted = {
    'claude-opus-4-6': { input: 15, output: 75 },   // unchanged
    'claude-future-9': { input: 99, output: 99 },   // unknown
  };
  assert.deepEqual(diffPricing(extracted, KNOWN), []);
});

test('diffPricing handles empty input', () => {
  assert.deepEqual(diffPricing({}, KNOWN), []);
  assert.deepEqual(diffPricing(null, KNOWN), []);
});
