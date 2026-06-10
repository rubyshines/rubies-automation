/**
 * feedbackSignals.js — builds cs_ai_feedback_log rows for every send path.
 *
 * The feedback log is the training-signal ledger: one row per outbound message,
 * carrying what the AI proposed vs what actually went out. Three send paths:
 *
 *   1. Draft send (apiSendDraft)        → action 'sent_*' | 'edited_*'
 *   2. Manual send, draft existed       → action 'bypassed_*'  (strongest negative signal:
 *      (apiSendTicketMessage)             the operator ignored the draft entirely)
 *   3. Manual send, no draft            → action 'manual_*'
 *
 * Steer capture: operator_steer + regen_count ride along on every row so
 * "how much steering did this ticket need" is queryable without joining drafts.
 *
 * Pure functions — callers own the inserts.
 */

/** Normalize for "was it edited" comparison (whitespace-insensitive). */
function normalizeForCompare(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Row for a draft-based send (path 1).
 * @param {object} draft        full cs_ai_drafts row (select *)
 * @param {string} finalResponse what was actually sent
 * @param {object} opts         { originalResponse, afterAction, notes }
 *   originalResponse: the FIRST pre-steer draft for the ticket (caller looks it up)
 */
function buildSendFeedbackRow(draft, finalResponse, { originalResponse, afterAction, notes } = {}) {
  const original = originalResponse != null ? originalResponse : draft.draft_response;
  const wasEdited =
    normalizeForCompare(draft.draft_response) !== normalizeForCompare(finalResponse) ||
    normalizeForCompare(original) !== normalizeForCompare(draft.draft_response);
  const baseAction = wasEdited ? 'edited' : 'sent';
  return {
    draft_id: draft.id,
    gorgias_ticket_id: draft.gorgias_ticket_id,
    action: `${baseAction}_${afterAction || 'snooze'}`,
    original_response: original,
    final_response: finalResponse,
    feedback_notes: notes || null,
    advisor_status: draft.advisor_status,
    confidence: draft.confidence,
    message_type: draft.message_type,
    turn_number: draft.turn_number,
    operator_steer: draft.operator_steer || null,
    regen_count: Array.isArray(draft.draft_history) ? draft.draft_history.length : 0,
  };
}

/**
 * Row for a manual send (paths 2 and 3).
 * @param {object} params
 *   activeDraft  cs_ai_drafts row the operator bypassed, or null if none existed
 *   manualDraftId id of the lightweight manual_send draft row (path 3), or null
 *   gorgiasTicketId
 *   message      what the operator typed and sent
 *   afterAction  'snooze' | 'close' | 'onme'
 */
function buildManualSendFeedbackRow({ activeDraft, manualDraftId, gorgiasTicketId, message, afterAction } = {}) {
  const bypassed = !!activeDraft;
  return {
    draft_id: bypassed ? activeDraft.id : manualDraftId || null,
    gorgias_ticket_id: gorgiasTicketId,
    action: `${bypassed ? 'bypassed' : 'manual'}_${afterAction || 'snooze'}`,
    original_response: bypassed ? activeDraft.draft_response : '',
    final_response: message,
    feedback_notes: null,
    advisor_status: bypassed ? activeDraft.advisor_status : null,
    confidence: bypassed ? activeDraft.confidence : null,
    message_type: bypassed ? activeDraft.message_type : null,
    turn_number: bypassed ? activeDraft.turn_number : null,
    operator_steer: bypassed ? activeDraft.operator_steer || null : null,
    regen_count: bypassed && Array.isArray(activeDraft.draft_history) ? activeDraft.draft_history.length : 0,
  };
}

module.exports = { buildSendFeedbackRow, buildManualSendFeedbackRow, normalizeForCompare };
