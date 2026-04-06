/**
 * Webhook event logging + dead letter queue
 *
 * webhook_events  — short log of every webhook processed (success or failure)
 * webhook_dead_letter — failed payloads stored for retry
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

/**
 * Log a webhook event (fire-and-forget, swallows errors)
 */
async function logEvent(source, topic, payloadId, status, processingMs, errorMessage) {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('webhook_events').insert({
      source,
      topic,
      payload_id: payloadId || null,
      status,
      processing_ms: processingMs || null,
      error_message: errorMessage || null,
    });
  } catch (err) {
    console.error('[dead-letter] Failed to log webhook event:', err.message);
  }
}

/**
 * Enqueue a failed webhook payload for later retry
 */
async function enqueueDeadLetter(source, topic, payload, errorMessage) {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('webhook_dead_letter').insert({
      source,
      topic,
      payload,
      error_message: errorMessage || null,
    });
    console.log(`[dead-letter] Enqueued ${source}/${topic} for retry`);
  } catch (err) {
    console.error('[dead-letter] Failed to enqueue dead letter:', err.message);
  }
}

/**
 * List pending dead letter entries
 */
async function listPending(limit = 50) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('webhook_dead_letter')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

/**
 * Delete a dead letter entry after successful retry
 */
async function removeDlqEntry(id) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('webhook_dead_letter')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

module.exports = { logEvent, enqueueDeadLetter, listPending, removeDlqEntry };
