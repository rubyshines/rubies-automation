/**
 * Unit tests for the auto-action governance feature:
 *   - autoactionGate.js: default-ON kill switch, never-list, source helpers
 *   - autoactionConfig.js: feed extraction, stats, config assembly, key validation
 *   - intake gating: a disabled flag skips auto-execution
 */
const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../lib/autoactionGate');
const cfg = require('../lib/autoactionConfig');

// ---- gate: source helpers (pure) ------------------------------------------

test('isAutoSource: only auto_* sources count as automatic', () => {
  assert.strictEqual(gate.isAutoSource('auto_hold'), true);
  assert.strictEqual(gate.isAutoSource('auto_address'), true);
  assert.strictEqual(gate.isAutoSource(undefined), false);
  assert.strictEqual(gate.isAutoSource('operator'), false);
});

test('kindForSource maps sources to toggle kinds', () => {
  assert.strictEqual(gate.kindForSource('auto_address'), 'address_change');
  assert.strictEqual(gate.kindForSource('auto_hold'), 'warehouse_hold');
  assert.strictEqual(gate.kindForSource('auto_hold_sweep'), 'warehouse_hold');
  assert.strictEqual(gate.kindForSource('auto_address_fallback'), 'warehouse_hold');
  assert.strictEqual(gate.kindForSource(undefined), null);
});

// ---- gate: isAutoactionEnabled (default-ON, never-list) --------------------

test('isAutoactionEnabled: operator-only kinds are always false', async () => {
  for (const kind of gate.NEVER_AUTO) {
    assert.strictEqual(await gate.isAutoactionEnabled(kind), false, `${kind} must never auto-execute`);
  }
  assert.strictEqual(await gate.isAutoactionEnabled('refund'), false);
});

test('isAutoactionEnabled: capable kinds default ON when no flag set', async () => {
  // Stub systemFlags so no flags exist (returns the provided default).
  const flagsPath = require.resolve('../../shared/systemFlags');
  const original = require.cache[flagsPath];
  require.cache[flagsPath] = {
    id: flagsPath, filename: flagsPath, loaded: true,
    exports: { isFlagEnabled: async (_key, def = false) => def, setFlag: async () => true },
  };
  // Re-require the gate so it binds the stubbed isFlagEnabled.
  const gatePath = require.resolve('../lib/autoactionGate');
  const origGate = require.cache[gatePath];
  delete require.cache[gatePath];
  const g = require('../lib/autoactionGate');
  try {
    assert.strictEqual(await g.isAutoactionEnabled('warehouse_hold'), true);
    assert.strictEqual(await g.isAutoactionEnabled('address_change'), true);
  } finally {
    if (original) require.cache[flagsPath] = original; else delete require.cache[flagsPath];
    if (origGate) require.cache[gatePath] = origGate; else delete require.cache[gatePath];
  }
});

test('isAutoactionEnabled: master OFF disables all capable kinds', async () => {
  const flagsPath = require.resolve('../../shared/systemFlags');
  const original = require.cache[flagsPath];
  require.cache[flagsPath] = {
    id: flagsPath, filename: flagsPath, loaded: true,
    exports: { isFlagEnabled: async (key, def = false) => (key === 'autoaction_enabled' ? false : def), setFlag: async () => true },
  };
  const gatePath = require.resolve('../lib/autoactionGate');
  const origGate = require.cache[gatePath];
  delete require.cache[gatePath];
  const g = require('../lib/autoactionGate');
  try {
    assert.strictEqual(await g.isAutoactionEnabled('warehouse_hold'), false);
    assert.strictEqual(await g.isAutoactionEnabled('address_change'), false);
  } finally {
    if (original) require.cache[flagsPath] = original; else delete require.cache[flagsPath];
    if (origGate) require.cache[gatePath] = origGate; else delete require.cache[gatePath];
  }
});

// ---- config: extraction + stats + assembly --------------------------------

const SAMPLE_DRAFTS = [
  { id: 3, ticket_id: 30, order_number: '#102', actions: [
    { executed_at: '2026-06-16T12:00:00Z', action_type: 'order_modification', summary: 'Shipping Address Updated\nfoo', links: [], source: 'auto_address' },
  ] },
  { id: 2, ticket_id: 20, order_number: '#101', actions: [
    { executed_at: '2026-06-16T11:00:00Z', action_type: 'warehouse_hold', summary: 'Hold placed', links: [], source: 'auto_address_fallback' },
  ] },
  { id: 1, ticket_id: 10, order_number: '#100', actions: [
    { executed_at: '2026-06-16T10:00:00Z', action_type: 'warehouse_hold', summary: 'Hold placed', links: [], source: 'auto_hold' },
    { executed_at: '2026-06-16T10:05:00Z', action_type: 'refund', summary: 'operator refund', links: [] }, // operator — excluded
  ] },
];

test('extractAutoActions: only auto-sourced entries, newest first', () => {
  const feed = cfg.extractAutoActions(SAMPLE_DRAFTS);
  assert.strictEqual(feed.length, 3, 'operator refund excluded');
  assert.strictEqual(feed[0].executed_at, '2026-06-16T12:00:00Z', 'sorted newest first');
  assert.strictEqual(feed[0].kind, 'address_change');
});

test('activityStats: counts per kind, fallback tallied separately', () => {
  const feed = cfg.extractAutoActions(SAMPLE_DRAFTS);
  const stats = cfg.activityStats(feed);
  assert.strictEqual(stats.address_change.executed, 1);
  assert.strictEqual(stats.warehouse_hold.executed, 2); // auto_hold + auto_address_fallback
  assert.strictEqual(stats.warehouse_hold.fallback, 1);
});

test('buildAutoactionConfig: capable kinds default ON, flag override, never-list shown', () => {
  const feed = cfg.extractAutoActions(SAMPLE_DRAFTS);
  const stats = cfg.activityStats(feed);
  const out = cfg.buildAutoactionConfig({
    masterEnabled: true,
    flagRows: [{ key: 'autoaction_address_change', enabled: false }],
    stats, feed,
  });
  assert.strictEqual(out.master_enabled, true);
  const hold = out.kinds.find(k => k.kind === 'warehouse_hold');
  const addr = out.kinds.find(k => k.kind === 'address_change');
  assert.strictEqual(hold.enabled, true, 'no flag → default ON');
  assert.strictEqual(addr.enabled, false, 'explicit flag false respected');
  assert.strictEqual(hold.executed, 2);
  assert.ok(out.kinds.find(k => k.kind === 'refund').never_listed, 'refund shown as never');
  assert.strictEqual(out.feed.length, 3);
});

test('validateAutoactionFlagKey: master + capable allowed, operator-only + junk rejected', () => {
  assert.strictEqual(cfg.validateAutoactionFlagKey('autoaction_enabled').ok, true);
  assert.strictEqual(cfg.validateAutoactionFlagKey('autoaction_warehouse_hold').ok, true);
  assert.strictEqual(cfg.validateAutoactionFlagKey('autoaction_address_change').ok, true);
  assert.strictEqual(cfg.validateAutoactionFlagKey('autoaction_refund').ok, false);
  assert.strictEqual(cfg.validateAutoactionFlagKey('autosend_shadow').ok, false);
  assert.strictEqual(cfg.validateAutoactionFlagKey('').ok, false);
});

// ---- intake gating: disabled flag skips auto-execution --------------------

test('autoExecuteAdvisorHold: skips placement when warehouse_hold auto-action is disabled', async () => {
  const intake = require('../intake/processGorgiasTickets');
  // Stub the gate so warehouse_hold is disabled, and the tool so we can detect calls.
  const gatePath = require.resolve('../lib/autoactionGate');
  const notesPath = require.resolve('../lib/tools/orderNotes');
  const origGate = require.cache[gatePath];
  const origNotes = require.cache[notesPath];
  let toolCalled = false;
  require.cache[gatePath] = {
    id: gatePath, filename: gatePath, loaded: true,
    exports: { ...gate, isAutoactionEnabled: async () => false },
  };
  require.cache[notesPath] = {
    id: notesPath, filename: notesPath, loaded: true,
    exports: { handleWarehouseHold: async () => { toolCalled = true; return { content: [{ text: 'x' }] }; } },
  };
  try {
    const s = { action_type: 'warehouse_hold', order: { name: '#500' }, intake: {}, audit: [] };
    const res = await intake.autoExecuteAdvisorHold(s);
    assert.strictEqual(res, null, 'returns null when disabled');
    assert.strictEqual(toolCalled, false, 'never calls the hold tool when disabled');
    assert.ok(s.audit.some(a => /disabled/.test(a)), 'records the skip in audit');
  } finally {
    if (origGate) require.cache[gatePath] = origGate; else delete require.cache[gatePath];
    if (origNotes) require.cache[notesPath] = origNotes; else delete require.cache[notesPath];
  }
});
