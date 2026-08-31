/**
 * Tests for the email-change plan/execute pair (lib/emailChange.js) and the
 * two-phase update_customer tool built on it.
 *
 * All external clients (Shopify, Klaviyo, Gorgias, Supabase) are stubbed via
 * require.cache — same pattern as resolveLineItems.test.js.
 *
 * Run: node --test customer-service/test/emailChange.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub state (reset per test)
// ---------------------------------------------------------------------------
const state = {
  shopify: {
    profiles: {},          // id → customer profile
    searchResults: [],     // searchCustomers results
    mergeable: {},         // id → mergeable object
    mergeCalls: [],
    updateCalls: [],
    updateThrows: null,
    mergeThrows: null,
    pollResult: true,
    pollCalls: [],
  },
  klaviyo: {
    enabled: true,
    profilesByEmail: {},   // email → profile object
    patchCalls: [],
    patchResult: { ok: true },
    patchThrows: null,
    mergeCalls: [],
    subscribeCalls: [],
  },
  gorgias: {
    customersByEmail: {},  // email → { id }
    updateCalls: [],
  },
  supabase: {
    customersByEmail: {},  // email → row (for the mirror select)
    openTickets: [],
    calls: [],
  },
  supaSearch: [],          // searchCustomersFromSupabase results
};

function resetState() {
  state.shopify = { profiles: {}, searchResults: [], mergeable: {}, mergeCalls: [], updateCalls: [], updateThrows: null, mergeThrows: null, pollResult: true, pollCalls: [] };
  state.klaviyo = { enabled: true, profilesByEmail: {}, patchCalls: [], patchResult: { ok: true }, patchThrows: null, mergeCalls: [], subscribeCalls: [] };
  state.gorgias = { customersByEmail: {}, updateCalls: [] };
  state.supabase = { customersByEmail: {}, openTickets: [], calls: [] };
  state.supaSearch = [];
}

// ---------------------------------------------------------------------------
// Stub modules (installed before requiring the code under test)
// ---------------------------------------------------------------------------
const shopifyPath = require.resolve('../lib/shopify');
const supaQueriesPath = require.resolve('../lib/supabaseQueries');
const supaClientPath = require.resolve('../../shared/supabaseClient');
const klaviyoPath = require.resolve('../../shared/klaviyoClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    searchCustomers: async () => state.shopify.searchResults,
    getCustomerProfile: async (id) => state.shopify.profiles[id] || null,
    updateCustomer: async (id, input) => {
      state.shopify.updateCalls.push({ id, input });
      if (state.shopify.updateThrows) throw state.shopify.updateThrows;
      return { id, ...input };
    },
    getCustomerMergeable: async (id) => state.shopify.mergeable[id] || { isMergeable: true, reason: null, errorFields: [] },
    customerMerge: async (one, two, overrideFields) => {
      state.shopify.mergeCalls.push({ one, two, overrideFields });
      if (state.shopify.mergeThrows) throw state.shopify.mergeThrows;
      return { jobId: 'gid://shopify/Job/1', done: false, resultingCustomerId: two };
    },
    pollShopifyJob: async (jobId) => {
      state.shopify.pollCalls.push(jobId);
      return state.shopify.pollResult;
    },
  },
};

require.cache[supaQueriesPath] = {
  id: supaQueriesPath, filename: supaQueriesPath, loaded: true,
  exports: { searchCustomersFromSupabase: async () => state.supaSearch },
};

function fakeSupabaseBuilder(table) {
  const op = { table, action: null, filters: {}, payload: null };
  function exec() {
    state.supabase.calls.push(op);
    if (op.table === 'customers' && op.action === 'select') {
      const row = state.supabase.customersByEmail[op.filters.email] || null;
      return Promise.resolve({ data: op.single ? row : (row ? [row] : []), error: null });
    }
    if (op.table === 'cs_tickets' && op.action === 'update') {
      return Promise.resolve({ data: state.supabase.openTickets, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
  const b = {
    select(cols) { op.action = op.action || 'select'; return b; },
    eq(col, val) { op.filters[col] = val; return b; },
    neq(col, val) { op.filters[`neq:${col}`] = val; return b; },
    update(payload) { op.action = 'update'; op.payload = payload; return b; },
    delete() { op.action = 'delete'; return b; },
    maybeSingle() { op.single = true; return exec(); },
    then(res, rej) { return exec().then(res, rej); },
  };
  return b;
}

require.cache[supaClientPath] = {
  id: supaClientPath, filename: supaClientPath, loaded: true,
  exports: { getSupabaseClient: () => ({ from: fakeSupabaseBuilder }) },
};

require.cache[klaviyoPath] = {
  id: klaviyoPath, filename: klaviyoPath, loaded: true,
  exports: {
    getKlaviyoClient: () => state.klaviyo.enabled ? {
      getProfileByEmail: async (email) => state.klaviyo.profilesByEmail[email] || null,
      updateProfileEmail: async (profileId, email) => {
        state.klaviyo.patchCalls.push({ profileId, email });
        if (state.klaviyo.patchThrows) throw state.klaviyo.patchThrows;
        return state.klaviyo.patchResult;
      },
      mergeProfiles: async (destinationId, sourceId) => {
        state.klaviyo.mergeCalls.push({ destinationId, sourceId });
        return { ok: true, destinationProfileId: destinationId };
      },
      // Consent is never granted by this feature — fail loudly if anything tries.
      updateSubscription: async (...args) => {
        state.klaviyo.subscribeCalls.push(args);
        throw new Error('updateSubscription must never be called by the email-change flow');
      },
    } : null,
  },
};

require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true,
  exports: {
    findCustomerByEmail: async (email) => state.gorgias.customersByEmail[email] || null,
    updateCustomerEmail: async (customerId, email) => {
      state.gorgias.updateCalls.push({ customerId, email });
      return { id: customerId, email };
    },
  },
};

const { planEmailChange, executeEmailChange } = require('../lib/emailChange');
const tools = require('../lib/tools/updateCustomer');
const updateTool = tools.find(t => t.name === 'update_customer');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OLD_ID = 'gid://shopify/Customer/111';
const NEW_ID = 'gid://shopify/Customer/222';
const OLD_EMAIL = 'old@example.com';
const NEW_EMAIL = 'nora@example.com';

function seedOldCustomer() {
  state.supaSearch = [{ id: OLD_ID, email: OLD_EMAIL }];
  state.shopify.profiles[OLD_ID] = {
    id: OLD_ID, email: OLD_EMAIL, firstName: 'Ethan', lastName: 'K',
    numberOfOrders: 2, amountSpent: { amount: '80.00', currencyCode: 'USD' },
  };
}

function seedShopifyConflict() {
  state.shopify.searchResults = [{
    id: NEW_ID, email: NEW_EMAIL, firstName: 'Nora', lastName: 'S',
    numberOfOrders: 1, amountSpent: { amount: '40.00', currencyCode: 'USD' },
  }];
}

function klaviyoProfile(id, consent) {
  return { id, attributes: { subscriptions: { email: { marketing: { consent } } } } };
}

beforeEach(resetState);

// ---------------------------------------------------------------------------
// planEmailChange
// ---------------------------------------------------------------------------
describe('planEmailChange', () => {
  it('simple mode when the new email is free — preview awaits confirmation, AUTO_CONFIRM SAFE', async () => {
    seedOldCustomer();
    const { plan, preview } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan.mode, 'simple');
    assert.match(preview, /awaiting confirmation/);
    assert.match(preview, /AUTO_CONFIRM: SAFE/);
  });

  it('merge mode when the new email is another Shopify customer — both names shown, HOLD verdict', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    const { plan, preview } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan.mode, 'merge');
    assert.match(preview, /Nora S/);
    assert.match(preview, /Ethan K/);
    assert.match(preview, /merged/i);
    assert.match(preview, /awaiting confirmation/);
    assert.match(preview, /AUTO_CONFIRM: HOLD/);
  });

  it('blocked mode when a side is non-mergeable — reason rendered, no confirmation offered', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    state.shopify.mergeable[NEW_ID] = { isMergeable: false, reason: 'Customer has store credit', errorFields: ['STORE_CREDIT'] };
    const { plan, preview } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan.mode, 'blocked');
    assert.match(plan.blocked_reason, /store credit/i);
    assert.match(preview, /STORE_CREDIT/);
    assert.doesNotMatch(preview, /awaiting confirmation/);
    assert.doesNotMatch(preview, /AUTO_CONFIRM/);
  });

  it('warns when the old address was subscribed and the merge survivor is not', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.klaviyo.profilesByEmail[NEW_EMAIL] = klaviyoProfile('kp_new', 'NEVER_SUBSCRIBED');
    const { plan, preview } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan.klaviyo.plan, 'merge');
    assert.equal(plan.klaviyo.consent_warning, true);
    assert.match(preview, /NOT on the newsletter/);
    assert.match(preview, /AUTO_CONFIRM: HOLD/);
  });

  it('flags Gorgias re-routing only when the customer exists there under the old address alone', async () => {
    seedOldCustomer();
    state.gorgias.customersByEmail[OLD_EMAIL] = { id: 9001 };
    const { plan } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan.gorgias.update_needed, true);

    resetState();
    seedOldCustomer();
    state.gorgias.customersByEmail[OLD_EMAIL] = { id: 9001 };
    state.gorgias.customersByEmail[NEW_EMAIL] = { id: 9002 };
    const { plan: plan2 } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL });
    assert.equal(plan2.gorgias.update_needed, false);
    assert.match(plan2.gorgias.note, /Both addresses/);
  });

  it('rejects an invalid or unchanged email', async () => {
    seedOldCustomer();
    await assert.rejects(() => planEmailChange({ customer_email: OLD_EMAIL, new_email: 'not-an-email' }), /not a valid email/);
    await assert.rejects(() => planEmailChange({ customer_email: OLD_EMAIL, new_email: OLD_EMAIL.toUpperCase() }), /already/);
  });
});

// ---------------------------------------------------------------------------
// executeEmailChange
// ---------------------------------------------------------------------------
describe('executeEmailChange', () => {
  async function planFor(overrides = {}) {
    const { plan } = await planEmailChange({ customer_email: OLD_EMAIL, new_email: NEW_EMAIL, ...overrides });
    return plan;
  }

  it('simple: updates Shopify, patches Klaviyo, updates Gorgias and the mirror', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.gorgias.customersByEmail[OLD_EMAIL] = { id: 9001 };
    state.supabase.openTickets = [{ id: 3405 }];
    const plan = await planFor();

    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    assert.deepEqual(state.shopify.updateCalls[0], { id: OLD_ID, input: { email: NEW_EMAIL } });
    assert.deepEqual(state.klaviyo.patchCalls[0], { profileId: 'kp_old', email: NEW_EMAIL });
    assert.deepEqual(state.gorgias.updateCalls[0], { customerId: 9001, email: NEW_EMAIL });
    const mirrorUpdate = state.supabase.calls.find(c => c.table === 'customers' && c.action === 'update');
    assert.equal(mirrorUpdate.payload.email, NEW_EMAIL);
    const ticketMove = state.supabase.calls.find(c => c.table === 'cs_tickets' && c.action === 'update');
    assert.equal(ticketMove.payload.customer_email, NEW_EMAIL);
    assert.equal(ticketMove.filters['neq:status'], 'closed');
    assert.ok(result.steps.every(s => s.ok));
  });

  it('merge: overrideFields keep the new-email profile for email AND name by default', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    const merge = state.shopify.mergeCalls[0];
    assert.deepEqual(merge.overrideFields, {
      customerIdOfEmailToKeep: NEW_ID,
      customerIdOfFirstNameToKeep: NEW_ID,
      customerIdOfLastNameToKeep: NEW_ID,
    });
    assert.equal(state.shopify.pollCalls.length, 1);
  });

  it('merge with keep_name original flips the surviving name to the old profile', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    const plan = await planFor();
    await executeEmailChange(plan, { keep_name: 'original' });
    const merge = state.shopify.mergeCalls[0];
    assert.equal(merge.overrideFields.customerIdOfEmailToKeep, NEW_ID);
    assert.equal(merge.overrideFields.customerIdOfFirstNameToKeep, OLD_ID);
    assert.equal(merge.overrideFields.customerIdOfLastNameToKeep, OLD_ID);
  });

  it('merge: Klaviyo profiles merge into the new-email destination; mirror deletes the old row', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.klaviyo.profilesByEmail[NEW_EMAIL] = klaviyoProfile('kp_new', 'SUBSCRIBED');
    state.supabase.customersByEmail[NEW_EMAIL] = { email: NEW_EMAIL };
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    assert.deepEqual(state.klaviyo.mergeCalls[0], { destinationId: 'kp_new', sourceId: 'kp_old' });
    const del = state.supabase.calls.find(c => c.table === 'customers' && c.action === 'delete');
    assert.equal(del.filters.email, OLD_EMAIL);
  });

  it('Klaviyo duplicate on patch falls back to merging into the duplicate', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.klaviyo.patchResult = { ok: false, duplicate_profile_id: 'kp_raced' };
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    assert.deepEqual(state.klaviyo.mergeCalls[0], { destinationId: 'kp_raced', sourceId: 'kp_old' });
  });

  it('no Klaviyo profile → skipped, still ok', async () => {
    seedOldCustomer();
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    assert.equal(state.klaviyo.patchCalls.length, 0);
    assert.equal(state.klaviyo.mergeCalls.length, 0);
    const kStep = result.steps.find(s => s.step === 'klaviyo');
    assert.match(kStep.detail, /nothing to move/i);
  });

  it('Shopify failure aborts everything downstream', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.gorgias.customersByEmail[OLD_EMAIL] = { id: 9001 };
    state.shopify.updateThrows = new Error('Shopify user errors: boom');
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Nothing else was attempted/);
    assert.equal(state.klaviyo.patchCalls.length, 0);
    assert.equal(state.gorgias.updateCalls.length, 0);
    assert.equal(state.supabase.calls.filter(c => c.action === 'update' || c.action === 'delete').length, 0);
  });

  it('Klaviyo failure does not stop Gorgias or the mirror', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.klaviyo.patchThrows = new Error('Klaviyo 500: down');
    state.gorgias.customersByEmail[OLD_EMAIL] = { id: 9001 };
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    const kStep = result.steps.find(s => s.step === 'klaviyo');
    assert.equal(kStep.ok, false);
    assert.equal(state.gorgias.updateCalls.length, 1);
    assert.ok(state.supabase.calls.some(c => c.table === 'customers' && c.action === 'update'));
    assert.match(result.summary, /follow-up step\(s\) failed/);
  });

  it('never calls any subscription mutation, even on consent asymmetry', async () => {
    seedOldCustomer();
    state.klaviyo.profilesByEmail[OLD_EMAIL] = klaviyoProfile('kp_old', 'SUBSCRIBED');
    state.klaviyo.profilesByEmail[NEW_EMAIL] = klaviyoProfile('kp_new', 'NEVER_SUBSCRIBED');
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, true);
    assert.equal(state.klaviyo.subscribeCalls.length, 0);
    const kStep = result.steps.find(s => s.step === 'klaviyo');
    assert.match(kStep.detail, /re-consent/);
  });

  it('blocked plan executes nothing', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    state.shopify.mergeable[OLD_ID] = { isMergeable: false, reason: 'Gift cards', errorFields: ['GIFT_CARDS'] };
    const plan = await planFor();
    const result = await executeEmailChange(plan);
    assert.equal(result.ok, false);
    assert.equal(state.shopify.mergeCalls.length, 0);
    assert.equal(state.shopify.updateCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// update_customer tool (two-phase)
// ---------------------------------------------------------------------------
describe('update_customer tool', () => {
  it('phase 1 previews an email change; phase 2 with confirmed executes it', async () => {
    seedOldCustomer();
    const p1 = await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL });
    assert.match(p1.content[0].text, /awaiting confirmation/);
    assert.equal(state.shopify.updateCalls.length, 0);

    const p2 = await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL, confirmed: true });
    assert.equal(state.shopify.updateCalls.length, 1);
    assert.match(p2.content[0].text, /Email changed to nora@example\.com/);
  });

  it('phase 2 without a staged phase 1 errors', async () => {
    const res = await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL, confirmed: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Run phase 1 first/);
  });

  it('a confirm on a blocked plan does not execute (nothing was staged)', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    state.shopify.mergeable[NEW_ID] = { isMergeable: false, reason: 'Store credit', errorFields: ['STORE_CREDIT'] };
    const p1 = await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL });
    assert.doesNotMatch(p1.content[0].text, /awaiting confirmation/);
    const p2 = await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL, confirmed: true });
    assert.equal(p2.isError, true);
    assert.equal(state.shopify.mergeCalls.length, 0);
  });

  it('name-only change is two-phase and executes on confirm', async () => {
    seedOldCustomer();
    const p1 = await updateTool.handler({ customer_email: OLD_EMAIL, first_name: 'Laura' });
    assert.match(p1.content[0].text, /awaiting confirmation/);
    assert.match(p1.content[0].text, /AUTO_CONFIRM: SAFE/);
    assert.equal(state.shopify.updateCalls.length, 0);

    await updateTool.handler({ customer_email: OLD_EMAIL, first_name: 'Laura', confirmed: true });
    assert.equal(state.shopify.updateCalls.length, 1);
    assert.deepEqual(state.shopify.updateCalls[0].input, { firstName: 'Laura' });
  });

  it('errors when no fields are provided', async () => {
    const res = await updateTool.handler({ customer_id: '123' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No fields to update/);
  });

  it('errors when the customer cannot be resolved', async () => {
    const res = await updateTool.handler({ customer_email: 'unknown@example.com', email: NEW_EMAIL });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No customer found/);
  });

  it('keep_name passes through to the merge', async () => {
    seedOldCustomer();
    seedShopifyConflict();
    await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL });
    await updateTool.handler({ customer_email: OLD_EMAIL, email: NEW_EMAIL, keep_name: 'original', confirmed: true });
    assert.equal(state.shopify.mergeCalls[0].overrideFields.customerIdOfFirstNameToKeep, OLD_ID);
  });
});
