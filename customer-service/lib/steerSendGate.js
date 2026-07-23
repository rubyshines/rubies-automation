/**
 * steerSendGate.js — shadow gate for one-click "Steer & Send".
 *
 * Question being measured: after the operator steers a redraft, could the
 * regenerated draft have been sent without the final review glance? In shadow
 * mode nothing sends — every steered regen gets a would_send verdict recorded
 * to `steer_send_shadow`, and the daily digest cross-references the closeness
 * judge on gate-passed drafts (would-have-erred = the go/no-go evidence, same
 * playbook as autosendGate).
 *
 * Two layers, mirroring autosendGate:
 *   1. Deterministic checks (pure, unit-tested): never-list categories, any
 *      proposed action, action changed by the steer, placeholders, non-ready
 *      status. Failing here records the verdict WITHOUT a model call.
 *   2. Opus verifier — no ground truth exists pre-send, so this is a
 *      correctness check, not a closeness check: did the draft implement the
 *      steer, and does it avoid claims the conversation/tool context can't
 *      support? (May 2026 deviance analysis: advisor confidence doesn't
 *      predict edits; a correctness verifier is the viable autonomy gate.)
 *
 * Writes are fail-soft: a missing table or insert error logs and no-ops so
 * the production steer path is never at risk.
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { isFlagEnabled } = require('../../shared/systemFlags');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { NEVER_TYPES } = require('./autosendGate');

const FLAG = 'steersend_shadow';

/**
 * Pure deterministic eligibility — no flags, no IO. Returns
 * { eligible, reason, action_changed }.
 * @param {object} p { steer, structured, prevStructured, draftResponse, messageType }
 */
function evaluateSteerSendPure({ steer, structured, prevStructured, draftResponse, messageType } = {}) {
  const prevAction = prevStructured?.action_type || null;
  const newAction = structured?.action_type || null;
  const actionChanged = prevAction !== newAction;
  const fail = (reason) => ({ eligible: false, reason, action_changed: actionChanged });

  if (!steer || !String(steer).trim()) return fail('no steer text');
  if (!structured) return fail('no structured output');
  if (structured.status !== 'ready') return fail(`status ${structured.status} (needs ready)`);
  if (!messageType) return fail('no message_type');
  if (NEVER_TYPES.has(messageType)) return fail(`'${messageType}' is on the never-list`);

  // Prose-only scope: any proposed action on the steered draft is operator
  // territory (Execute & Send already owns confirmed action flows), and a
  // steer that CHANGES the action is the highest-risk case of all.
  if (newAction) return fail(`carries action_type ${newAction}`);
  if (actionChanged) return fail(`steer changed action_type (${prevAction} → ${newAction})`);
  if (structured.operator_action_summary) return fail('has operator_action_summary');
  if (structured.discount_code) return fail('carries a discount code');

  const draft = (draftResponse || '').trim();
  if (!draft) return fail('empty draft');
  if (draft.startsWith('[AI could not draft')) return fail('route-to-human placeholder draft');
  if (/\[CODE\]|\[NAME\]|\[ORDER\]/i.test(draft)) return fail('draft contains operator placeholders');

  return { eligible: true, reason: 'passes pure checks', action_changed: actionChanged };
}

/**
 * Opus verifier — correctness check on a pure-eligible steered draft.
 * Returns { would_send, concerns } (fail-closed on any error/parse problem).
 */
async function runVerifier({ steer, draftResponse, conversationContext, ticketId, draftId }) {
  const prompt = [
    'You are a pre-send verifier for a customer service draft. The operator gave a steering instruction and the AI regenerated the draft. Decide whether this draft could be sent to the customer WITHOUT the operator reading it again.',
    '',
    'Approve (would_send=true) ONLY if ALL of these hold:',
    '1. The draft implements the operator\'s steer — what they asked for is reflected, and nothing they asked to remove remains.',
    '2. Every factual claim in the draft (prices, dates, policies, order state, product facts) is supported by the conversation context below. A claim the context cannot support is an automatic reject, even if plausible.',
    '3. The draft does not add unrequested extras: no new offers, promises, policy statements, or explanations beyond what the steer and the customer\'s question require.',
    '4. The draft is a complete, sendable customer email (no placeholders, no operator-facing notes, no meta-commentary).',
    'When uncertain on any point, reject. A wrong approval sends a bad email; a wrong rejection only costs a review glance.',
    '',
    `[OPERATOR STEER]\n${steer}`,
    '',
    `[CONVERSATION CONTEXT]\n${(conversationContext || '(none provided)').slice(0, 12000)}`,
    '',
    `[REGENERATED DRAFT]\n${draftResponse}`,
    '',
    'Reply with ONLY a JSON object: {"would_send": boolean, "concerns": ["short reason", ...]} — concerns empty when approving.',
  ].join('\n');

  const resp = await callClaude({
    component: 'steersend_gate',
    model: MODELS.OPUS,
    max_tokens: 500,
    ticket_id: ticketId || null,
    draft_id: draftId || null,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { would_send: false, concerns: ['verifier output unparseable'] };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      would_send: parsed.would_send === true,
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
    };
  } catch (_) {
    return { would_send: false, concerns: ['verifier output unparseable'] };
  }
}

/**
 * Full shadow run: flag check → pure checks → (if pure-pass) Opus verifier →
 * record verdict row. Never throws; call fire-and-forget from the steer path.
 */
async function runSteerSendShadow({
  steer, structured, prevStructured, draftResponse, messageType,
  conversationContext, draftId, gorgiasTicketId,
} = {}) {
  try {
    if (!(await isFlagEnabled(FLAG))) return null;

    const pure = evaluateSteerSendPure({ steer, structured, prevStructured, draftResponse, messageType });

    let wouldSend = false;
    let reason = pure.reason;
    let verifier = null;
    if (pure.eligible) {
      verifier = await runVerifier({ steer, draftResponse, conversationContext, ticketId: gorgiasTicketId, draftId });
      wouldSend = verifier.would_send;
      reason = wouldSend ? 'verifier approved' : `verifier rejected: ${verifier.concerns.join('; ') || 'no reason given'}`;
    }

    const row = {
      draft_id: draftId || null,
      gorgias_ticket_id: gorgiasTicketId || null,
      steer: String(steer || ''),
      message_type: messageType || null,
      would_send: wouldSend,
      reason,
      pure_eligible: pure.eligible,
      action_changed: pure.action_changed,
      verifier,
      draft_snapshot: draftResponse || null,
    };

    const { error } = await getSupabaseClient().from('steer_send_shadow').insert(row);
    if (error) {
      // Fail-soft (table may not exist yet) — never disturb the steer path.
      console.warn(`[steersend] verdict insert failed: ${error.message}`);
      return null;
    }
    console.log(`[steersend] draft ${draftId}: would_send=${wouldSend} (${reason})`);
    return row;
  } catch (err) {
    console.warn(`[steersend] shadow run failed: ${err.message}`);
    return null;
  }
}

module.exports = { evaluateSteerSendPure, runVerifier, runSteerSendShadow, FLAG };
