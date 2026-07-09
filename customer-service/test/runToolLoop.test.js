/**
 * runToolLoop — unit tests for the shared agentic tool-loop engine.
 * All tests inject a stub callClaude; no network, no Supabase.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { runToolLoop } = require('../lib/runToolLoop');

// Build a stub callClaude that returns scripted responses in order and
// records every params object it was called with.
function scriptedClaude(responses) {
  const calls = [];
  let i = 0;
  const fn = async (params) => {
    calls.push(params);
    if (i >= responses.length) throw new Error('scriptedClaude: ran out of responses');
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const textResponse = (text, id) => ({
  _ai_call_id: id || 'call_text',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: {},
});

const toolResponse = (tools, id) => ({
  _ai_call_id: id || 'call_tool',
  content: tools.map((t, i) => ({ type: 'tool_use', id: `tu_${id || 't'}_${i}`, name: t.name, input: t.input || {} })),
  stop_reason: 'tool_use',
  usage: {},
});

test('no tool calls: single round, returns final response, messages untouched', async () => {
  const claude = scriptedClaude([textResponse('done')]);
  const initial = [{ role: 'user', content: 'hi' }];
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: initial,
    dispatchTool: async () => { throw new Error('should not dispatch'); },
  });
  assert.equal(out.response.content[0].text, 'done');
  assert.equal(out.iterations, 1);
  assert.equal(out.toolCallCount, 0);
  assert.deepEqual(out.messages, initial);
  assert.notEqual(out.messages, initial); // copy, not the same array
});

test('tool round: dispatches, appends assistant + tool_result, then finishes', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 'lookup', input: { q: 1 } }], 'r1'),
    textResponse('final', 'r2'),
  ]);
  const dispatched = [];
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async (name, input) => { dispatched.push({ name, input }); return { ok: true }; },
  });
  assert.deepEqual(dispatched, [{ name: 'lookup', input: { q: 1 } }]);
  assert.equal(out.response.content[0].text, 'final');
  assert.equal(out.toolCallCount, 1);
  // messages: user, assistant(tool_use), user(tool_result) — final assistant NOT appended
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[2].role, 'user');
  assert.equal(out.messages[2].content[0].type, 'tool_result');
  assert.equal(out.messages[2].content[0].tool_use_id, 'tu_r1_0');
  assert.equal(out.messages[2].content[0].content, JSON.stringify({ ok: true }));
});

test('parent_call_id: first call null, later calls carry the first _ai_call_id', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 't' }], 'first_id'),
    toolResponse([{ name: 't' }], 'second_id'),
    textResponse('end', 'third_id'),
  ]);
  await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
  });
  assert.equal(claude.calls[0].parent_call_id, null);
  assert.equal(claude.calls[1].parent_call_id, 'first_id');
  assert.equal(claude.calls[2].parent_call_id, 'first_id');
});

test('dispatchTool throw becomes {"error"} tool_result and loop continues', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 'boom' }], 'r1'),
    textResponse('recovered', 'r2'),
  ]);
  const entries = [];
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => { throw new Error('kapow'); },
    onToolResult: (e) => entries.push(e),
  });
  assert.equal(out.response.content[0].text, 'recovered');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].error, 'kapow');
  assert.equal(entries[0].content, JSON.stringify({ error: 'kapow' }));
});

test('toolAllowlist blocks unlisted tools without dispatching', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 'read_ok' }, { name: 'refund_order', input: { amt: 5 } }], 'r1'),
    textResponse('end', 'r2'),
  ]);
  const dispatched = [];
  const entries = [];
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async (name) => { dispatched.push(name); return { data: 1 }; },
    toolAllowlist: new Set(['read_ok']),
    onToolResult: (e) => entries.push(e),
  });
  assert.deepEqual(dispatched, ['read_ok']);
  assert.equal(entries[1].blocked, true);
  const blockedContent = JSON.parse(entries[1].content);
  assert.equal(blockedContent.shadow_blocked, true);
  assert.equal(blockedContent.tool, 'refund_order');
  assert.equal(out.toolCallCount, 2); // blocked calls still counted
});

test('maxIterations caps API rounds; last response may still hold tool_use', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 't' }], 'r1'),
    toolResponse([{ name: 't' }], 'r2'),
    toolResponse([{ name: 't' }], 'r3'),
  ]);
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    maxIterations: 2,
  });
  assert.equal(out.iterations, 2);
  assert.equal(claude.calls.length, 2);
  assert.equal(out.response._ai_call_id, 'r2');
});

test('maxToolCalls: cap checked before each round (advisor semantics)', async () => {
  // Round 1 makes 3 tool calls; cap of 3 means no round 2 API call happens.
  const claude = scriptedClaude([
    toolResponse([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 'r1'),
  ]);
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    maxIterations: Infinity,
    maxToolCalls: 3,
  });
  assert.equal(claude.calls.length, 1);
  assert.equal(out.toolCallCount, 3);
  assert.equal(out.response._ai_call_id, 'r1');
});

test('onApiError retry re-runs the same round; caller state change takes effect', async () => {
  const overloaded = Object.assign(new Error('529'), { status: 529 });
  const claude = scriptedClaude([overloaded, textResponse('after retry', 'r2')]);
  let mode = 'schema';
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm', mode }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    onApiError: (err) => {
      if (err.status === 529 && mode === 'schema') { mode = 'legacy'; return 'retry'; }
    },
  });
  assert.equal(out.response.content[0].text, 'after retry');
  assert.equal(claude.calls[0].mode, 'schema');
  assert.equal(claude.calls[1].mode, 'legacy');
  assert.equal(out.iterations, 1); // retry did not consume an iteration
});

test('onApiError non-retry rethrows', async () => {
  const boom = new Error('fatal');
  const claude = scriptedClaude([boom]);
  await assert.rejects(
    runToolLoop({
      callClaude: claude,
      buildApiParams: () => ({ component: 'x', model: 'm' }),
      messages: [{ role: 'user', content: 'go' }],
      dispatchTool: async () => ({}),
      onApiError: () => undefined,
    }),
    /fatal/,
  );
});

test('API error with no onApiError rethrows', async () => {
  const claude = scriptedClaude([new Error('plain failure')]);
  await assert.rejects(
    runToolLoop({
      callClaude: claude,
      buildApiParams: () => ({ component: 'x', model: 'm' }),
      messages: [{ role: 'user', content: 'go' }],
      dispatchTool: async () => ({}),
    }),
    /plain failure/,
  );
});

test('abort: merges an AbortSignal into requestOptions and forwards caller abort', async () => {
  const claude = scriptedClaude([textResponse('ok')]);
  await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm', requestOptions: { maxRetries: 0 } }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    abort: { timeoutMs: 30_000 },
  });
  assert.equal(claude.calls[0].requestOptions.maxRetries, 0); // caller options preserved
  assert.ok(claude.calls[0].requestOptions.signal instanceof AbortSignal);
  assert.equal(claude.calls[0].requestOptions.signal.aborted, false);

  // Pre-aborted caller signal arrives already aborted
  const ctrl = new AbortController();
  ctrl.abort(new Error('client gone'));
  const claude2 = scriptedClaude([textResponse('ok')]);
  await runToolLoop({
    callClaude: claude2,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    abort: { signal: ctrl.signal, timeoutMs: 30_000 },
  });
  assert.equal(claude2.calls[0].requestOptions.signal.aborted, true);
});

test('abort timeout fires and the loop-created signal aborts', async () => {
  const claude = async (params) => {
    // Simulate a stalled call: resolve only when the signal aborts.
    await new Promise((resolve, reject) => {
      params.requestOptions.signal.addEventListener('abort', () =>
        reject(params.requestOptions.signal.reason), { once: true });
    });
  };
  await assert.rejects(
    runToolLoop({
      callClaude: claude,
      buildApiParams: () => ({ component: 'x', model: 'm' }),
      messages: [{ role: 'user', content: 'go' }],
      dispatchTool: async () => ({}),
      abort: { timeoutMs: 20 },
    }),
    /timed out after 20ms/,
  );
});

test('formatToolResult customizes tool_result content (operator text extraction)', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 't' }], 'r1'),
    textResponse('end', 'r2'),
  ]);
  const out = await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({ content: [{ type: 'text', text: 'pretty text' }], _refund_data: { x: 1 } }),
    formatToolResult: (raw) => raw.content?.[0]?.text || JSON.stringify(raw),
  });
  assert.equal(out.messages[2].content[0].content, 'pretty text');
});

test('buildApiParams called fresh per round with the round index', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 't' }], 'r1'),
    textResponse('end', 'r2'),
  ]);
  const seen = [];
  await runToolLoop({
    callClaude: claude,
    buildApiParams: (i) => { seen.push(i); return { component: 'x', model: 'm' }; },
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
  });
  assert.deepEqual(seen, [0, 1]);
});

test('onResponse receives every response with iteration + duration', async () => {
  const claude = scriptedClaude([
    toolResponse([{ name: 't' }], 'r1'),
    textResponse('end', 'r2'),
  ]);
  const rounds = [];
  await runToolLoop({
    callClaude: claude,
    buildApiParams: () => ({ component: 'x', model: 'm' }),
    messages: [{ role: 'user', content: 'go' }],
    dispatchTool: async () => ({}),
    onResponse: (resp, meta) => rounds.push({ id: resp._ai_call_id, iteration: meta.iteration, hasDuration: typeof meta.durationMs === 'number' }),
  });
  assert.deepEqual(rounds, [
    { id: 'r1', iteration: 0, hasDuration: true },
    { id: 'r2', iteration: 1, hasDuration: true },
  ]);
});
