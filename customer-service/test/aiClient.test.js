/**
 * Unit tests for shared/aiClient.js — the universal AI-call wrapper.
 *
 * Verifies token extraction, cost calc, error path, streaming, and the
 * fail-soft tracking write, all against a MOCKED Anthropic SDK and a mocked
 * Supabase client (no network).
 *
 * Run: node --test customer-service/test/aiClient.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub @anthropic-ai/sdk and shared/supabaseClient BEFORE requiring aiClient.
// ---------------------------------------------------------------------------
const anthropicPath = require.resolve('@anthropic-ai/sdk');
const supabasePath = require.resolve('../../shared/supabaseClient');

// Mutable mock state, reset per test.
let mockCreate; // (params) => response | throws
let mockStream; // (params) => { on, finalMessage }
let insertedRows; // captured ai_calls inserts
let tableMissing; // when true, the probe reports the table absent
let insertShouldThrow; // when true, .insert(...).select().single() rejects

class MockAnthropic {
  constructor() {
    this.messages = {
      create: (params, options) => mockCreate(params, options),
      stream: (params, options) => mockStream(params, options),
    };
  }
}

require.cache[anthropicPath] = {
  id: anthropicPath,
  filename: anthropicPath,
  loaded: true,
  exports: MockAnthropic,
};

// Mock Supabase: from('ai_calls') supports .select(...).limit() for the probe
// and .insert(...).select(...).single() for the write.
function makeSupabaseStub() {
  return {
    from(table) {
      assert.equal(table, 'ai_calls');
      return {
        // probe: .select('id').limit(0) => { error }
        select() {
          return {
            limit() {
              return Promise.resolve({ error: tableMissing ? { message: 'relation "ai_calls" does not exist' } : null });
            },
          };
        },
        // write: .insert(row).select('id').single()
        insert(row) {
          insertedRows.push(row);
          return {
            select() {
              return {
                single() {
                  if (insertShouldThrow) return Promise.reject(new Error('boom'));
                  return Promise.resolve({ data: { id: insertedRows.length }, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabaseClient: () => makeSupabaseStub() },
};

const { callClaude, embedTexts, _resetTableProbe } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

function resetState() {
  insertedRows = [];
  tableMissing = false;
  insertShouldThrow = false;
  mockCreate = () => { throw new Error('mockCreate not set'); };
  mockStream = () => { throw new Error('mockStream not set'); };
  _resetTableProbe();
}

beforeEach(resetState);

// ---------------------------------------------------------------------------
// Token extraction + cost calc
// ---------------------------------------------------------------------------
describe('callClaude — token extraction and cost', () => {
  it('extracts usage and computes Opus cost correctly', async () => {
    mockCreate = () => ({
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    });

    const res = await callClaude({
      component: 'cs_advisor',
      model: MODELS.OPUS,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });

    // _usage shape
    assert.deepEqual(res._usage, {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200,
      cache_creation_tokens: 100,
    });
    assert.equal(res.text, 'hello');
    assert.deepEqual(res.tool_calls, []);
    assert.equal(res._ai_call_id, 1);

    // Cost at corrected Opus rates (2026-06-10): 1000*5 + 500*25 + 200*0.5 + 100*6.25 per million
    // = (5000 + 12500 + 100 + 625) / 1e6 = 18225/1e6 = 0.018225
    const row = insertedRows[0];
    assert.equal(row.cost_usd, 0.018225);
    assert.equal(row.component, 'cs_advisor');
    assert.equal(row.model_id, MODELS.OPUS);
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.input_tokens, 1000);
    assert.equal(row.error, null);
    assert.equal(row.metadata.stop_reason, 'end_turn');
  });

  it('captures tool_calls and tool_count', async () => {
    mockCreate = () => ({
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', name: 'get_order_details', id: 't1', input: {} },
        { type: 'tool_use', name: 'lookup_customer', id: 't2', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const res = await callClaude({
      component: 'cs_operator',
      model: MODELS.OPUS,
      messages: [],
      max_tokens: 100,
    });

    assert.deepEqual(res.tool_calls, ['get_order_details', 'lookup_customer']);
    assert.deepEqual(res._timing.tool_calls, ['get_order_details', 'lookup_customer']);
    const row = insertedRows[0];
    assert.deepEqual(row.tool_calls, ['get_order_details', 'lookup_customer']);
    assert.equal(row.tool_count, 2);
    // cache defaults to 0 when absent
    assert.equal(res._usage.cache_read_tokens, 0);
    assert.equal(res._usage.cache_creation_tokens, 0);
  });

  it('records duration_ms and passes linkage fields through', async () => {
    mockCreate = () => ({
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const res = await callClaude({
      component: 'cs_intake_classifier',
      model: MODELS.OPUS,
      messages: [],
      max_tokens: 100,
      ticket_id: 555,
      draft_id: 777,
      parent_call_id: 42,
      metadata: { foo: 'bar' },
    });

    const row = insertedRows[0];
    assert.equal(row.ticket_id, 555);
    assert.equal(row.draft_id, 777);
    assert.equal(row.parent_call_id, 42);
    assert.equal(row.metadata.foo, 'bar');
    assert.ok(typeof row.duration_ms === 'number' && row.duration_ms >= 0);
    assert.ok(typeof res._timing.duration_ms === 'number');
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
describe('callClaude — streaming', () => {
  it('emits text deltas via onText and resolves on finalMessage', async () => {
    const deltas = [];
    const finalMsg = {
      content: [{ type: 'text', text: 'streamed result' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 7 },
    };
    mockStream = () => {
      const handlers = {};
      // Synchronously fire deltas when finalMessage is awaited.
      return {
        on(event, cb) { handlers[event] = cb; },
        finalMessage() {
          if (handlers.text) {
            handlers.text('streamed ');
            handlers.text('result');
          }
          return Promise.resolve(finalMsg);
        },
      };
    };

    const res = await callClaude({
      component: 'cs_advisor',
      model: MODELS.OPUS,
      messages: [],
      max_tokens: 100,
      stream: true,
      onText: (t) => deltas.push(t),
    });

    assert.deepEqual(deltas, ['streamed ', 'result']);
    assert.equal(res.text, 'streamed result');
    assert.equal(res._usage.output_tokens, 7);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].cost_usd > 0, true);
  });

  // --- stall guard (streamStallMs) ------------------------------------------

  // A fake SDK stream: EventEmitter-ish with on()/emit(), finalMessage() that
  // resolves only when `settle()` is called, and an abort() that rejects it.
  function makeControllableStream(finalMsg) {
    const handlers = {};
    let resolveFinal, rejectFinal;
    let aborted = false;
    const finalPromise = new Promise((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    return {
      aborted: () => aborted,
      on(event, cb) { (handlers[event] ||= []).push(cb); return this; },
      emit(event, ...args) { (handlers[event] || []).forEach(cb => cb(...args)); },
      abort() { aborted = true; rejectFinal(Object.assign(new Error('aborted'), { name: 'AbortError' })); },
      settle() { resolveFinal(finalMsg); },
      finalMessage() { return finalPromise; },
    };
  }

  it('rejects with err.stalled and aborts when the stream goes idle past streamStallMs', async () => {
    let theStream;
    mockStream = () => {
      theStream = makeControllableStream({
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return theStream;
    };

    await assert.rejects(
      callClaude({
        component: 'cs_advisor',
        model: MODELS.OPUS,
        messages: [],
        max_tokens: 100,
        stream: true,
        streamStallMs: 20, // trips quickly: no streamEvent is ever emitted
      }),
      (err) => err.stalled === true,
    );

    assert.equal(theStream.aborted(), true, 'stalled stream should be aborted');
    // Error path still records a row (cost 0).
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].cost_usd, 0);
  });

  it('does NOT trip the stall guard while streamEvent activity keeps arriving', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    };
    let theStream;
    mockStream = () => { theStream = makeControllableStream(finalMsg); return theStream; };

    const callP = callClaude({
      component: 'cs_advisor',
      model: MODELS.OPUS,
      messages: [],
      max_tokens: 100,
      stream: true,
      streamStallMs: 40,
    });

    // Heartbeat well inside the 40ms window a few times, then settle — should
    // resolve normally and never abort.
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 15));
      theStream.emit('streamEvent', {}, {});
    }
    theStream.settle();

    const res = await callP;
    assert.equal(res.text, 'done');
    assert.equal(theStream.aborted(), false, 'a live stream must not be aborted');
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].cost_usd > 0, true);
  });

  it('resolves normally when streamStallMs is set but the stream settles promptly', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'quick' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    let theStream;
    mockStream = () => { theStream = makeControllableStream(finalMsg); return theStream; };

    const callP = callClaude({
      component: 'cs_advisor', model: MODELS.OPUS, messages: [], max_tokens: 10,
      stream: true, streamStallMs: 1000,
    });
    theStream.settle();
    const res = await callP;
    assert.equal(res.text, 'quick');
    assert.equal(theStream.aborted(), false);
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------
describe('callClaude — error path', () => {
  it('records an error row with cost 0 and rethrows', async () => {
    mockCreate = () => { throw new Error('rate limited'); };

    await assert.rejects(
      callClaude({ component: 'cs_advisor', model: MODELS.OPUS, messages: [], max_tokens: 10 }),
      /rate limited/
    );

    assert.equal(insertedRows.length, 1);
    const row = insertedRows[0];
    assert.equal(row.error, 'rate limited');
    assert.equal(row.cost_usd, 0);
    assert.equal(row.component, 'cs_advisor');
  });
});

// ---------------------------------------------------------------------------
// Fail-soft tracking writes
// ---------------------------------------------------------------------------
describe('callClaude — fail-soft writes', () => {
  it('no-ops the insert when ai_calls table is missing', async () => {
    tableMissing = true;
    mockCreate = () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const res = await callClaude({ component: 'cs_advisor', model: MODELS.OPUS, messages: [], max_tokens: 10 });

    // Call still succeeds, returns the result, but no row written and id is null.
    assert.equal(res.text, 'ok');
    assert.equal(res._ai_call_id, null);
    assert.equal(insertedRows.length, 0);
  });

  it('returns null id (not throw) when the insert itself errors', async () => {
    insertShouldThrow = true;
    mockCreate = () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const res = await callClaude({ component: 'cs_advisor', model: MODELS.OPUS, messages: [], max_tokens: 10 });
    assert.equal(res._ai_call_id, null);
    assert.equal(res.text, 'ok');
  });

  it('a tracking failure on the error path does not mask the original error', async () => {
    tableMissing = true;
    mockCreate = () => { throw new Error('original failure'); };
    await assert.rejects(
      callClaude({ component: 'cs_advisor', model: MODELS.OPUS, messages: [], max_tokens: 10 }),
      /original failure/
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe('callClaude — validation', () => {
  it('requires component and model', async () => {
    await assert.rejects(callClaude({ model: MODELS.OPUS }), /component is required/);
    await assert.rejects(callClaude({ component: 'x' }), /model is required/);
  });

  it('unknown model resolves cost to 0 without throwing', async () => {
    mockCreate = () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 1000 },
    });
    const res = await callClaude({ component: 'x', model: 'no-such-model', messages: [], max_tokens: 10 });
    assert.equal(insertedRows[0].cost_usd, 0);
    assert.equal(res.text, 'ok');
  });

  it('forwards requestOptions as the second arg to messages.create', async () => {
    let seenOptions;
    mockCreate = (params, options) => {
      seenOptions = options;
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    await callClaude({
      component: 'competitor_price_extractor',
      model: MODELS.SONNET,
      messages: [],
      max_tokens: 10,
      requestOptions: { timeout: 30000, maxRetries: 2 },
    });
    assert.deepEqual(seenOptions, { timeout: 30000, maxRetries: 2 });
  });
});

// ---------------------------------------------------------------------------
// embedTexts (Voyage)
// ---------------------------------------------------------------------------
describe('embedTexts — Voyage', () => {
  const origFetch = global.fetch;
  const origKey = process.env.VOYAGE_API_KEY;

  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
  });

  it('returns vectors in order and computes cost from total_tokens', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.4, 0.5] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
        usage: { total_tokens: 1_000_000 },
      }),
    });

    const { vectors, _usage, _ai_call_id } = await embedTexts({
      component: 'kb_embeddings',
      model: 'voyage-3-lite',
      texts: ['a', 'b'],
    });

    assert.deepEqual(vectors, [[0.1, 0.2], [0.4, 0.5]]);
    assert.equal(_usage.input_tokens, 1_000_000);
    assert.equal(_ai_call_id, 1);
    const row = insertedRows[0];
    assert.equal(row.provider, 'voyage');
    // voyage-3-lite input rate 0.02/M => 1M tokens = $0.02
    assert.equal(row.cost_usd, 0.02);
    assert.equal(row.metadata.text_count, 2);

    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = origKey;
  });

  it('records an error row and rethrows on Voyage API failure', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'server error' });

    await assert.rejects(
      embedTexts({ component: 'kb_embeddings', model: 'voyage-3-lite', texts: ['a'] }),
      /Voyage API error 500/
    );
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].cost_usd, 0);
    assert.ok(insertedRows[0].error.includes('500'));

    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = origKey;
  });
});
