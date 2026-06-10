const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeVerdicts } = require('../../lib/judgeDaily');

test('summarizeVerdicts computes divergence rate from the three divergent categories', () => {
  const rows = [
    { category: 'identical' }, { category: 'identical' },
    { category: 'cosmetic' },
    { category: 'substantive' },
    { category: 'factual_correction' },
    { category: 'action_divergence' },
  ];
  const s = summarizeVerdicts(rows);
  assert.equal(s.judged, 6);
  assert.equal(s.counts.identical, 2);
  assert.equal(s.divergence_rate_pct, 50);
});

test('summarizeVerdicts handles empty input', () => {
  const s = summarizeVerdicts([]);
  assert.equal(s.judged, 0);
  assert.equal(s.divergence_rate_pct, null);
});
