#!/usr/bin/env node

/**
 * Gmail Inbox Cleanup
 *
 * Archives and trashes classified emails based on lifecycle rules in config.
 * Currently targets pipeline emails (automated system reports from pipeline@rubyshines.com).
 *
 * Rules are defined in INBOX_CLEANUP config:
 *   { classification: { archive_after_days, trash_after_days } }
 *
 * - Archive = remove from INBOX (label + archive)
 * - Trash = move to Gmail trash (auto-deleted by Gmail after 30 days)
 * - Only trashes emails that have already been archived
 *
 * Usage:
 *   node gmail-management/sync/cleanupInbox.js
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getGmail, getOrCreateLabel, labelAndArchive, trashMessage } = require('../lib/gmailClient');
const { INBOX_CLEANUP } = require('../config');
const { CLASSIFICATION_LABELS } = require('../../customer-service/intake/processGmailCs');

async function run() {
  const supabase = getSupabaseClient();
  const now = new Date();

  console.log('[inbox-cleanup] Starting...');

  let gmail;
  try {
    gmail = await getGmail();
  } catch (err) {
    console.error(`[inbox-cleanup] Gmail auth failed: ${err.message}`);
    return { sources: { inbox_cleanup: { success: false, error: err.message } }, status: 'error' };
  }

  const stats = { archived: 0, trashed: 0, errors: 0 };

  for (const [classification, rules] of Object.entries(INBOX_CLEANUP)) {
    const { archive_after_days, trash_after_days } = rules;

    // --- Archive step: remove from inbox ---
    const archiveCutoff = new Date(now - archive_after_days * 24 * 60 * 60 * 1000).toISOString();

    const { data: toArchive, error: archiveErr } = await supabase
      .from('email_messages')
      .select('gmail_message_id, subject, date')
      .eq('classification', classification)
      .eq('is_sent', false)
      .is('archived_at', null)
      .lt('date', archiveCutoff)
      .order('date', { ascending: true })
      .limit(200);

    if (archiveErr) {
      console.error(`[inbox-cleanup] Archive query error for ${classification}: ${archiveErr.message}`);
      stats.errors++;
    } else if (toArchive && toArchive.length > 0) {
      console.log(`[inbox-cleanup] Archiving ${toArchive.length} ${classification} email(s) older than ${archive_after_days} day(s)`);

      // Get the Gmail label for this classification
      const labelName = CLASSIFICATION_LABELS[classification];
      let labelId = null;
      if (labelName) {
        try {
          labelId = await getOrCreateLabel(gmail, labelName);
        } catch (err) {
          console.warn(`[inbox-cleanup] Could not get label '${labelName}': ${err.message}`);
        }
      }

      for (const msg of toArchive) {
        try {
          if (labelId) {
            await labelAndArchive(gmail, msg.gmail_message_id, labelId);
          } else {
            // No label — just remove from inbox via modify
            await gmail.users.messages.modify({
              userId: 'me',
              id: msg.gmail_message_id,
              requestBody: { removeLabelIds: ['INBOX'] },
            });
          }
          await supabase.from('email_messages')
            .update({ archived_at: new Date().toISOString() })
            .eq('gmail_message_id', msg.gmail_message_id);
          stats.archived++;
        } catch (err) {
          // 404 = message already deleted/trashed — mark as archived anyway
          if (err.code === 404) {
            await supabase.from('email_messages')
              .update({ archived_at: new Date().toISOString() })
              .eq('gmail_message_id', msg.gmail_message_id);
            stats.archived++;
          } else {
            console.error(`[inbox-cleanup] Archive failed for ${msg.gmail_message_id}: ${err.message}`);
            stats.errors++;
          }
        }
      }
    }

    // --- Trash step: move to trash (only already-archived emails) ---
    const trashCutoff = new Date(now - trash_after_days * 24 * 60 * 60 * 1000).toISOString();

    const { data: toTrash, error: trashErr } = await supabase
      .from('email_messages')
      .select('gmail_message_id, subject, date')
      .eq('classification', classification)
      .eq('is_sent', false)
      .not('archived_at', 'is', null)
      .is('trashed_at', null)
      .lt('date', trashCutoff)
      .order('date', { ascending: true })
      .limit(200);

    if (trashErr) {
      console.error(`[inbox-cleanup] Trash query error for ${classification}: ${trashErr.message}`);
      stats.errors++;
    } else if (toTrash && toTrash.length > 0) {
      console.log(`[inbox-cleanup] Trashing ${toTrash.length} ${classification} email(s) older than ${trash_after_days} day(s)`);

      for (const msg of toTrash) {
        try {
          await trashMessage(gmail, msg.gmail_message_id);
          await supabase.from('email_messages')
            .update({ trashed_at: new Date().toISOString() })
            .eq('gmail_message_id', msg.gmail_message_id);
          stats.trashed++;
        } catch (err) {
          // 404 = message already deleted — mark as trashed anyway
          if (err.code === 404) {
            await supabase.from('email_messages')
              .update({ trashed_at: new Date().toISOString() })
              .eq('gmail_message_id', msg.gmail_message_id);
            stats.trashed++;
          } else {
            console.error(`[inbox-cleanup] Trash failed for ${msg.gmail_message_id}: ${err.message}`);
            stats.errors++;
          }
        }
      }
    }
  }

  console.log(`[inbox-cleanup] Done — archived: ${stats.archived}, trashed: ${stats.trashed}, errors: ${stats.errors}`);

  return {
    sources: {
      inbox_cleanup: {
        success: true,
        rowsWritten: stats.archived + stats.trashed,
        archived: stats.archived,
        trashed: stats.trashed,
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
      console.error('[inbox-cleanup] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run };
