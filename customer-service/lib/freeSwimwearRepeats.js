/**
 * Free Swimwear — repeat / duplicate applicant handling (intake-time).
 *
 * People apply more than once, and the same email is reused for genuinely
 * different recipients (siblings, parent + child). We must handle repeats
 * without (a) creating duplicate queue entries, (b) silently dropping people,
 * or (c) wrongly merging two different children.
 *
 * Two pieces, mirroring the freeSwimwear.js split (AI vs pure decision):
 *   - classifySameRecipient(): an Opus call that decides which prior
 *     applications on the same email are for the SAME recipient. Recipient
 *     identity is fuzzy (the name field is sometimes the parent, sometimes the
 *     child; ages drift year to year), so this is an AI judgment, per the
 *     AI-first principle. Conservative: when unsure it returns "different", so
 *     we never merge two real children.
 *   - decideRepeat(): a PURE function that, given the same-recipient priors,
 *     returns the disposition + the columns to write. Unit-testable with no I/O.
 *
 * Person identity = (email, recipient). One ACTIVE application per recipient per
 * year (the window counts from the LAST application, regardless of its outcome).
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A same-day resubmit / correction. Wider than a literal calendar day so a
// late-night-then-after-midnight correction still collapses instead of emailing
// a "reapply next year" notice (the observed cases are 1-2h apart).
const COLLAPSE_HOURS = 24;
// One active application per recipient per year, measured from the last one.
const WINDOW_DAYS = 365;

// Prior statuses that count as a real application for the repeat window. A
// silently-rejected prior (Brazil / not-trans) or a collapsed duplicate is NOT
// an application we acted on, so it neither triggers a reapply email nor resets
// the window.
const COUNTABLE_PRIOR_STATUSES = new Set([
  'new', 'approved', 'accepted', 'registered', 'ordered', 'expired', 'expired-final', 'repeat',
]);

function isCountablePrior(row) {
  return COUNTABLE_PRIOR_STATUSES.has(row.status);
}

function clip(s, n = 240) {
  const t = (s || '').toString().trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Decide which prior applications are for the SAME recipient as a new one.
 * @param {Object} newRow - the incoming application
 * @param {Array} priorRows - prior applications on the same email (countable)
 * @returns {Promise<{same: Array, reasoning: string}>} same = subset of priorRows
 *   judged same-recipient (object references from priorRows).
 */
async function classifySameRecipient(newRow, priorRows) {
  if (!priorRows.length) return { same: [], reasoning: 'no priors' };

  const priorLines = priorRows.map((p, i) =>
    `[${i + 1}] name: ${p.applicant_name || '(none)'} | age: ${p.recipient_age || '?'} | submitted: ${(p.submitted_at || '').slice(0, 10)} | situation: ${clip(p.situation, 160) || '(none)'} | why: ${clip(p.why, 160) || '(none)'}`
  ).join('\n');

  const prompt = `You are matching free-swimwear applications to decide whether they are for the SAME recipient (the child who would receive the swimwear) or DIFFERENT recipients (e.g. siblings, or a parent and a child) submitted from the same email address.

Names are entered inconsistently (sometimes the parent's name, sometimes the child's) and ages drift year to year, so judge holistically from name, age, and the situation/why text. When you are NOT confident two applications are for the same child, treat them as DIFFERENT (it is much worse to merge two real siblings than to flag a repeat for human review).

NEW application:
- name: ${newRow.applicant_name || '(none)'}
- age: ${newRow.recipient_age || '?'}
- situation: ${clip(newRow.situation) || '(none)'}
- why: ${clip(newRow.why) || '(none)'}

PRIOR applications on the same email:
${priorLines}

Return ONLY JSON, no prose: {"same_recipient":[<prior numbers that are the SAME recipient as the NEW application>],"reasoning":"<one short sentence>"}`;

  let parsed = null;
  try {
    const response = await callClaude({
      component: 'free_swimwear_recipient_match',
      model: MODELS.OPUS,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (response.content[0]?.text || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (_) {
    parsed = null;
  }

  // Fail conservative: on any parse/AI failure, treat ALL priors as different
  // (→ the new row becomes an active application flagged for human review),
  // rather than risk merging or wrongly closing someone.
  if (!parsed || !Array.isArray(parsed.same_recipient)) {
    return { same: [], reasoning: 'classification unavailable — treated as different (flag for review)' };
  }

  const same = parsed.same_recipient
    .map(n => priorRows[Number(n) - 1])
    .filter(Boolean);
  return { same, reasoning: (parsed.reasoning || '').toString().slice(0, 200) };
}

/**
 * Pure repeat decision. No I/O.
 *
 * @param {Object} params
 * @param {Object} params.newRow - incoming application (submitted_at, …)
 * @param {Array}  params.samePriorRows - priors judged SAME recipient (countable)
 * @param {boolean} params.hadAnyPrior - the email has ANY prior countable application
 * @param {Date}   [params.now]
 * @returns {{disposition:'new'|'repeat'|'duplicate', patch:Object, supersede:?Object, reapplyAfter:?string}}
 *   - disposition 'new'      → active application; patch may add badge data or a
 *                              possible_second_child flag. supersede may name a
 *                              same-day prior to close as 'duplicate'.
 *   - disposition 'repeat'   → close the NEW row as 'repeat' and email a
 *                              reapply-after notice (reapplyAfter is set).
 *   - disposition 'duplicate'→ close the NEW row silently as 'duplicate'.
 *   - patch       → columns to write on the NEW row.
 *   - supersede   → a prior row to close as 'duplicate' (same-day collapse), or null.
 *   - reapplyAfter→ ISO instant the family may reapply after (disposition 'repeat').
 */
function decideRepeat({ newRow, samePriorRows = [], hadAnyPrior = false, now = new Date() }) {
  // No same-recipient prior. If the email had OTHER applications, this is likely
  // a second child — keep it active but flag for human review. Otherwise it's a
  // clean new applicant.
  if (!samePriorRows.length) {
    const patch = hadAnyPrior ? { possible_second_child: true } : {};
    return { disposition: 'new', patch, supersede: null, reapplyAfter: null };
  }

  const newMs = newRow.submitted_at ? new Date(newRow.submitted_at).getTime() : now.getTime();
  const sorted = [...samePriorRows].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  const last = sorted[0];
  const lastMs = new Date(last.submitted_at).getTime();
  const gapMs = newMs - lastMs;

  // Badge data: when did this recipient last apply, and did they ever receive?
  const reachedOrdered = samePriorRows.some(p => p.status === 'ordered');
  const badge = {
    prior_application_at: last.submitted_at,
    prior_status: reachedOrdered ? 'ordered' : last.status,
  };

  // Same-day resubmit / correction → collapse to one, keep the newest, silently.
  // If the prior is still open and has no code, supersede it (close it as a
  // duplicate) and keep this new row active. If the prior already has a code
  // (already being helped), close THIS row instead, so we never orphan an
  // issued code.
  if (gapMs <= COLLAPSE_HOURS * HOUR) {
    if (last.status === 'new' && !last.discount_code) {
      return { disposition: 'new', patch: {}, supersede: last, reapplyAfter: null };
    }
    return { disposition: 'duplicate', patch: badge, supersede: null, reapplyAfter: null };
  }

  // Too-soon repeat (within a year of the last application, any outcome): do not
  // add an active queue item — close as 'repeat' and email a reapply notice.
  if (gapMs < WINDOW_DAYS * DAY) {
    const reapplyAfter = new Date(lastMs + WINDOW_DAYS * DAY).toISOString();
    return { disposition: 'repeat', patch: { ...badge, reapply_after: reapplyAfter }, supersede: null, reapplyAfter };
  }

  // More than a year on: allowed. Active application, badged as a returning family.
  return { disposition: 'new', patch: badge, supersede: null, reapplyAfter: null };
}

module.exports = {
  classifySameRecipient,
  decideRepeat,
  isCountablePrior,
  COUNTABLE_PRIOR_STATUSES,
  COLLAPSE_HOURS,
  WINDOW_DAYS,
};
