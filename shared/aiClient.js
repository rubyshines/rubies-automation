/**
 * aiClient.js — the universal AI-call wrapper.
 *
 * Every production AI call (Anthropic Messages, Voyage Embeddings) routes
 * through here so that one row lands in `ai_calls` with model_id, tokens,
 * cost, latency, and tool usage. Switching a model per component becomes a
 * one-line change at the call site.
 *
 *   const { callClaude, embedTexts } = require('../../shared/aiClient');
 *
 *   const result = await callClaude({
 *     component: 'cs_advisor',     // required — string tag (see ai_calls.component)
 *     model: 'claude-opus-4-6',    // required — passed verbatim to the SDK
 *     messages, system, tools, max_tokens, thinking,  // standard SDK params
 *     stream: false,               // true → emits deltas via onText, still returns final message
 *     onText: (t) => {...},        // optional — called per text delta when stream:true
 *     ticket_id, draft_id, parent_call_id,  // optional join/linkage keys
 *     metadata,                    // optional jsonb extras
 *   });
 *   // returns the SDK response object, plus:
 *   //   .text         joined text blocks
 *   //   .tool_calls   array of tool names invoked
 *   //   ._usage       { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }
 *   //   ._timing      { duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls }
 *   //   ._ai_call_id  the inserted ai_calls.id (null if the write no-op'd)
 *
 *   const { vectors, _usage, _timing, _ai_call_id } = await embedTexts({
 *     component: 'kb_embeddings', model: 'voyage-3-lite', texts: [...],
 *   });
 *
 * SAFETY: the tracking write is fail-soft. If the `ai_calls` table does not
 * exist (or any insert error occurs), the wrapper logs a warning and returns
 * normally — a tracking failure MUST NOT break or throw into a production AI
 * path. This mirrors the cs_diagnostic_runs probe in aiAdvisor.runShadowEvaluation.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('./supabaseClient');
const { computeCost } = require('./aiPricing');

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

// ---------------------------------------------------------------------------
// Singleton Anthropic client (shared across all callers)
// ---------------------------------------------------------------------------
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ---------------------------------------------------------------------------
// Fail-soft table existence probe (cached). Mirrors the cs_diagnostic_runs
// pattern: probe once, and if the table is missing, silently skip all writes.
// `null` = not yet probed; true/false = result of the probe.
// ---------------------------------------------------------------------------
let _aiCallsTableExists = null;

async function aiCallsTableExists() {
  if (_aiCallsTableExists !== null) return _aiCallsTableExists;
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('ai_calls').select('id').limit(0);
    _aiCallsTableExists = !error;
  } catch (_) {
    _aiCallsTableExists = false;
  }
  return _aiCallsTableExists;
}

// Test hook — reset the cached probe result.
function _resetTableProbe() {
  _aiCallsTableExists = null;
}

/**
 * Insert one ai_calls row. Fail-soft: returns the inserted id, or null on any
 * failure (missing table, network error, bad column). NEVER throws.
 */
async function recordCall(row) {
  try {
    if (!(await aiCallsTableExists())) return null;
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ai_calls')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.warn('[aiClient] ai_calls insert failed:', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.warn('[aiClient] ai_calls write error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage / response extraction helpers
// ---------------------------------------------------------------------------
function extractUsage(response) {
  const u = response?.usage || {};
  return {
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_creation_tokens: u.cache_creation_input_tokens || 0,
  };
}

function extractTextAndTools(response) {
  const content = response?.content || [];
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
  const tool_calls = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => b.name);
  return { text, tool_calls };
}

// ---------------------------------------------------------------------------
// callClaude — single + streaming Anthropic Messages call
// ---------------------------------------------------------------------------
/**
 * @param {object} params
 *   component, model — required
 *   messages, system, tools, max_tokens, thinking, ...rest — SDK params (pass-through)
 *   stream — when true, uses messages.stream() and resolves on finalMessage()
 *   onText — optional (text:string)=>void, called per text delta in stream mode
 *   ticket_id, draft_id, parent_call_id, metadata — optional tracking fields
 */
async function callClaude(params) {
  const {
    component,
    model,
    stream = false,
    onText,
    ticket_id = null,
    draft_id = null,
    parent_call_id = null,
    metadata = null,
    ...sdkParams
  } = params;

  if (!component) throw new Error('callClaude: component is required');
  if (!model) throw new Error('callClaude: model is required');

  const apiParams = { model, ...sdkParams };
  const startedAt = Date.now();

  let response;
  try {
    if (stream) {
      const s = getAnthropic().messages.stream(apiParams);
      if (typeof onText === 'function') {
        s.on('text', (text) => onText(text));
      }
      response = await s.finalMessage();
    } else {
      response = await getAnthropic().messages.create(apiParams);
    }
  } catch (err) {
    // Error path: record a row (cost 0) then rethrow. Recording is fail-soft.
    const duration_ms = Date.now() - startedAt;
    await recordCall({
      component,
      model_id: model,
      provider: 'anthropic',
      duration_ms,
      cost_usd: 0,
      ticket_id,
      draft_id,
      parent_call_id,
      metadata,
      error: String(err && err.message ? err.message : err).slice(0, 2000),
    });
    throw err;
  }

  const duration_ms = Date.now() - startedAt;
  const usage = extractUsage(response);
  const { text, tool_calls } = extractTextAndTools(response);
  const cost_usd = computeCost(model, usage);

  const _ai_call_id = await recordCall({
    component,
    model_id: model,
    provider: 'anthropic',
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    duration_ms,
    cost_usd,
    tool_calls: tool_calls.length ? tool_calls : null,
    tool_count: tool_calls.length,
    ticket_id,
    draft_id,
    parent_call_id,
    metadata: metadata
      ? { ...metadata, stop_reason: response.stop_reason }
      : { stop_reason: response.stop_reason },
    error: null,
  });

  // _timing mirrors the shape the advisor/operator code already builds per
  // api_call, so migrated call sites can push it straight onto _t.api_calls.
  const _timing = {
    duration_ms,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    tool_calls,
  };

  // Return the SDK response (so existing `.content`, `.stop_reason`, `.usage`
  // handling at call sites keeps working) augmented with our extras. We attach
  // non-enumerable-safe extra fields directly; `response` is a plain object.
  response.text = text;
  response.tool_calls = tool_calls;
  response._usage = usage;
  response._timing = _timing;
  response._ai_call_id = _ai_call_id;
  return response;
}

// ---------------------------------------------------------------------------
// embedTexts — Voyage embeddings (single batch, no chunking — caller chunks)
// ---------------------------------------------------------------------------
/**
 * @param {object} params
 *   component, model — required
 *   texts — array of strings (Voyage allows up to 128 per request)
 *   ticket_id, draft_id, metadata — optional tracking fields
 * @returns {{ vectors, _usage, _timing, _ai_call_id }}
 */
async function embedTexts(params) {
  const {
    component,
    model,
    texts,
    ticket_id = null,
    draft_id = null,
    metadata = null,
  } = params;

  if (!component) throw new Error('embedTexts: component is required');
  if (!model) throw new Error('embedTexts: model is required');
  if (!Array.isArray(texts)) throw new Error('embedTexts: texts must be an array');

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not configured');

  const startedAt = Date.now();

  let data;
  try {
    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Voyage API error ${response.status}: ${errText}`);
    }
    data = await response.json();
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    await recordCall({
      component,
      model_id: model,
      provider: 'voyage',
      duration_ms,
      cost_usd: 0,
      ticket_id,
      draft_id,
      metadata,
      error: String(err && err.message ? err.message : err).slice(0, 2000),
    });
    throw err;
  }

  const duration_ms = Date.now() - startedAt;
  const vectors = data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  // Voyage reports total_tokens; treat it as input_tokens for cost.
  const input_tokens = data.usage?.total_tokens ?? null;
  const usage = {
    input_tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  const cost_usd = computeCost(model, usage);

  const _ai_call_id = await recordCall({
    component,
    model_id: model,
    provider: 'voyage',
    input_tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms,
    cost_usd,
    ticket_id,
    draft_id,
    metadata: metadata ? { ...metadata, text_count: texts.length } : { text_count: texts.length },
    error: null,
  });

  const _usage = usage;
  const _timing = { duration_ms, input_tokens, output_tokens: 0 };

  return { vectors, _usage, _timing, _ai_call_id };
}

module.exports = {
  callClaude,
  embedTexts,
  getAnthropic,
  // test hooks
  _resetTableProbe,
  _extractUsage: extractUsage,
};
