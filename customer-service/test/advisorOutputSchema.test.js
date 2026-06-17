const { test } = require('node:test');
const assert = require('node:assert');
const { ADVISOR_OUTPUT_SCHEMA, createCustomerReplyStreamExtractor } = require('../lib/advisorOutputSchema');

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

test('schema: message_type enum matches the canonical set', () => {
  const types = ADVISOR_OUTPUT_SCHEMA.properties.message_type.enum;
  for (const t of ['exchange', 'refund', 'closing', 'sizing_inquiry', 'uncategorized']) {
    assert.ok(types.includes(t), t);
  }
});
