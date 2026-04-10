#!/usr/bin/env node

/**
 * Gmail CS Intake + Inbox Cleanup
 *
 * Routes classified Gmail emails:
 * - customer_support → Create Gorgias ticket (with dedup check)
 * - spam, auto_reply, newsletter, skip → Label + archive from inbox
 * - Everything else → Leave in inbox (real conversations)
 *
 * Phased rollout:
 *   GMAIL_CS_ARCHIVE=false (default) — label only, verify nothing lost
 *   GMAIL_CS_ARCHIVE=true — label + archive, inbox gets clean
 *
 * Usage:
 *   node customer-service/intake/processGmailCs.js
 *   npm run gmail-cs-intake
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getGmail, getOrCreateLabel, labelMessage, labelAndArchive, markAsSpam } = require('../../email-intelligence/lib/gmailClient');
const { stripQuotedContent } = require('../../email-intelligence/lib/gmailSync');
const gorgias = require('../import/gorgiasClient');
const { checkForDuplicateTicket } = require('./processGorgiasTickets');

const CARE_ADDRESS = 'care@rubyshines.com';
const POLLER_ID = 'gmail_cs_drafter';

// Classifications that should be archived out of the inbox
const ARCHIVE_CLASSIFICATIONS = {
  spam: 'R/Spam',
  auto_reply: 'R/Auto-Reply',
  newsletter: 'R/Newsletter',
  skip: 'R/Automated',
};

// Classification → Gmail label mapping (for ALL emails, not just archived ones)
const CLASSIFICATION_LABELS = {
  customer_support: 'R/Customer Support',
  wholesale: 'R/Wholesale',
  lgbtq_org: 'R/LGBTQ+ Org',
  product_rd: 'R/Product R&D',
  production_orders: 'R/Production',
  email_marketing: 'R/Email Marketing',
  '3pl_fulfillment': 'R/3PL',
  finance_legal: 'R/Finance',
  internal: 'R/Internal',
  spam: 'R/Spam',
  auto_reply: 'R/Auto-Reply',
  newsletter: 'R/Newsletter',
  skip: 'R/Automated',
};

// Only forward CS emails newer than this date to Gorgias.
// Prevents flooding Gorgias with old emails on first run.
const CS_CUTOFF_DATE = process.env.GMAIL_CS_CUTOFF_DATE || new Date().toISOString().substring(0, 10);

/**
 * Process a single email message based on its classification.
 * Can be called from the batch run() or from the webhook handler.
 */
async function processMessage(supabase, gmail, msg, { archiveEnabled, labelIds }) {
  const classification = msg.classification;

  // ── customer_support → forward to Gorgias ──
  if (classification === 'customer_support') {
    // Skip if addressed to care@ (Gorgias already has it)
    if ((msg.to_addresses || []).some(a => a.toLowerCase().includes(CARE_ADDRESS))) {
      return { action: 'skipped', reason: 'addressed_to_care' };
    }

    // Skip if already forwarded
    if (msg.forwarded_to_gorgias_at) {
      return { action: 'skipped', reason: 'already_forwarded' };
    }

    // Skip old emails (don't flood Gorgias on first run)
    if (msg.date && msg.date.substring(0, 10) < CS_CUTOFF_DATE) {
      return { action: 'skipped', reason: 'before_cutoff' };
    }

    // Dedup check against existing open tickets
    const newMessages = [{ from_agent: false, stripped_text: msg.body_text || '', body_text: msg.body_text || '' }];
    const dupAction = await checkForDuplicateTicket(supabase, msg.from_address, 0, newMessages);
    if (dupAction === 'close_new') {
      console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: duplicate of existing ticket for ${msg.from_address}`);
      return { action: 'skipped', reason: 'duplicate' };
    }

    // Skip legacy threads — if we already replied in Gmail outside of Gorgias, Jamie handled it
    const { data: priorReplies } = await supabase
      .from('email_messages')
      .select('gmail_message_id')
      .eq('gmail_thread_id', msg.gmail_thread_id)
      .eq('is_sent', true)
      .is('gorgias_ticket_id', null)
      .limit(1);

    if (priorReplies && priorReplies.length > 0) {
      console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: legacy thread already handled in Gmail`);
      return { action: 'skipped', reason: 'legacy_thread' };
    }

    // Fetch full thread history for context
    const { data: threadMessages } = await supabase
      .from('email_messages')
      .select('gmail_message_id, from_address, from_name, to_addresses, subject, date, body_text, is_sent')
      .eq('gmail_thread_id', msg.gmail_thread_id)
      .order('date', { ascending: true });

    // Use full thread if available, otherwise fall back to single message
    const thread = (threadMessages && threadMessages.length > 1) ? threadMessages : [msg];
    const firstMsg = thread[0];
    const isOurAddress = (addr) => addr && (addr.toLowerCase().includes('@rubyshines.com'));

    // Create ticket with the first (oldest) message in the thread
    const ticket = await gorgias.createTicket({
      customerEmail: firstMsg.is_sent ? (msg.from_address) : firstMsg.from_address,
      customerName: firstMsg.is_sent ? (msg.from_name || undefined) : (firstMsg.from_name || undefined),
      subject: firstMsg.subject || msg.subject || '(no subject)',
      bodyText: stripQuotedContent(firstMsg.body_text || ''),
      tags: ['gmail-import'],
    });

    // Add remaining thread messages chronologically
    for (let i = 1; i < thread.length; i++) {
      const tm = thread[i];
      const fromAgent = tm.is_sent || isOurAddress(tm.from_address);
      try {
        await gorgias.addTicketMessage(ticket.id, {
          fromAddress: tm.from_address,
          fromName: tm.from_name || '',
          bodyText: stripQuotedContent(tm.body_text || ''),
          fromAgent,
          sentDatetime: tm.date,
        });
      } catch (err) {
        console.warn(`[gmail-cs] Could not add thread message to ticket ${ticket.id}: ${err.message}`);
      }
    }

    const threadCount = thread.length;
    console.log(`[gmail-cs] Created Gorgias ticket ${ticket.id} for ${msg.from_address} — "${(msg.subject || '').substring(0, 50)}" (${threadCount} message${threadCount > 1 ? 's' : ''})`);

    // Mark all thread messages as forwarded
    const threadMsgIds = thread.map(m => m.gmail_message_id);
    await supabase.from('email_messages').update({
      forwarded_to_gorgias_at: new Date().toISOString(),
      gorgias_ticket_id: ticket.id,
    }).in('gmail_message_id', threadMsgIds);

    // Label in Gmail
    const csLabel = labelIds['R/Customer Support'];
    if (csLabel) {
      if (archiveEnabled) {
        await labelAndArchive(gmail, msg.gmail_message_id, csLabel);
      } else {
        await labelMessage(gmail, msg.gmail_message_id, csLabel);
      }
    }

    return { action: 'forwarded', ticketId: ticket.id };
  }

  // ── spam → mark as spam in Gmail (trains Google's filter) + label ──
  if (classification === 'spam') {
    const spamLabel = labelIds['R/Spam'];
    if (spamLabel) await labelMessage(gmail, msg.gmail_message_id, spamLabel);
    await markAsSpam(gmail, msg.gmail_message_id);
    await supabase.from('email_messages').update({
      archived_at: new Date().toISOString(),
    }).eq('gmail_message_id', msg.gmail_message_id);
    return { action: 'archived', classification };
  }

  // ── auto_reply, newsletter, skip → label + archive ──
  const archiveLabelName = ARCHIVE_CLASSIFICATIONS[classification];
  if (archiveLabelName) {
    const labelId = labelIds[archiveLabelName];
    if (labelId) {
      if (archiveEnabled) {
        await labelAndArchive(gmail, msg.gmail_message_id, labelId);
      } else {
        await labelMessage(gmail, msg.gmail_message_id, labelId);
      }
    }

    await supabase.from('email_messages').update({
      archived_at: new Date().toISOString(),
    }).eq('gmail_message_id', msg.gmail_message_id);

    return { action: 'archived', classification };
  }

  // ── everything else (wholesale, lgbtq_org, production, etc.) → label, leave in inbox ──
  const classLabel = CLASSIFICATION_LABELS[classification];
  if (classLabel && labelIds[classLabel]) {
    await labelMessage(gmail, msg.gmail_message_id, labelIds[classLabel]);
  }
  return { action: 'labeled', classification };
}

/**
 * Main batch run — processes all unarchived, unforwarded emails.
 */
async function run({ onProgress } = {}) {
  const supabase = getSupabaseClient();
  const archiveEnabled = process.env.GMAIL_CS_ARCHIVE === 'true';

  console.log(`[gmail-cs] Starting (archive: ${archiveEnabled ? 'ON' : 'label-only'}, CS cutoff: ${CS_CUTOFF_DATE})`);

  // Get Gmail client
  let gmail;
  try {
    gmail = await getGmail();
  } catch (err) {
    console.error(`[gmail-cs] Gmail auth failed: ${err.message}`);
    return { sources: { gmail_cs: { success: false, error: err.message } }, status: 'error' };
  }

  // Pre-create all labels
  const labelNames = ['CS-Routed', ...Object.values(ARCHIVE_CLASSIFICATIONS)];
  const labelIds = {};
  for (const name of labelNames) {
    try {
      labelIds[name] = await getOrCreateLabel(gmail, name);
    } catch (err) {
      console.warn(`[gmail-cs] Could not create label '${name}': ${err.message}`);
    }
  }

  // Get last poll time
  const { data: pollerState } = await supabase
    .from('cs_poller_state')
    .select('last_poll_at')
    .eq('id', POLLER_ID)
    .single();

  const lastPollAt = pollerState?.last_poll_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Query unprocessed emails
  const classificationsToProcess = ['customer_support', ...Object.keys(ARCHIVE_CLASSIFICATIONS)];
  let allMessages = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('email_messages')
      .select('gmail_message_id, gmail_thread_id, from_address, from_name, to_addresses, subject, date, body_text, classification, classification_confidence, forwarded_to_gorgias_at')
      .eq('is_sent', false)
      .is('archived_at', null)
      .in('classification', classificationsToProcess)
      .gte('date', lastPollAt)
      .order('date', { ascending: true })
      .range(from, from + 999);

    if (error) {
      console.error(`[gmail-cs] Query error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    allMessages.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`[gmail-cs] Found ${allMessages.length} emails to process`);

  // Process each email
  const stats = { forwarded: 0, archived: 0, skipped: 0, errors: 0 };
  const archiveStats = {};

  for (const msg of allMessages) {
    try {
      const result = await processMessage(supabase, gmail, msg, { archiveEnabled, labelIds });

      if (result.action === 'forwarded') stats.forwarded++;
      else if (result.action === 'archived') {
        stats.archived++;
        archiveStats[result.classification] = (archiveStats[result.classification] || 0) + 1;
      }
      else if (result.action === 'skipped') stats.skipped++;

      if (onProgress) onProgress({ processed: stats.forwarded + stats.archived + stats.skipped, total: allMessages.length });
    } catch (err) {
      console.error(`[gmail-cs] Error processing ${msg.gmail_message_id}: ${err.message}`);
      stats.errors++;
    }
  }

  // Update poller state
  await supabase.from('cs_poller_state').upsert({
    id: POLLER_ID,
    last_poll_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  console.log(`[gmail-cs] Done — forwarded: ${stats.forwarded}, archived: ${stats.archived} (${Object.entries(archiveStats).map(([k, v]) => `${k}:${v}`).join(', ')}), skipped: ${stats.skipped}, errors: ${stats.errors}`);

  return {
    sources: {
      gmail_cs: {
        success: true,
        rowsWritten: stats.forwarded + stats.archived,
        forwarded: stats.forwarded,
        archived: stats.archived,
        archiveBreakdown: archiveStats,
        skipped: stats.skipped,
        errors: stats.errors,
      },
    },
    status: stats.errors > 0 ? 'partial' : 'ok',
  };
}

// CLI entry point
if (require.main === module) {
  run()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'error' ? 1 : 0);
    })
    .catch(err => {
      console.error('[gmail-cs] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run, processMessage };
