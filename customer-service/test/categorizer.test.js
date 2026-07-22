const { test } = require('node:test');
const assert = require('node:assert');
const { parseCategorizerResponse, CATEGORIES } = require('../import/categorizer');

test('parses clean JSON response', () => {
  const out = parseCategorizerResponse(JSON.stringify({
    category: 'exchange_return',
    subcategories: ['sizing_fit'],
    sentiment: 'negative',
    resolution_successful: true,
    resolution_type: 'refund',
    summary: 'Customer requested a refund for sizing issues.',
  }));
  assert.deepStrictEqual(out, {
    category: 'exchange_return',
    subcategories: ['sizing_fit'],
    sentiment: 'negative',
    resolution_successful: true,
    resolution_type: 'refund',
    summary: 'Customer requested a refund for sizing issues.',
  });
});

test('parses markdown-wrapped JSON', () => {
  const out = parseCategorizerResponse('```json\n{"category":"shipping","summary":"Tracking question."}\n```');
  assert.strictEqual(out.category, 'shipping');
  assert.strictEqual(out.summary, 'Tracking question.');
});

test('invalid enums fall back closed', () => {
  const out = parseCategorizerResponse(JSON.stringify({
    category: 'nonsense',
    subcategories: ['nonsense', 'payment'],
    sentiment: 'ecstatic',
    resolution_successful: 'yes',
    resolution_type: 'chargeback',
    summary: '   ',
  }));
  assert.strictEqual(out.category, 'general');
  assert.deepStrictEqual(out.subcategories, ['payment']);
  assert.strictEqual(out.sentiment, 'neutral');
  assert.strictEqual(out.resolution_successful, null);
  assert.strictEqual(out.resolution_type, 'other');
  assert.strictEqual(out.summary, null);
});

test('unparseable and non-object responses return null', () => {
  assert.strictEqual(parseCategorizerResponse('sorry, I cannot'), null);
  assert.strictEqual(parseCategorizerResponse(''), null);
  assert.strictEqual(parseCategorizerResponse(null), null);
  assert.strictEqual(parseCategorizerResponse('["a"]'), null);
});

test('category list matches the analyzer contract', () => {
  assert.ok(CATEGORIES.includes('exchange_return'));
  assert.ok(CATEGORIES.includes('general'));
});
