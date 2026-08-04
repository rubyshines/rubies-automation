const test = require('node:test');
const assert = require('node:assert');

const {
  withTurnOrdinals,
  bucketOf,
  isEligible,
  sampleBucket,
  buildSample,
  lastCustomerMessage,
} = require('../../scripts/publishToleranceSheet');

const draft = (over = {}) => ({
  id: 1,
  ticket_id: 100,
  message_type: 'exchange',
  source: 'poller',
  draft_kind: 'advisor_draft',
  draft_response: 'hello',
  sent_response: 'hello',
  conversation_history: [],
  created_at: '2026-06-10T00:00:00Z',
  ...over,
});

test('turn ordinal comes from created_at order, not the turn_number column', () => {
  // Ticket 2949 has two real rounds, both stamped turn_number 1 in the table.
  // Ordering must come from created_at or every multi-round ticket collapses
  // into the turn-1 bucket and the whole stratification is wrong.
  const rows = withTurnOrdinals([
    draft({ id: 2, created_at: '2026-06-11T00:00:00Z' }),
    draft({ id: 1, created_at: '2026-06-10T00:00:00Z' }),
    draft({ id: 3, created_at: '2026-06-12T00:00:00Z' }),
  ]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r.turn_ordinal]));
  assert.deepStrictEqual(byId, { 1: 1, 2: 2, 3: 3 });
});

test('turn ordinals are per ticket, not global', () => {
  const rows = withTurnOrdinals([
    draft({ id: 1, ticket_id: 100, created_at: '2026-06-10T00:00:00Z' }),
    draft({ id: 2, ticket_id: 200, created_at: '2026-06-11T00:00:00Z' }),
  ]);
  assert.deepStrictEqual(rows.map(r => r.turn_ordinal), [1, 1]);
});

test('bucketOf collapses 4 and beyond', () => {
  assert.strictEqual(bucketOf(1), '1');
  assert.strictEqual(bucketOf(3), '3');
  assert.strictEqual(bucketOf(4), '4+');
  assert.strictEqual(bucketOf(9), '4+');
});

test('only unedited sends are eligible', () => {
  assert.ok(isEligible(draft(), '2026-06-01'));
  assert.ok(!isEligible(draft({ sent_response: 'hello there' }), '2026-06-01'),
    'an edited send is a labeled negative, not a tolerance sample');
});

test('whitespace-only differences still count as unedited', () => {
  assert.ok(isEligible(draft({ draft_response: 'hi  there\n\n' , sent_response: 'hi there' }), '2026-06-01'));
});

test('only advisor-written drafts are eligible — everything else is not the advisor', () => {
  // cs_ai_drafts holds every outbound message, not just advisor drafts.
  assert.ok(!isEligible(draft({ message_type: 'proactive_outreach' }), '2026-06-01'));
  assert.ok(!isEligible(draft({ source: 'operator_outreach' }), '2026-06-01'));
  // Templated follow-up nudges: ~97% byte-identical and ALL at turn 4+, so
  // including them invented a 71% unedited rate in that bucket.
  assert.ok(!isEligible(draft({ source: 'auto_follow_up' }), '2026-06-01'));
  // Jamie composing from scratch — stored into BOTH draft_response and
  // sent_response, so it reads as a flawless advisor draft. This is the one
  // that reached the founder review sheet and he recognised his own writing.
  assert.ok(!isEligible(draft({ source: 'operator_reply' }), '2026-06-01'));
});

test('source filtering fails closed on unknown values', () => {
  // A blacklist shipped first and leaked. Any source nobody has vetted must
  // be excluded until someone deliberately adds it to the whitelist.
  assert.ok(!isEligible(draft({ source: 'some_future_sender' }), '2026-06-01'));
  assert.ok(!isEligible(draft({ source: null }), '2026-06-01'));
});

test('empty drafts and out-of-window drafts are excluded', () => {
  assert.ok(!isEligible(draft({ draft_response: '   ', sent_response: '   ' }), '2026-06-01'));
  assert.ok(!isEligible(draft({ created_at: '2026-05-01T00:00:00Z' }), '2026-06-01'));
});

test('sampleBucket spreads across message types instead of taking one type', () => {
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => draft({ id: i + 1, message_type: 'exchange' })),
    ...Array.from({ length: 10 }, (_, i) => draft({ id: i + 20, message_type: 'shipping' })),
    ...Array.from({ length: 10 }, (_, i) => draft({ id: i + 40, message_type: 'refund' })),
  ];
  const picked = sampleBucket(pool, 6);
  assert.strictEqual(picked.length, 6);
  const types = new Set(picked.map(p => p.message_type));
  assert.strictEqual(types.size, 3, 'every available type should appear before any type repeats');
});

test('sampleBucket is deterministic across runs', () => {
  const pool = Array.from({ length: 20 }, (_, i) =>
    draft({ id: i + 1, message_type: i % 2 ? 'exchange' : 'shipping' }));
  const a = sampleBucket(pool, 8).map(d => d.id);
  const b = sampleBucket(pool, 8).map(d => d.id);
  assert.deepStrictEqual(a, b, 're-publishing before review must not reshuffle the sample');
});

test('sampleBucket returns what it can when the pool is short', () => {
  const pool = [draft({ id: 1 }), draft({ id: 2 })];
  assert.strictEqual(sampleBucket(pool, 10).length, 2);
});

test('buildSample fills every turn bucket and reports pool sizes', () => {
  const rows = [];
  let id = 1;
  // 5 tickets, 4 rounds each → every bucket populated
  for (let t = 0; t < 5; t++) {
    for (let r = 0; r < 4; r++) {
      rows.push(draft({
        id: id++,
        ticket_id: 500 + t,
        message_type: r % 2 ? 'exchange' : 'shipping',
        created_at: `2026-06-1${r}T00:00:00Z`,
      }));
    }
  }
  const { rows: sample, stats } = buildSample(rows, { since: '2026-06-01', perBucket: 3 });
  assert.strictEqual(sample.length, 12);
  for (const b of ['1', '2', '3', '4+']) {
    assert.strictEqual(stats[b].pool, 5);
    assert.strictEqual(stats[b].picked, 3);
  }
});

test('lastCustomerMessage takes the most recent human customer message', () => {
  const d = draft({
    conversation_history: [
      { sender: 'customer', body: 'first', is_bot: false },
      { sender: 'agent', body: 'our reply', is_bot: false },
      { sender: 'customer', body: 'What would you like to do?', is_bot: true },
      { sender: 'customer', body: 'the measurement is 34"', is_bot: false },
    ],
  });
  assert.strictEqual(lastCustomerMessage(d), 'the measurement is 34"');
});

test('lastCustomerMessage tolerates missing or empty history', () => {
  assert.strictEqual(lastCustomerMessage(draft({ conversation_history: null })), '');
  assert.strictEqual(lastCustomerMessage(draft({ conversation_history: [] })), '');
});
