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
const { getGmail, getOrCreateLabel, labelMessage, labelAndArchive, markAsSpam, downloadAttachment } = require('../../gmail-management/lib/gmailClient');
const { stripQuotedContent } = require('../../gmail-management/lib/gmailSync');
const gorgias = require('../import/gorgiasClient');
const { checkForDuplicateTicket } = require('./processGorgiasTickets');

const CARE_ADDRESS = 'care@rubyshines.com';
const ATTACHMENT_BUCKET = 'email-attachments';

/**
 * Upload Gmail attachments to Supabase Storage and return Gorgias-compatible attachment objects.
 * Files are stored at: email-attachments/{gmailMessageId}/{filename}
 */
async function uploadAttachmentsForGorgias(gmail, supabase, gmailMessageId, attachmentMeta) {
  if (!attachmentMeta?.length) return [];
  console.log(`[gmail-cs] Processing ${attachmentMeta.length} attachment(s) for message ${gmailMessageId}`);
  const gorgiasAttachments = [];
  for (const att of attachmentMeta) {
    if (!att.attachmentId) continue;
    try {
      const { data, filename, mimeType } = await downloadAttachment(
        gmail, gmailMessageId, att.attachmentId, att.filename, att.mimeType
      );
      console.log(`[gmail-cs] Downloaded ${filename} (${mimeType}, ${data.length} bytes)`);
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const uuid = require('crypto').randomUUID();
      const storagePath = `${gmailMessageId}/${uuid}/${safeFilename}`;
      const { error } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, data, { contentType: mimeType, upsert: true });
      if (error) { console.warn(`[gmail-cs] Attachment upload failed: ${error.message}`); continue; }
      const { data: urlData } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(storagePath);
      console.log(`[gmail-cs] Uploaded ${filename} → public URL ready`);
      gorgiasAttachments.push({
        url: urlData.publicUrl,
        name: filename,
        content_type: mimeType,
        size: data.length,
      });
    } catch (err) {
      console.warn(`[gmail-cs] Could not process attachment ${att.filename}: ${err.message}`);
    }
  }
  return gorgiasAttachments;
}

// Classifications that should be archived out of the inbox
const ARCHIVE_CLASSIFICATIONS = {
  spam: 'R/Spam',
  auto_reply: 'R/Auto-Reply',
  newsletter: 'R/Newsletter',
};

// Classification → Gmail label mapping (for ALL emails, not just archived ones)
// skip → null: machine noise (DMARC, GitHub, etc.) — no label, just mark processed
const CLASSIFICATION_LABELS = {
  customer_support: 'R/Customer Support',
  wholesale: 'R/B2B',
  lgbtq_org: 'R/LGBTQ+ Org',
  product_rd: 'R/Product R&D',
  production_orders: 'R/Production',
  email_marketing: 'R/Email Marketing',
  '3pl_fulfillment': 'R/3PL',
  finance_legal: 'R/Finance',
  internal: 'R/Internal',
  pipeline: 'R/Pipeline',
  spam: 'R/Spam',
  auto_reply: 'R/Auto-Reply',
  newsletter: 'R/Newsletter',
  skip: null,
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
  const now = new Date().toISOString();

  // Helper: mark this email as processed (called at every exit point)
  const markProcessed = () =>
    supabase.from('email_messages').update({ processed_at: now }).eq('gmail_message_id', msg.gmail_message_id);

  // ── customer_support → forward to Gorgias ──
  if (classification === 'customer_support') {
    // Skip if addressed to care@ (Gorgias already has it)
    if ((msg.to_addresses || []).some(a => a.toLowerCase().includes(CARE_ADDRESS))) {
      await markProcessed();
      return { action: 'skipped', reason: 'addressed_to_care' };
    }

    // Skip if already forwarded
    if (msg.forwarded_to_gorgias_at) {
      await markProcessed();
      return { action: 'skipped', reason: 'already_forwarded' };
    }

    // Atomic claim: only one concurrent caller can own this gmail_message_id.
    // Gmail Pub/Sub delivers at-least-once, so duplicate webhook deliveries are
    // expected. The conditional UPDATE ... WHERE processed_at IS NULL is atomic
    // in Postgres — losers see 0 rows updated and bail out before doing any
    // work, preventing duplicate Gorgias tickets from concurrent runs.
    const { data: claim, error: claimErr } = await supabase
      .from('email_messages')
      .update({ processed_at: now })
      .is('processed_at', null)
      .eq('gmail_message_id', msg.gmail_message_id)
      .select('gmail_message_id');
    if (claimErr) {
      console.warn(`[gmail-cs] Claim failed for ${msg.gmail_message_id}: ${claimErr.message}`);
      return { action: 'skipped', reason: 'claim_error' };
    }
    if (!claim?.length) {
      console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: already claimed by another worker`);
      return { action: 'skipped', reason: 'already_claimed' };
    }

    // Skip if operator previously returned this email from CS to inbox
    if (msg.returned_to_inbox_at) {
      await markProcessed();
      return { action: 'skipped', reason: 'returned_to_inbox' };
    }

    // Skip old emails (don't flood Gorgias on first run)
    if (msg.date && msg.date.substring(0, 10) < CS_CUTOFF_DATE) {
      await markProcessed();
      return { action: 'skipped', reason: 'before_cutoff' };
    }

    // Race-safe dedup against Gorgias itself: if Gorgias's native email
    // integration just ingested this same email, an open ticket will already
    // exist for the customer. Skip before we create a second one.
    try {
      const recentGorgiasTickets = await gorgias.findOpenTicketsByEmail(msg.from_address, { withinMinutes: 10 });
      if (recentGorgiasTickets.length) {
        console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: Gorgias already has open ticket #${recentGorgiasTickets[0].id} for ${msg.from_address}`);
        await markProcessed();
        return { action: 'skipped', reason: 'gorgias_already_handling' };
      }
    } catch (err) {
      console.warn(`[gmail-cs] Gorgias dedup lookup failed for ${msg.from_address}: ${err.message} — falling through to Supabase dedup`);
    }

    // Dedup check against existing open tickets in Supabase
    const newMessages = [{ from_agent: false, stripped_text: msg.body_text || '', body_text: msg.body_text || '' }];
    const dupAction = await checkForDuplicateTicket(supabase, msg.from_address, 0, newMessages);
    if (dupAction === 'close_new') {
      console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: duplicate of existing ticket for ${msg.from_address}`);
      await markProcessed();
      return { action: 'skipped', reason: 'duplicate' };
    }

    // Skip replies to Stage 2 personal follow-up emails (sent from jamie@ via SendGrid).
    // These customers didn't respond to care@ (likely spam-filtered), so routing back to
    // Gorgias (which replies from care@) would repeat the spam loop. Leave in Jamie's inbox.
    const { data: recentStage2 } = await supabase
      .from('cs_tickets')
      .select('id')
      .eq('customer_email', msg.from_address)
      .eq('follow_up_stage', 2)
      .eq('status', 'closed')
      .gte('closed_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recentStage2 && recentStage2.length > 0) {
      console.log(`[gmail-cs] Skip ${msg.gmail_message_id}: reply to Stage 2 follow-up for ${msg.from_address} — staying in Gmail`);
      await markProcessed();
      return { action: 'skipped', reason: 'stage2_follow_up_reply' };
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
      await markProcessed();
      return { action: 'skipped', reason: 'legacy_thread' };
    }

    // Fetch full thread history for context (include attachment_meta for forwarding)
    const { data: threadMessages } = await supabase
      .from('email_messages')
      .select('gmail_message_id, from_address, from_name, to_addresses, subject, date, body_text, is_sent, attachment_meta')
      .eq('gmail_thread_id', msg.gmail_thread_id)
      .order('date', { ascending: true });

    // Use thread from DB (has attachment_meta), fall back to raw msg only if query failed
    const thread = (threadMessages && threadMessages.length > 0) ? threadMessages : [msg];
    const firstMsg = thread[0];
    const isOurAddress = (addr) => addr && (addr.toLowerCase().includes('@rubyshines.com'));

    // Upload attachments from the first message for Gorgias
    const firstMsgAttachments = await uploadAttachmentsForGorgias(
      gmail, supabase, firstMsg.gmail_message_id, firstMsg.attachment_meta
    );

    // Create ticket with the first (oldest) message in the thread
    const ticket = await gorgias.createTicket({
      customerEmail: firstMsg.is_sent ? (msg.from_address) : firstMsg.from_address,
      customerName: firstMsg.is_sent ? (msg.from_name || undefined) : (firstMsg.from_name || undefined),
      subject: firstMsg.subject || msg.subject || '(no subject)',
      bodyText: stripQuotedContent(firstMsg.body_text || ''),
      tags: ['gmail-import'],
      attachments: firstMsgAttachments,
    });

    // Add remaining thread messages chronologically
    for (let i = 1; i < thread.length; i++) {
      const tm = thread[i];
      const fromAgent = tm.is_sent || isOurAddress(tm.from_address);
      const tmAttachments = await uploadAttachmentsForGorgias(
        gmail, supabase, tm.gmail_message_id, tm.attachment_meta
      );
      try {
        await gorgias.addTicketMessage(ticket.id, {
          fromAddress: tm.from_address,
          fromName: tm.from_name || '',
          bodyText: stripQuotedContent(tm.body_text || ''),
          fromAgent,
          sentDatetime: tm.date,
          attachments: tmAttachments,
        });
      } catch (err) {
        console.warn(`[gmail-cs] Could not add thread message to ticket ${ticket.id}: ${err.message}`);
      }
    }

    const threadCount = thread.length;
    console.log(`[gmail-cs] Created Gorgias ticket ${ticket.id} for ${msg.from_address} — "${(msg.subject || '').substring(0, 50)}" (${threadCount} message${threadCount > 1 ? 's' : ''})`);

    // Mark all thread messages as forwarded + processed
    const threadMsgIds = thread.map(m => m.gmail_message_id);
    await supabase.from('email_messages').update({
      forwarded_to_gorgias_at: now,
      gorgias_ticket_id: ticket.id,
      processed_at: now,
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
      archived_at: now,
      processed_at: now,
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
      archived_at: now,
      processed_at: now,
    }).eq('gmail_message_id', msg.gmail_message_id);

    return { action: 'archived', classification };
  }

  // ── everything else (wholesale, lgbtq_org, production, etc.) → label, leave in inbox ──
  const classLabel = CLASSIFICATION_LABELS[classification];
  if (classLabel && labelIds[classLabel]) {
    await labelMessage(gmail, msg.gmail_message_id, labelIds[classLabel]);
  }
  await markProcessed();
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

  // Pre-create all R/ labels
  const allLabelNames = [...new Set(Object.values(CLASSIFICATION_LABELS).filter(Boolean))];
  const labelIds = {};
  for (const name of allLabelNames) {
    try {
      labelIds[name] = await getOrCreateLabel(gmail, name);
    } catch (err) {
      console.warn(`[gmail-cs] Could not create label '${name}': ${err.message}`);
    }
  }

  // Query all unprocessed inbound emails (state-driven, not timestamp-driven)
  let allMessages = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('email_messages')
      .select('gmail_message_id, gmail_thread_id, from_address, from_name, to_addresses, subject, date, body_text, classification, classification_confidence, forwarded_to_gorgias_at')
      .eq('is_sent', false)
      .is('processed_at', null)
      .not('classification', 'is', null)
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
  const stats = { forwarded: 0, archived: 0, labeled: 0, skipped: 0, errors: 0 };
  const archiveStats = {};

  for (const msg of allMessages) {
    try {
      const result = await processMessage(supabase, gmail, msg, { archiveEnabled, labelIds });

      if (result.action === 'forwarded') stats.forwarded++;
      else if (result.action === 'archived') {
        stats.archived++;
        archiveStats[result.classification] = (archiveStats[result.classification] || 0) + 1;
      }
      else if (result.action === 'labeled') stats.labeled++;
      else if (result.action === 'skipped') stats.skipped++;

      if (onProgress) onProgress({ processed: stats.forwarded + stats.archived + stats.skipped, total: allMessages.length });
    } catch (err) {
      console.error(`[gmail-cs] Error processing ${msg.gmail_message_id}: ${err.message}`);
      stats.errors++;
    }
  }

  console.log(`[gmail-cs] Done — forwarded: ${stats.forwarded}, labeled: ${stats.labeled}, archived: ${stats.archived} (${Object.entries(archiveStats).map(([k, v]) => `${k}:${v}`).join(', ')}), skipped: ${stats.skipped}, errors: ${stats.errors}`);

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

module.exports = { run, processMessage, CLASSIFICATION_LABELS };
