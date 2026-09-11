const { test } = require('node:test');
const assert = require('node:assert');
const { saveOperatorDraft } = require('../../b2b-outreach/lib/queueService');

// Minimal stub: enough to exercise which branch saveOperatorDraft takes.
function makeSb(state) {
  return {
    from(table) {
      const q = {
        _f: {},
        select() { return q; },
        eq(c, v) { q._f[c] = v; return q; },
        maybeSingle() {
          if (table === 'b2b_drafts') return Promise.resolve({ data: state.pending, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch) { state.updates.push({ table, patch, where: { ...q._f } }); return q; },
        then(r) { return r({ data: [], error: null }); },
      };
      return q;
    },
  };
}

test('an empty composer with nothing saved is a no-op, not an error', async () => {
  const state = { pending: null, updates: [] };
  const res = await saveOperatorDraft(makeSb(state), { company_id: 'x', body: '' });
  assert.equal(res.saved, true);
  assert.equal(res.draft_id, null);
  assert.equal(state.updates.length, 0);
});

test('company_id is required', async () => {
  await assert.rejects(() => saveOperatorDraft(makeSb({ pending: null, updates: [] }), { body: 'hi' }),
    /company_id required/);
});

test('an advisor draft is never overwritten by autosave', async () => {
  const state = { pending: { id: 7, advisor: 'b2b_sales_advisor' }, updates: [] };
  const res = await saveOperatorDraft(makeSb(state), { company_id: 'x', body: 'my edits' });
  assert.equal(res.saved, false);
  assert.equal(res.reason, 'advisor_draft');
  assert.equal(state.updates.length, 0, 'the AI original must survive as training signal');
});

test('an existing operator draft is updated in place, not duplicated', async () => {
  const state = { pending: { id: 9, advisor: null }, updates: [] };
  const res = await saveOperatorDraft(makeSb(state), { company_id: 'x', body: '  hello  ', subject: ' hi ' });
  assert.equal(res.draft_id, 9);
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.updates[0].patch, { body: 'hello', subject: 'hi' }, 'trimmed');
});

test('a recipient edit made before the row existed rides the autosave onto it', async () => {
  const state = { pending: { id: 9, advisor: null, structured: { cc: 'asha@colage.org', attachments: ['x'] } }, updates: [] };
  await saveOperatorDraft(makeSb(state), { company_id: 'x', body: 'hello', subject: '', cc: '' });
  assert.deepEqual(state.updates[0].patch, { body: 'hello', subject: null, structured: { attachments: ['x'] } },
    'an explicit empty cc clears the default; everything else on structured survives');

  const state2 = { pending: { id: 9, advisor: null, structured: { cc: 'asha@colage.org' } }, updates: [] };
  await saveOperatorDraft(makeSb(state2), { company_id: 'x', body: 'hello', to: 'katy@colage.org', cc: 'asha@colage.org, board@colage.org' });
  assert.deepEqual(state2.updates[0].patch.structured, { to: 'katy@colage.org', cc: 'asha@colage.org, board@colage.org' });
});

test('a plain keystroke never touches structured', async () => {
  const state = { pending: { id: 9, advisor: null, structured: { cc: 'asha@colage.org' } }, updates: [] };
  await saveOperatorDraft(makeSb(state), { company_id: 'x', body: 'hello' });
  assert.equal('structured' in state.updates[0].patch, false);
});

test('clearing the box dismisses the draft rather than saving an empty one', async () => {
  const state = { pending: { id: 9, advisor: null }, updates: [] };
  const res = await saveOperatorDraft(makeSb(state), { company_id: 'x', body: '   ' });
  assert.equal(res.cleared, true);
  assert.deepEqual(state.updates[0].patch, { status: 'dismissed' },
    'a blank pending row would advertise a draft with nothing in it');
});
