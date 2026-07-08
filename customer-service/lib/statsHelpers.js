/**
 * Pure helper functions for CS advisor performance analytics.
 * Extracted from dashboard server for testability.
 *
 * classifyOutcome is the SINGLE source of truth for "what does this
 * cs_ai_feedback_log.action mean" — classifyFeedback and the dashboard stats
 * endpoints all derive from it. Don't re-encode action-string logic elsewhere.
 */

function dayBounds(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return { start: `${d}T00:00:00Z`, end: `${d}T23:59:59.999Z`, date: d };
}

/**
 * Classify a single feedback action into an outcome string.
 *
 * Action vocabulary (writers in parentheses):
 *   sent_<after> / sent          — unedited advisor send (dashboard, csAdmin)
 *   edited_<after>               — edited advisor send (dashboard)
 *   bypassed_<after> / bypassed  — operator replied in Gorgias over a live
 *                                  draft (feedbackSignals, detect_bypasses)
 *   manual_<after> / manual_backfilled — operator reply with no draft
 *   auto_close_thank_you         — intake auto-close fast path
 *   auto_follow_up_stage1/2      — snooze-expiry follow-up engine
 *   released / closed_no_reply / spam / deleted / returned_to_inbox
 */
function classifyOutcome(action, redirectCount) {
  if (redirectCount > 0) return 'redirected';
  if (action === 'released') return 'released';
  if (action === 'closed_no_reply') return 'closed_no_reply';
  if (action === 'spam') return 'spam';
  if (action === 'deleted') return 'deleted';
  if (action === 'returned_to_inbox') return 'returned_to_inbox';
  if (action?.startsWith('auto_close')) return 'auto_closed';
  if (action?.startsWith('auto_follow_up')) return 'auto_follow_up';
  if (action === 'bypassed' || action?.startsWith('bypassed_')) return 'bypassed';
  if (action === 'manual_backfilled' || action?.startsWith('manual_')) return 'manual';
  if (action?.startsWith('edited_')) return 'edited';
  if (action === 'sent' || action?.startsWith('sent_')) return 'no_edit';
  return 'unknown';
}

// outcome string → classifyFeedback counter key
const OUTCOME_COUNTER = {
  no_edit: 'noEdit',
  edited: 'edited',
  released: 'released',
  closed_no_reply: 'closedNoReply',
  spam: 'spam',
  deleted: 'deleted',
  bypassed: 'bypassed',
  manual: 'manual',
  auto_closed: 'autoClosed',
  auto_follow_up: 'autoFollowUp',
  returned_to_inbox: 'returnedToInbox',
  unknown: 'unknown',
};

function classifyFeedback(rows) {
  const counts = {
    noEdit: 0, edited: 0, released: 0, closedNoReply: 0, spam: 0, deleted: 0,
    bypassed: 0, manual: 0, autoClosed: 0, autoFollowUp: 0, returnedToInbox: 0,
    unknown: 0,
  };
  for (const r of rows) {
    const key = OUTCOME_COUNTER[classifyOutcome(r.action, 0)] || 'unknown';
    counts[key]++;
  }
  return counts;
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) + '%' : 'N/A';
}

module.exports = { dayBounds, classifyFeedback, pct, classifyOutcome };
