/**
 * autosendGate.js — eligibility gate for auto-send (#4), shadow phase.
 *
 * Decides whether an advisor draft COULD be sent without operator review.
 * In shadow mode nothing is sent — eligible drafts are marked
 * auto_close_path='autosend_shadow' at intake so Jamie can audit what WOULD
 * have gone out (Closed-tab filter + daily digest line) before any category
 * goes live.
 *
 * Two layers, deliberately redundant:
 *   1. NEVER list — hardcoded here, not configurable. Anything that moves
 *      money, creates orders, or carries an action is never eligible, even if
 *      someone flips every flag in the database.
 *   2. Allowlist — system_flags, one boolean per category
 *      (`autosend_cat_<message_type>`), plus the master `autosend_shadow`
 *      switch. Jamie promotes categories one at a time; flags are visible in
 *      one table and flip everywhere within ~60s (systemFlags cache TTL).
 *
 * Qualification data comes from the closeness judge (cs_draft_judgments):
 * a category qualifies at <~3% substantive divergence over 30+ sends.
 * First candidate per the 90-day baseline: 'closing' (97% clean).
 */
const { isFlagEnabled } = require('../../shared/systemFlags');

// Categories that may NEVER auto-send regardless of flags: they move money,
// create orders, or are too high-stakes to leave unreviewed.
const NEVER_TYPES = new Set([
  'exchange', 'refund', 'free_order', 'discount_request', 'defect',
  'wrong_item', 'uncategorized', 'unknown',
]);

const MASTER_FLAG = 'autosend_shadow';
const CATEGORY_FLAG_PREFIX = 'autosend_cat_';

/**
 * Pure eligibility check — no flags, no IO. Returns { eligible, reason }.
 * @param {object} p { structured, draftResponse, messageType }
 */
function evaluateAutosend({ structured, draftResponse, messageType } = {}) {
  const fail = (reason) => ({ eligible: false, reason });

  if (!structured) return fail('no structured output');
  if (structured.status !== 'ready') return fail(`status ${structured.status} (needs ready)`);
  if (!messageType) return fail('no message_type');
  if (NEVER_TYPES.has(messageType)) return fail(`'${messageType}' is on the never-list`);

  // Any action of any kind → operator territory.
  if (structured.action_type) return fail(`carries action_type ${structured.action_type}`);
  if (structured.operator_action_summary) return fail('has operator_action_summary');
  if (structured.discount_code) return fail('carries a discount code');

  const draft = (draftResponse || '').trim();
  if (!draft) return fail('empty draft');
  if (draft.startsWith('[AI could not draft')) return fail('route-to-human placeholder draft');
  if (/\[CODE\]|\[NAME\]|\[ORDER\]/i.test(draft)) return fail('draft contains operator placeholders');

  return { eligible: true, reason: 'passes pure checks' };
}

/**
 * Full shadow-mark decision: master flag + pure checks + per-category flag +
 * confidence. Fail-soft: any flag-read problem returns ineligible.
 * @param {object} p { structured, draftResponse, messageType, confidence }
 */
async function shouldShadowMark({ structured, draftResponse, messageType, confidence } = {}) {
  try {
    if (!(await isFlagEnabled(MASTER_FLAG))) return { eligible: false, reason: 'shadow mode off' };
  } catch (_) {
    return { eligible: false, reason: 'flag read failed' };
  }

  if (confidence !== 'high') return { eligible: false, reason: `confidence ${confidence} (needs high)` };

  const pure = evaluateAutosend({ structured, draftResponse, messageType });
  if (!pure.eligible) return pure;

  try {
    if (!(await isFlagEnabled(CATEGORY_FLAG_PREFIX + messageType))) {
      return { eligible: false, reason: `category '${messageType}' not allowlisted` };
    }
  } catch (_) {
    return { eligible: false, reason: 'flag read failed' };
  }

  return { eligible: true, reason: `'${messageType}' allowlisted + all checks pass` };
}

module.exports = { evaluateAutosend, shouldShadowMark, NEVER_TYPES, MASTER_FLAG, CATEGORY_FLAG_PREFIX };
