/**
 * routing_reason + advisor flags mapping through buildCompatibleStructured.
 * (Prompt-side behavior — when the advisor raises them — is covered by the
 * refundPatternFlag / routingReason scenario tests, not unit tests.)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCompatibleStructured } = require('../lib/aiAdvisor');
const { ADVISOR_OUTPUT_SCHEMA_REQUIRED } = (() => {
  const { FULL_SCHEMA } = require('../lib/advisorOutputSchema');
  return { ADVISOR_OUTPUT_SCHEMA_REQUIRED: FULL_SCHEMA.required };
})();

const OPTS = { customer_email: 'test@example.com', orderContext: null, existingIntake: null, audit: [] };

const base = {
  status: 'ready',
  message_type: 'refund',
  items: [],
  audit: [],
};

test('advisor flags map into prescription.flags, validated and capped', () => {
  const out = buildCompatibleStructured({
    ...base,
    flags: ['Refund-pattern: first-time buyer, declined size help', '', '  ', 42, 'a', 'b', 'c', 'd', 'e'],
  }, 'reply', OPTS);
  assert.deepStrictEqual(out.prescription.flags, [
    'Refund-pattern: first-time buyer, declined size help', 'a', 'b', 'c', 'd',
  ]);
});

test('no flags → empty array', () => {
  const out = buildCompatibleStructured({ ...base }, 'reply', OPTS);
  assert.deepStrictEqual(out.prescription.flags, []);
});

test('routing_reason passes through on route_to_human', () => {
  const out = buildCompatibleStructured({
    ...base,
    status: 'route_to_human',
    routing_reason: '3rd refund request on this account — review before refunding',
  }, 'reply', OPTS);
  assert.strictEqual(out.status, 'route_to_human');
  assert.strictEqual(out.routing_reason, '3rd refund request on this account — review before refunding');
});

test('route_to_human without a reason gets the visible lapse placeholder', () => {
  const out = buildCompatibleStructured({ ...base, status: 'route_to_human' }, 'reply', OPTS);
  assert.match(out.routing_reason, /without a stated reason/);
});

test('routing_reason is null for non-routed statuses', () => {
  const out = buildCompatibleStructured({ ...base, routing_reason: 'should be dropped' }, 'reply', OPTS);
  assert.strictEqual(out.routing_reason, null);
});

test('parse-failure default carries a routing_reason', () => {
  const out = buildCompatibleStructured(null, 'reply', OPTS);
  assert.strictEqual(out.status, 'route_to_human');
  assert.match(out.routing_reason, /could not be parsed/);
});

test('schema requires the new fields so schema mode always emits them', () => {
  assert.ok(ADVISOR_OUTPUT_SCHEMA_REQUIRED.includes('routing_reason'));
  assert.ok(ADVISOR_OUTPUT_SCHEMA_REQUIRED.includes('flags'));
});
