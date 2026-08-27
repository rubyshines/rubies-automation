/**
 * The repair script's change-detection compares a freshly computed line array
 * against one that has round-tripped through Postgres `jsonb`, which does NOT
 * preserve key order. A plain JSON.stringify comparison therefore reports a
 * difference on every row forever: the script rewrites all 221 rows on each run
 * and its dry-run output claims clean rows need repair. That failure is silent
 * and looks exactly like the script working.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { stableStringify } = require('../sync/reparseTransferLines');

test('key order does not affect the comparison', () => {
  const computed = { Amount: 5000, DetailType: 'JournalEntryLineDetail', _synthesized: 'Transfer' };
  const roundTripped = { _synthesized: 'Transfer', Amount: 5000, DetailType: 'JournalEntryLineDetail' };
  assert.notStrictEqual(JSON.stringify(computed), JSON.stringify(roundTripped), 'precondition: plain stringify differs');
  assert.strictEqual(stableStringify(computed), stableStringify(roundTripped));
});

test('nested objects are canonicalised too', () => {
  // This is the shape that actually bit: jsonb reordered the inner
  // JournalEntryLineDetail keys, not the outer ones.
  const a = [{ JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { name: 'TD', value: '190' } } }];
  const b = [{ JournalEntryLineDetail: { AccountRef: { value: '190', name: 'TD' }, PostingType: 'Debit' } }];
  assert.strictEqual(stableStringify(a), stableStringify(b));
});

test('genuine differences are still detected', () => {
  const a = { PostingType: 'Debit', AccountRef: { name: 'TD Chequing 7285' } };
  const b = { PostingType: 'Credit', AccountRef: { name: 'TD Chequing 7285' } };
  assert.notStrictEqual(stableStringify(a), stableStringify(b));

  // A changed amount must not be swallowed by canonicalisation.
  assert.notStrictEqual(stableStringify({ Amount: 5000 }), stableStringify({ Amount: 5001 }));
  // Nor a missing key.
  assert.notStrictEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 1 }));
});

test('arrays keep their order, since debit/credit is not commutative', () => {
  assert.notStrictEqual(stableStringify([{ x: 1 }, { x: 2 }]), stableStringify([{ x: 2 }, { x: 1 }]));
});

test('null and primitives round-trip', () => {
  assert.strictEqual(stableStringify(null), 'null');
  assert.strictEqual(stableStringify(5000), '5000');
  assert.strictEqual(stableStringify('tfr fr jata'), '"tfr fr jata"');
  assert.strictEqual(stableStringify({ Description: null }), '{"Description":null}');
});
