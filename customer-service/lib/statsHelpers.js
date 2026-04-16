/**
 * Pure helper functions for CS advisor performance analytics.
 * Extracted from dashboard server for testability.
 */

function dayBounds(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return { start: `${d}T00:00:00Z`, end: `${d}T23:59:59.999Z`, date: d };
}

function classifyFeedback(rows) {
  let noEdit = 0, edited = 0, released = 0, closedNoReply = 0, spam = 0, deleted = 0;
  for (const r of rows) {
    if (r.action === 'released') released++;
    else if (r.action === 'closed_no_reply') closedNoReply++;
    else if (r.action === 'spam') spam++;
    else if (r.action === 'deleted') deleted++;
    else if (r.action?.startsWith('edited_')) edited++;
    else if (r.action?.startsWith('sent_')) noEdit++;
  }
  return { noEdit, edited, released, closedNoReply, spam, deleted };
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) + '%' : 'N/A';
}

/**
 * Classify a single feedback action into an outcome string.
 */
function classifyOutcome(action, redirectCount) {
  if (redirectCount > 0) return 'redirected';
  if (action === 'released') return 'released';
  if (action === 'closed_no_reply') return 'closed_no_reply';
  if (action === 'spam') return 'spam';
  if (action === 'deleted') return 'deleted';
  if (action?.startsWith('edited_')) return 'edited';
  if (action?.startsWith('sent_')) return 'no_edit';
  return 'unknown';
}

module.exports = { dayBounds, classifyFeedback, pct, classifyOutcome };
