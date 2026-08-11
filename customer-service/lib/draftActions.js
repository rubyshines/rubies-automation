/**
 * cs_ai_drafts.actions[] — the append-only record of operator actions that
 * actually executed. This module owns both sides of that column: the atomic
 * append below, and the ticket-level read helpers at the bottom.
 *
 * The read helpers exist because completed work is filed on whichever draft row
 * was active when it executed, and every customer reply creates a fresh draft
 * row with an empty actions[]. So any consumer asking "what has already been
 * done on this ticket?" must union across ALL the ticket's drafts — a single
 * draft is blind to prior turns.
 */

/**
 * Append an entry to cs_ai_drafts.actions[] atomically.
 *
 * Uses the append_draft_action RPC (one UPDATE — concurrent writers can't
 * lose each other's entries; see migrations-2026-07-08-append-draft-action.sql).
 * Falls back to read-modify-write if the RPC isn't installed yet, so the
 * entry is never lost outright pre-migration — the fallback just carries the
 * original (small) race window.
 *
 * Returns { atomic, error? } — error is set only when BOTH paths failed.
 */
async function appendDraftAction(supabase, draftId, action) {
  const { error: rpcErr } = await supabase.rpc('append_draft_action', {
    p_draft_id: draftId,
    p_action: action,
  });
  if (!rpcErr) return { atomic: true };

  const { data: row } = await supabase
    .from('cs_ai_drafts')
    .select('actions')
    .eq('id', draftId)
    .maybeSingle();
  const next = [...(Array.isArray(row?.actions) ? row.actions : []), action];
  const { error: updErr } = await supabase
    .from('cs_ai_drafts')
    .update({ actions: next })
    .eq('id', draftId);
  if (updErr) return { atomic: false, error: `rpc: ${rpcErr.message}; fallback: ${updErr.message}` };
  console.warn(`[draftActions] append_draft_action RPC unavailable (${rpcErr.message}) — used non-atomic fallback for draft ${draftId}. Apply migrations-2026-07-08-append-draft-action.sql.`);
  return { atomic: false };
}

/**
 * Union completed operator actions across all of a ticket's drafts, oldest
 * first. See the module header for why a single draft is never enough. Pure.
 */
function unionTicketActions(drafts) {
  return (drafts || [])
    .flatMap(d => (Array.isArray(d?.actions) ? d.actions : []))
    .filter(Boolean)
    .sort((x, y) => new Date(x.executed_at || 0) - new Date(y.executed_at || 0));
}

/**
 * Render a ticket's completed actions as one line each, for injection into an
 * agent prompt. Shared by the operator agent (which must not repeat an action)
 * and the advisor's intake context (which must not re-propose one). Returns
 * null when there is nothing to show, so callers can omit the whole block.
 *
 * `summary` is the executing agent's full turn narrative, so only its first
 * line is kept — the rest is links and formatting the reader doesn't need.
 * That first line is also where the outcome marker lives (✅ / "failed" /
 * "Awaiting Confirmation"), which matters because this log records action
 * ATTEMPTS: a failed tool call is filed too, and a turn that completed one
 * write while previewing another files the preview text. Consumers must frame
 * the block as attempts-with-outcomes, not as guaranteed successes. Pure.
 */
function formatCompletedActions(actions, { summaryChars = 120 } = {}) {
  const list = unionTicketActions([{ actions }]);
  if (!list.length) return null;
  return list.map(a => {
    const day = a.executed_at ? ` (${String(a.executed_at).slice(0, 10)})` : '';
    const summary = a.summary ? `: ${a.summary.split('\n')[0].slice(0, summaryChars)}` : '';
    return `  - ${a.action_type}${day}${summary}`;
  }).join('\n');
}

module.exports = { appendDraftAction, unionTicketActions, formatCompletedActions };
