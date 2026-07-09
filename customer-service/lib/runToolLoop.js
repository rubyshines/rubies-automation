/**
 * runToolLoop — the single shared agentic tool-loop engine.
 *
 * Owns ONLY the core shape every RUBIES agent shares:
 *   call model → filter tool_use blocks → dispatch each tool →
 *   append tool_result message → repeat until no tool calls or a cap hits.
 * Plus the two pieces of loop-level plumbing every copy duplicated:
 * best-effort parent_call_id linkage (first call in the loop parents the
 * rest in ai_calls) and per-call abort wiring.
 *
 * Everything divergent stays with the caller, injected via options:
 *   - buildApiParams(iteration): fresh callClaude params per round. Streaming
 *     callbacks (onText) carry per-call state, so they must be rebuilt each
 *     round here — never hoisted. Everything callClaude accepts is legal
 *     (model, system, tools, output_config, requestOptions, stream, onText,
 *     streamStallMs, ticket_id, draft_id, metadata, component, …) EXCEPT
 *     `messages` and `parent_call_id`, which the loop owns.
 *   - dispatchTool(name, input): absorbs the handlers-dict vs executeToolCall
 *     split, plus all pre-dispatch behavior (UI events, audit entries, input
 *     auto-fixes). Throw → the tool_result becomes {"error": message}.
 *   - toolAllowlist: shadow read-only sandbox — tools not in the Set are
 *     recorded but never executed.
 *   - onResponse / onToolResult: timing capture, event emission, result
 *     accumulation.
 *   - onApiError: return 'retry' to re-run the same round after the caller
 *     adjusted state (the advisor's 529/stall → legacy-output-mode flip).
 *     The caller is responsible for making retries terminal (e.g. a mode
 *     flag that can only flip once); the loop does not cap retries.
 *   - abort {signal, timeoutMs}: per-call AbortController. SDK-level
 *     requestOptions.timeout only guards the initial connection; an explicit
 *     controller is the only reliable way to kill a mid-stream stall.
 */

const { callClaude: sharedCallClaude } = require('../../shared/aiClient');

/**
 * @param {object} opts
 * @param {(iteration: number) => object} opts.buildApiParams - Per-round callClaude params (no messages/parent_call_id).
 * @param {Array} opts.messages - Initial conversation messages (not mutated; the loop works on a copy).
 * @param {(name: string, input: object) => Promise<any>} opts.dispatchTool - Execute one tool, return its raw result.
 * @param {number} [opts.maxIterations=10] - Cap on API rounds.
 * @param {number} [opts.maxToolCalls=Infinity] - Cap on total individual tool calls (checked before each round).
 * @param {Set<string>} [opts.toolAllowlist] - When set, tools not in the Set are blocked (shadow sandbox).
 * @param {(raw: any) => string} [opts.formatToolResult] - Raw tool result → tool_result content string. Default JSON.stringify.
 * @param {(response: object, meta: {iteration: number, durationMs: number}) => void} [opts.onResponse]
 * @param {(entry: object, meta: {iteration: number}) => void} [opts.onToolResult]
 *        entry: { tool, input, raw?, content, error?, blocked?, duration_ms }
 * @param {(err: Error, meta: {iteration: number}) => string|undefined} [opts.onApiError] - Return 'retry' to re-run the round; anything else rethrows.
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts.abort] - Per-call AbortController wiring.
 * @param {Function} [opts.callClaude] - Injectable for tests; defaults to shared/aiClient.
 * @returns {Promise<{response: object, messages: Array, iterations: number, toolCallCount: number}>}
 *          response is the LAST API response (its text blocks are the final output).
 *          messages includes tool rounds but NOT the final assistant message (matches
 *          the historical loops — callers append it themselves where needed).
 */
async function runToolLoop({
  buildApiParams,
  messages,
  dispatchTool,
  maxIterations = 10,
  maxToolCalls = Infinity,
  toolAllowlist = null,
  formatToolResult = (raw) => JSON.stringify(raw),
  onResponse = null,
  onToolResult = null,
  onApiError = null,
  abort = null,
  callClaude = sharedCallClaude,
}) {
  let currentMessages = [...messages];
  let response;
  let parentCallId = null;
  let iterations = 0;
  let toolCallCount = 0;

  while (iterations < maxIterations && toolCallCount < maxToolCalls) {
    const _tApi = Date.now();
    const apiParams = buildApiParams(iterations);

    // Per-call abort wiring: hard timeout + forwarded caller signal.
    let requestOptions = apiParams.requestOptions;
    let _callTimer = null;
    let _cleanupFwd = null;
    if (abort) {
      const _callCtrl = new AbortController();
      if (abort.timeoutMs) {
        _callTimer = setTimeout(
          () => _callCtrl.abort(new Error(`API call timed out after ${abort.timeoutMs}ms`)),
          abort.timeoutMs,
        );
      }
      if (abort.signal) {
        if (abort.signal.aborted) {
          _callCtrl.abort(abort.signal.reason);
        } else {
          const _fwd = () => _callCtrl.abort(abort.signal.reason);
          abort.signal.addEventListener('abort', _fwd, { once: true });
          _cleanupFwd = () => abort.signal.removeEventListener('abort', _fwd);
        }
      }
      requestOptions = { ...requestOptions, signal: _callCtrl.signal };
    }

    try {
      response = await callClaude({
        ...apiParams,
        ...(requestOptions ? { requestOptions } : {}),
        messages: currentMessages,
        parent_call_id: parentCallId,
      });
    } catch (err) {
      if (onApiError && onApiError(err, { iteration: iterations }) === 'retry') {
        continue; // caller adjusted state (e.g. output-mode flip); re-run this round
      }
      throw err;
    } finally {
      if (_callTimer) clearTimeout(_callTimer);
      if (_cleanupFwd) _cleanupFwd();
    }

    if (parentCallId === null) parentCallId = response._ai_call_id;
    iterations++;

    if (onResponse) onResponse(response, { iteration: iterations - 1, durationMs: Date.now() - _tApi });

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResultMessages = [];
    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      let content;
      const entry = { tool: toolUse.name, input: toolUse.input };
      const _tTool = Date.now();
      try {
        if (toolAllowlist && !toolAllowlist.has(toolUse.name)) {
          content = JSON.stringify({
            shadow_blocked: true,
            tool: toolUse.name,
            input: toolUse.input,
            message: 'Non-read-only tool blocked in shadow evaluation mode — not executed.',
          });
          entry.blocked = true;
        } else {
          const raw = await dispatchTool(toolUse.name, toolUse.input);
          content = formatToolResult(raw);
          entry.raw = raw;
        }
      } catch (err) {
        content = JSON.stringify({ error: err.message });
        entry.error = err.message;
      }
      entry.content = content;
      entry.duration_ms = Date.now() - _tTool;
      if (onToolResult) onToolResult(entry, { iteration: iterations - 1 });

      toolResultMessages.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content,
      });
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultMessages },
    ];
  }

  return { response, messages: currentMessages, iterations, toolCallCount };
}

module.exports = { runToolLoop };
