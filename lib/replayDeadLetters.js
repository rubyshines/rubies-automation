/**
 * Dead-letter replay — retry Gorgias intake webhooks that failed and would
 * otherwise be silently lost.
 *
 * When a Gorgias ticket-message webhook throws during processing, the raw
 * payload is parked in `webhook_dead_letter` (webhooks/lib/deadLetter.js).
 * Nothing ever retried these, so a genuine customer message that failed intake
 * (e.g. a transient error mid-draft) just vanished — the only trace was the
 * reconciler later flagging it as drift. This pass re-runs recent Gorgias
 * dead-letters through the real webhook handler: success deletes the entry,
 * failure bumps its retry counter so it surfaces in the digest as still-stuck.
 *
 * A staleness window (default 7 days) keeps us from drafting replies to
 * long-resolved tickets if an ancient payload is sitting in the queue.
 */

const { getSupabaseClient } = require('../shared/supabaseClient');
const { listPending, removeDlqEntry } = require('../webhooks/lib/deadLetter');

/**
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=7]  skip dead-letters older than this
 * @param {number} [opts.limit=50]      cap how many we replay per run
 * @param {Date}   [opts.now]           injectable clock (tests)
 * @param {Function} [opts.handler]     injectable webhook handler (tests)
 * @param {object} [opts.supabase]      injectable client (tests)
 * @param {Function} [opts.listFn]      injectable listPending (tests)
 * @param {Function} [opts.removeFn]    injectable removeDlqEntry (tests)
 */
async function replayGorgiasDeadLetters({
  maxAgeDays = 7,
  limit = 50,
  now = new Date(),
  handler,
  supabase = getSupabaseClient(),
  listFn = listPending,
  removeFn = removeDlqEntry,
} = {}) {
  const handle = handler || require('../webhooks/handlers/gorgiasTickets').handle;
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

  const pending = (await listFn(200)) || [];
  const gorgias = pending.filter(d => d.source === 'gorgias');
  const fresh = gorgias.filter(d => new Date(d.created_at) >= cutoff);
  const staleSkipped = gorgias.length - fresh.length;

  const recovered = [];
  const stillFailing = [];

  for (const entry of fresh.slice(0, limit)) {
    const ticketId = entry.payload?.ticket?.id || null;
    try {
      await handle(entry.payload);
      await removeFn(entry.id);
      recovered.push({ id: entry.id, ticketId });
    } catch (e) {
      try {
        await supabase
          .from('webhook_dead_letter')
          .update({ retry_count: (entry.retry_count || 0) + 1, last_retry_at: now.toISOString() })
          .eq('id', entry.id);
      } catch (_) { /* best-effort bookkeeping */ }
      stillFailing.push({ id: entry.id, ticketId, error: e.message });
    }
  }

  return { recovered, stillFailing, staleSkipped, totalGorgias: gorgias.length };
}

/** Pipeline wrapper for daily-sync-all.js. */
async function run() {
  try {
    const r = await replayGorgiasDeadLetters();
    const detailParts = [];
    if (r.recovered.length) detailParts.push(`${r.recovered.length} recovered`);
    if (r.stillFailing.length) detailParts.push(`${r.stillFailing.length} still failing`);
    if (r.staleSkipped) detailParts.push(`${r.staleSkipped} stale skipped`);
    if (!detailParts.length) detailParts.push('queue clear');

    return {
      sources: {
        deadletter_replay: {
          success: true,
          rowsWritten: r.recovered.length,
          detail: detailParts.join(', '),
          recovered: r.recovered,
          stillFailing: r.stillFailing,
          staleSkipped: r.staleSkipped,
        },
      },
      status: r.stillFailing.length ? 'warning' : 'ok',
    };
  } catch (e) {
    console.error('Dead-letter replay error:', e.message);
    return {
      sources: { deadletter_replay: { success: false, rowsWritten: 0, error: e.message } },
      status: 'error',
    };
  }
}

module.exports = { replayGorgiasDeadLetters, run };
