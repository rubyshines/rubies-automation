const { test } = require('node:test');
const assert = require('node:assert');
const {
  ADVISOR_OUTPUT_SCHEMA,
  OPERATOR_ACTION_SUMMARY_SPEC,
  LEGACY_STRUCTURED_TEMPLATE,
  createCustomerReplyStreamExtractor,
} = require('../lib/advisorOutputSchema');

/** The JSON body of the legacy <structured> template — what production sends. */
function legacyTemplateFields() {
  const open = LEGACY_STRUCTURED_TEMPLATE.indexOf('<structured>\n');
  const close = LEGACY_STRUCTURED_TEMPLATE.indexOf('</structured>');
  return JSON.parse(LEGACY_STRUCTURED_TEMPLATE.slice(open + '<structured>\n'.length, close).trim());
}

function runExtractor(deltas) {
  let reply = '';
  let proseComplete = false;
  const feed = createCustomerReplyStreamExtractor({
    onReplyText: (t) => { reply += t; },
    onProseComplete: () => { proseComplete = true; },
  });
  for (const d of deltas) feed(d);
  return { reply, proseComplete };
}

const FULL_JSON = '{"customer_reply":"Hi Sarah,\\n\\nThe medium will have 2\\" less fabric. Want me to send it?\\n\\nJamie","status":"ready"}';

test('extractor pulls the reply from one big delta', () => {
  const { reply, proseComplete } = runExtractor([FULL_JSON]);
  assert.equal(reply, 'Hi Sarah,\n\nThe medium will have 2" less fabric. Want me to send it?\n\nJamie');
  assert.equal(proseComplete, true);
});

test('extractor handles tiny deltas splitting the key, escapes, and closing quote', () => {
  const deltas = FULL_JSON.split('').map(c => c); // one char at a time — worst case
  const { reply, proseComplete } = runExtractor(deltas);
  assert.equal(reply, 'Hi Sarah,\n\nThe medium will have 2" less fabric. Want me to send it?\n\nJamie');
  assert.equal(proseComplete, true);
});

test('extractor emits nothing after the field closes', () => {
  let reply = '';
  const feed = createCustomerReplyStreamExtractor({ onReplyText: t => { reply += t; }, onProseComplete: () => {} });
  feed('{"customer_reply":"Hi","status":"ready","summary":"should not appear"}');
  assert.equal(reply, 'Hi');
});

test('extractor handles unicode escapes split across deltas', () => {
  const json = '{"customer_reply":"caf\\u00e9 time"}';
  const splitAt = json.indexOf('\\u00e9') + 3; // split mid-escape
  const { reply } = runExtractor([json.slice(0, splitAt), json.slice(splitAt)]);
  assert.equal(reply, 'café time');
});

test('schema: customer_reply is the first property (streams first)', () => {
  assert.equal(Object.keys(ADVISOR_OUTPUT_SCHEMA.properties)[0], 'customer_reply');
});

test('schema: all properties are required and no extras allowed', () => {
  assert.deepEqual(
    [...ADVISOR_OUTPUT_SCHEMA.required].sort(),
    Object.keys(ADVISOR_OUTPUT_SCHEMA.properties).sort()
  );
  assert.equal(ADVISOR_OUTPUT_SCHEMA.additionalProperties, false);
});

// The legacy <structured> template is what the model actually reads (schema
// mode off by default since 2026-06-13), so guidance that exists only in a
// schema description has never shipped. That is how the "keep customer-facing
// copy out of operator_action_summary" rule sat unread for two months while
// donation wording leaked into ~16% of operator actions. These two tests make
// the divergence fail loudly instead of silently not shipping.
test('legacy template carries every schema field, so nothing ships schema-only', () => {
  const legacy = legacyTemplateFields();
  const schemaFields = Object.keys(ADVISOR_OUTPUT_SCHEMA.properties)
    // customer_reply is the prose itself in legacy mode — written before the
    // block, not inside it. Every other field must appear in the template.
    .filter(f => f !== 'customer_reply');
  for (const f of schemaFields) {
    assert.ok(f in legacy, `${f} is in the schema but missing from the legacy template — production never sees it`);
  }
});

test('operator_action_summary spec is single-sourced across both output modes', () => {
  assert.equal(ADVISOR_OUTPUT_SCHEMA.properties.operator_action_summary.description, OPERATOR_ACTION_SUMMARY_SPEC);
  assert.equal(legacyTemplateFields().operator_action_summary, OPERATOR_ACTION_SUMMARY_SPEC);
  // The load-bearing halves: what belongs in the field, and what never does.
  assert.match(OPERATOR_ACTION_SUMMARY_SPEC, /tool arguments/i);
  assert.match(OPERATOR_ACTION_SUMMARY_SPEC, /donation/i);
  assert.match(OPERATOR_ACTION_SUMMARY_SPEC, /never a dollar amount/i);
});

test('schema: message_type enum matches the canonical set', () => {
  const types = ADVISOR_OUTPUT_SCHEMA.properties.message_type.enum;
  for (const t of ['exchange', 'refund', 'closing', 'sizing_inquiry', 'uncategorized']) {
    assert.ok(types.includes(t), t);
  }
});
