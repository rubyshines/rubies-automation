/**
 * Unit tests for the intake auto-apply of address changes + the protective-hold
 * fallback (processGorgiasTickets.autoExecuteAddressChange) and a regression
 * test locking the warehouse-hold / edit-order handler exports.
 *
 * Context: `handleWarehouseHold` was never exported from orderNotes.js, so the
 * intake auto-hold AND the backstop sweep both destructured `undefined` and
 * every automatic hold threw — holds only landed when an operator placed them by
 * hand. These tests guard that wiring and the new address-change gate.
 *
 * Stubs the lazily-required deps (addressValidation, editOrder, orderNotes) via
 * require.cache, the pattern documented in feedback_technical_rules.md.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const intake = require('../intake/processGorgiasTickets');
const { autoExecuteAddressChange, autoExecuteAdvisorHold } = intake;

function stub(relPath, exportsObj) {
  const p = require.resolve(relPath);
  const original = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => {
    if (original) require.cache[p] = original;
    else delete require.cache[p];
  };
}

function baseStructured(overrides = {}) {
  return {
    action_type: 'order_modification',
    order: { name: '#31618' },
    customer: { country: 'US', address: { country: 'US' } },
    prescription: { shipping_address: { address1: '123 Main St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' }, flags: [] },
    audit: [],
    ...overrides,
  };
}

// ---- export regression (the latent bug) -----------------------------------

test('orderNotes exports handleWarehouseHold as a function', () => {
  const orderNotes = require('../lib/tools/orderNotes');
  assert.strictEqual(typeof orderNotes.handleWarehouseHold, 'function');
  assert.ok(Array.isArray(orderNotes), 'tool array export preserved');
  assert.ok(orderNotes.length > 0);
});

test('editOrder exports handleEditOrder as a function', () => {
  const editOrder = require('../lib/tools/editOrder');
  assert.strictEqual(typeof editOrder.handleEditOrder, 'function');
  assert.ok(Array.isArray(editOrder));
});

test('autoExecuteAdvisorHold actually invokes handleWarehouseHold and files the action', async () => {
  let called = null;
  const restore = stub('../lib/tools/orderNotes', {
    handleWarehouseHold: async (args) => { called = args; return { content: [{ type: 'text', text: 'Hold placed on #31618' }] }; },
  });
  try {
    const action = await autoExecuteAdvisorHold({ action_type: 'warehouse_hold', order: { name: '#31618' }, intake: {} });
    assert.ok(action, 'returns an action entry (would be null if the export were missing)');
    assert.strictEqual(action.action_type, 'warehouse_hold');
    assert.match(action.summary, /Hold placed/);
    assert.strictEqual(called.order_number, 31618);
  } finally {
    restore();
  }
});

// ---- address auto-apply gate ----------------------------------------------

test('skips non-order_modification action types', async () => {
  const res = await autoExecuteAddressChange({ action_type: 'warehouse_hold', prescription: { shipping_address: { address1: 'x' } } });
  assert.strictEqual(res, null);
});

test('skips order_modification with no address (item swap)', async () => {
  const res = await autoExecuteAddressChange({ action_type: 'order_modification', prescription: { items: [] } });
  assert.strictEqual(res, null);
});

test('same-country + valid → applies via edit_order, no fallback, no flag', async () => {
  let edited = null;
  let held = false;
  const r1 = stub('../lib/addressValidation', { validateShippingAddress: async () => ({ ok: true, country_code: 'US', reason: 'ok' }) });
  const r2 = stub('../lib/tools/editOrder', { handleEditOrder: async (args) => { edited = args; return { content: [{ type: 'text', text: 'Shipping Address Updated' }] }; } });
  const r3 = stub('../lib/tools/orderNotes', { handleWarehouseHold: async () => { held = true; return { content: [{ text: 'hold' }] }; } });
  const s = baseStructured();
  try {
    const action = await autoExecuteAddressChange(s);
    assert.ok(action);
    assert.strictEqual(action.action_type, 'order_modification');
    assert.strictEqual(edited.order_number, 31618);
    assert.strictEqual(held, false, 'no hold placed on the happy path');
    assert.strictEqual(s.action_type, 'order_modification', 'action_type unchanged');
    assert.strictEqual(s.prescription.flags.length, 0, 'no flag on success');
  } finally { r1(); r2(); r3(); }
});

test('cross-border → does NOT edit, places protective hold, flips action_type, flags', async () => {
  let edited = false;
  let heldArgs = null;
  const r1 = stub('../lib/addressValidation', { validateShippingAddress: async () => ({ ok: true, country_code: 'DE', reason: 'ok' }) });
  const r2 = stub('../lib/tools/editOrder', { handleEditOrder: async () => { edited = true; return { content: [{ text: 'edited' }] }; } });
  const r3 = stub('../lib/tools/orderNotes', { handleWarehouseHold: async (a) => { heldArgs = a; return { content: [{ type: 'text', text: 'Hold placed' }] }; } });
  const s = baseStructured({ customer: { country: 'US', address: { country: 'US' } } });
  try {
    const action = await autoExecuteAddressChange(s);
    assert.strictEqual(edited, false, 'cross-border must not auto-edit');
    assert.ok(action);
    assert.strictEqual(action.action_type, 'warehouse_hold');
    assert.strictEqual(heldArgs.order_number, 31618);
    assert.strictEqual(s.action_type, 'warehouse_hold', 'flipped so the backstop sweep covers it');
    assert.strictEqual(s.prescription.flags.length, 1);
    assert.match(s.prescription.flags[0], /Cross-border/);
  } finally { r1(); r2(); r3(); }
});

test('validation fail → protective hold + flag', async () => {
  let edited = false;
  const r1 = stub('../lib/addressValidation', { validateShippingAddress: async () => ({ ok: false, country_code: 'US', reason: 'address did not resolve' }) });
  const r2 = stub('../lib/tools/editOrder', { handleEditOrder: async () => { edited = true; return { content: [{ text: 'edited' }] }; } });
  const r3 = stub('../lib/tools/orderNotes', { handleWarehouseHold: async () => ({ content: [{ type: 'text', text: 'Hold placed' }] }) });
  const s = baseStructured();
  try {
    const action = await autoExecuteAddressChange(s);
    assert.strictEqual(edited, false, 'unverified address must not auto-edit');
    assert.strictEqual(action.action_type, 'warehouse_hold');
    assert.strictEqual(s.action_type, 'warehouse_hold');
    assert.match(s.prescription.flags[0], /could not be auto-applied/);
  } finally { r1(); r2(); r3(); }
});

test('edit_order error → protective hold + flag', async () => {
  const r1 = stub('../lib/addressValidation', { validateShippingAddress: async () => ({ ok: true, country_code: 'US', reason: 'ok' }) });
  const r2 = stub('../lib/tools/editOrder', { handleEditOrder: async () => ({ isError: true, content: [{ type: 'text', text: 'Error: order locked' }] }) });
  const r3 = stub('../lib/tools/orderNotes', { handleWarehouseHold: async () => ({ content: [{ type: 'text', text: 'Hold placed' }] }) });
  const s = baseStructured();
  try {
    const action = await autoExecuteAddressChange(s);
    assert.strictEqual(action.action_type, 'warehouse_hold');
    assert.strictEqual(s.action_type, 'warehouse_hold');
    assert.match(s.prescription.flags[0], /Auto address update failed/);
  } finally { r1(); r2(); r3(); }
});

test('fallback hold that also fails → returns null but action_type stays flipped (sweep retries)', async () => {
  const r1 = stub('../lib/addressValidation', { validateShippingAddress: async () => ({ ok: false, country_code: 'US', reason: 'nope' }) });
  const r2 = stub('../lib/tools/editOrder', { handleEditOrder: async () => ({ content: [{ text: 'x' }] }) });
  const r3 = stub('../lib/tools/orderNotes', { handleWarehouseHold: async () => ({ isError: true, content: [{ type: 'text', text: 'Error: not found' }] }) });
  const s = baseStructured();
  try {
    const action = await autoExecuteAddressChange(s);
    assert.strictEqual(action, null, 'sync hold failed → null so initialActions stays empty');
    assert.strictEqual(s.action_type, 'warehouse_hold', 'still flipped so reconcile sweep picks it up');
    assert.strictEqual(s.prescription.flags.length, 1, 'flag persists even when the sync hold fails');
  } finally { r1(); r2(); r3(); }
});
