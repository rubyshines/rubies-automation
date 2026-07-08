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

module.exports = { appendDraftAction };
