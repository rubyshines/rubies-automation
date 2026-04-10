/**
 * Gmail Push Notification Handler
 *
 * Receives Pub/Sub notifications when new email arrives in Gmail.
 * Fetches the new messages, classifies them, and routes:
 * - customer_support → Gorgias ticket
 * - spam/auto_reply/newsletter → label + archive
 *
 * Uses Gmail History API to get only the new messages since the last
 * known historyId, then delegates to processGmailCs for routing.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient, upsert } = require('../../shared/supabaseClient');
const { getGmail } = require('../../email-intelligence/lib/gmailClient');
const { fetchMessage } = require('../../email-intelligence/lib/gmailSync');
const { classifyMessages } = require('../../email-intelligence/lib/classifier');
const { processMessage } = require('../../customer-service/intake/processGmailCs');
const { getOrCreateLabel } = require('../../email-intelligence/lib/gmailClient');

const HISTORY_STATE_ID = 'gmail_push_history';

/**
 * Handle a Gmail push notification from Pub/Sub.
 * @param {object} payload - The Pub/Sub message body (already parsed, with req.gmailPush attached)
 * @param {object} gmailPush - Decoded { emailAddress, historyId } from middleware
 */
async function handle(payload, gmailPush) {
  const supabase = getSupabaseClient();
  const gmail = await getGmail();

  const newHistoryId = gmailPush.historyId;
  if (!newHistoryId) {
    console.log('[gmail-push] No historyId in notification, skipping');
    return { processed: 0 };
  }

  // Get our stored historyId
  const { data: state } = await supabase
    .from('gmail_sync_state')
    .select('last_history_id')
    .eq('id', 'jamie@rubyshines.com')
    .single();

  const startHistoryId = state?.last_history_id;
  if (!startHistoryId) {
    console.log('[gmail-push] No stored historyId — skipping push, daily sync will catch up');
    return { processed: 0 };
  }

  // Fetch history since last known point
  let messageIds = new Set();
  let pageToken = null;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: String(startHistoryId),
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        pageToken,
      });

      for (const record of (res.data.history || [])) {
        for (const added of (record.messagesAdded || [])) {
          if (added.message?.id) messageIds.add(added.message.id);
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 404) {
      // historyId too old — daily sync will catch up
      console.warn('[gmail-push] History expired, skipping — daily sync will backfill');
      return { processed: 0 };
    }
    throw err;
  }

  if (messageIds.size === 0) {
    return { processed: 0 };
  }

  console.log(`[gmail-push] ${messageIds.size} new message(s) from history`);

  // Dedup against already-synced messages
  const ids = [...messageIds];
  const { data: existing } = await supabase
    .from('email_messages')
    .select('gmail_message_id')
    .in('gmail_message_id', ids);
  const existingIds = new Set((existing || []).map(r => r.gmail_message_id));
  const newIds = ids.filter(id => !existingIds.has(id));

  if (newIds.length === 0) {
    console.log('[gmail-push] All messages already synced');
    // Still update historyId
    await supabase.from('gmail_sync_state').update({
      last_history_id: parseInt(newHistoryId),
      updated_at: new Date().toISOString(),
    }).eq('id', 'jamie@rubyshines.com');
    return { processed: 0 };
  }

  // Fetch full messages
  const messages = [];
  for (const id of newIds) {
    try {
      const msg = await fetchMessage(gmail, id);
      if (msg) messages.push(msg);
    } catch (err) {
      console.warn(`[gmail-push] Could not fetch message ${id}: ${err.message}`);
    }
  }

  // Classify
  const classified = await classifyMessages(messages);

  // Save to email_messages
  const rows = classified.map(m => ({
    gmail_message_id: m.gmail_message_id,
    gmail_thread_id: m.gmail_thread_id,
    subject: m.subject,
    from_address: m.from_address,
    from_name: m.from_name,
    to_addresses: m.to_addresses,
    cc_addresses: m.cc_addresses,
    date: m.date,
    body_text: m.body_text,
    labels: m.labels,
    is_sent: m.is_sent,
    has_attachments: m.has_attachments,
    attachment_meta: m.attachment_meta,
    is_auto_reply: m.is_auto_reply,
    word_count: m.word_count,
    classification: m.classification,
    classification_confidence: m.classification_confidence,
    classified_at: m.classified_at,
    synced_at: new Date().toISOString(),
  }));

  if (rows.length) {
    await upsert('email_messages', rows, ['gmail_message_id']);
  }

  // Route each message through processGmailCs
  const archiveEnabled = process.env.GMAIL_CS_ARCHIVE === 'true';
  const labelNames = ['CS-Routed', 'Spam-Archived', 'Auto-Reply', 'Newsletter', 'Automated'];
  const labelIds = {};
  for (const name of labelNames) {
    try {
      labelIds[name] = await getOrCreateLabel(gmail, name);
    } catch (err) {
      console.warn(`[gmail-push] Could not create label '${name}': ${err.message}`);
    }
  }

  let routed = 0;
  for (const msg of classified) {
    if (msg.is_sent) continue;
    try {
      const result = await processMessage(supabase, gmail, msg, { archiveEnabled, labelIds });
      if (result.action === 'forwarded' || result.action === 'archived') routed++;
    } catch (err) {
      console.error(`[gmail-push] Error routing ${msg.gmail_message_id}: ${err.message}`);
    }
  }

  // Update historyId
  await supabase.from('gmail_sync_state').update({
    last_history_id: parseInt(newHistoryId),
    updated_at: new Date().toISOString(),
  }).eq('id', 'jamie@rubyshines.com');

  console.log(`[gmail-push] Processed ${messages.length} messages, routed ${routed}`);
  return { processed: messages.length, routed };
}

module.exports = { handle };
