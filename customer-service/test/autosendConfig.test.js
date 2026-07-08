const { test } = require('node:test');
const assert = require('node:assert');
const {
  categoryUnion,
  judgmentStats,
  buildAutosendConfig,
  validateAutosendFlagKey,
} = require('../lib/autosendConfig');
const { NEVER_TYPES } = require('../lib/autosendGate');
const { CANONICAL_MESSAGE_TYPES } = require('../lib/messageTypes');

// ---------------------------------------------------------------------------
// categoryUnion
// ---------------------------------------------------------------------------

test('categoryUnion includes all canonical types and the never-list', () => {
  const union = new Set(categoryUnion());
  for (const t of CANONICAL_MESSAGE_TYPES) assert.ok(union.has(t), t);
  for (const t of NEVER_TYPES) assert.ok(union.has(t), t);
});

test('categoryUnion includes flag-only categories and ignores non-category keys', () => {
  const union = categoryUnion(['autosend_shadow', 'autosend_cat_legacy_type', 'some_other_flag']);
  assert.ok(union.includes('legacy_type'));
  assert.ok(!union.includes('shadow')); // master flag is not a category
  assert.ok(!union.some(t => t.includes('some_other')));
});

test('categoryUnion sorts toggleable categories first, never-list last', () => {
  const union = categoryUnion();
  const firstNever = union.findIndex(t => NEVER_TYPES.has(t));
  assert.ok(firstNever > 0);
  for (const t of union.slice(firstNever)) assert.ok(NEVER_TYPES.has(t), t);
  // alphabetical within each group
  const toggleable = union.slice(0, firstNever);
  assert.deepEqual(toggleable, [...toggleable].sort());
});

test('categoryUnion has no duplicates', () => {
  const union = categoryUnion(['autosend_cat_closing']); // already canonical
  assert.equal(new Set(union).size, union.length);
});

// ---------------------------------------------------------------------------
// judgmentStats
// ---------------------------------------------------------------------------

test('judgmentStats counts judged and clean (identical + cosmetic) per type', () => {
  const stats = judgmentStats([
    { message_type: 'closing', category: 'identical' },
    { message_type: 'closing', category: 'cosmetic' },
    { message_type: 'closing', category: 'substantive' },
    { message_type: 'shipping', category: 'factual_correction' },
    { message_type: null, category: 'identical' },
  ]);
  assert.deepEqual(stats.closing, { judged: 3, clean: 2 });
  assert.deepEqual(stats.shipping, { judged: 1, clean: 0 });
  assert.deepEqual(stats.unknown, { judged: 1, clean: 1 }); // null type buckets as unknown
});

test('judgmentStats handles empty input', () => {
  assert.deepEqual(judgmentStats([]), {});
  assert.deepEqual(judgmentStats(), {});
});

// ---------------------------------------------------------------------------
// buildAutosendConfig
// ---------------------------------------------------------------------------

test('buildAutosendConfig assembles the GET response shape', () => {
  const cfg = buildAutosendConfig({
    shadowEnabled: true,
    flagRows: [
      { key: 'autosend_shadow', enabled: true },
      { key: 'autosend_cat_closing', enabled: true },
      { key: 'autosend_cat_shipping', enabled: false },
    ],
    judgmentRows: [
      { message_type: 'closing', category: 'identical' },
      { message_type: 'closing', category: 'cosmetic' },
      { message_type: 'closing', category: 'substantive' },
    ],
  });

  assert.equal(cfg.shadow_enabled, true);
  const closing = cfg.categories.find(c => c.message_type === 'closing');
  assert.deepEqual(closing, {
    message_type: 'closing', enabled: true, never_listed: false, judged: 3, clean_pct: 67,
  });
  const shipping = cfg.categories.find(c => c.message_type === 'shipping');
  assert.equal(shipping.enabled, false);
  assert.equal(shipping.judged, 0);
  assert.equal(shipping.clean_pct, null); // no judgments → no percentage
});

test('buildAutosendConfig never reports a never-listed category as enabled', () => {
  const cfg = buildAutosendConfig({
    shadowEnabled: false,
    // simulate someone flipping a never-list flag directly in the DB
    flagRows: [{ key: 'autosend_cat_refund', enabled: true }],
    judgmentRows: [],
  });
  const refund = cfg.categories.find(c => c.message_type === 'refund');
  assert.equal(refund.never_listed, true);
  assert.equal(refund.enabled, false);
});

test('buildAutosendConfig with no inputs returns full disabled taxonomy', () => {
  const cfg = buildAutosendConfig();
  assert.equal(cfg.shadow_enabled, false);
  assert.ok(cfg.categories.length >= CANONICAL_MESSAGE_TYPES.size);
  assert.ok(cfg.categories.every(c => c.enabled === false));
});

// ---------------------------------------------------------------------------
// validateAutosendFlagKey
// ---------------------------------------------------------------------------

test('validateAutosendFlagKey accepts the master flag and clean categories', () => {
  assert.equal(validateAutosendFlagKey('autosend_shadow').ok, true);
  assert.equal(validateAutosendFlagKey('autosend_cat_closing').ok, true);
  assert.equal(validateAutosendFlagKey('autosend_cat_sizing_inquiry').ok, true);
});

test('validateAutosendFlagKey rejects never-listed categories', () => {
  for (const t of NEVER_TYPES) {
    const v = validateAutosendFlagKey(`autosend_cat_${t}`);
    assert.equal(v.ok, false, t);
    assert.match(v.error, /never-list/);
  }
});

test('validateAutosendFlagKey rejects arbitrary flags and malformed keys', () => {
  assert.equal(validateAutosendFlagKey('cs_intake_enabled').ok, false);
  assert.equal(validateAutosendFlagKey('autosend_cat_').ok, false);
  assert.equal(validateAutosendFlagKey('').ok, false);
  assert.equal(validateAutosendFlagKey(null).ok, false);
  assert.equal(validateAutosendFlagKey(42).ok, false);
});

// Pagination behavior (formerly a local fetchAll here) is covered by
// supabaseHelpers.test.js — autosendConfig now uses the shared fetchAllPaginated.
