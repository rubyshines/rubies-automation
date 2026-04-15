#!/usr/bin/env node

/**
 * Reclassify emails that were previously tagged 'skip' or 'spam'
 * from domains removed from SKIP_DOMAINS, or that should now be
 * 'newsletter' or 'auto_reply' with the updated classifier.
 *
 * Safe to run multiple times — only reclassifies emails matching the criteria.
 * Does NOT forward old emails to Gorgias (that's handled by processGmailCs.js
 * with its CS_CUTOFF_DATE guard).
 *
 * Usage:
 *   node email-intelligence/sync/reclassifyEmails.js
 *   node email-intelligence/sync/reclassifyEmails.js --dry-run
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { classifyMessages } = require('../lib/classifier');

// Domains removed from SKIP_DOMAINS — their emails need reclassification
const REMOVED_SKIP_DOMAINS = [
  'icloud.com', 'outlook.com',
  'walkercares.org', 'vpd.ca', 'uwaterloo.ca',
  'fashionzone.ca',
  'nuoptimavectorx.com', 'crossworxhq.com', 'getsavedbyservices.com', 'legendfusions.com',
  'voyage.mongodb.com', 'mail.cursor.com',
];

// Also reclassify emails currently tagged 'spam' or 'email_marketing'
// that might now be 'newsletter' or 'auto_reply' with the updated prompt
const RECLASSIFY_FROM = ['skip'];

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const supabase = getSupabaseClient();

  console.log(`[reclassify] ${dryRun ? 'DRY RUN — ' : ''}Starting reclassification`);

  // 1. Find emails from removed skip domains that were classified as 'skip'
  let toReclassify = [];

  for (const domain of REMOVED_SKIP_DOMAINS) {
    const { data, error } = await supabase
      .from('email_messages')
      .select('gmail_message_id, gmail_thread_id, from_address, from_name, to_addresses, subject, date, body_text, classification, is_sent')
      .like('from_address', `%@${domain}`)
      .in('classification', RECLASSIFY_FROM)
      .eq('is_sent', false);

    if (error) {
      console.error(`[reclassify] Error querying ${domain}: ${error.message}`);
      continue;
    }
    if (data?.length) {
      console.log(`  ${domain}: ${data.length} emails to reclassify`);
      toReclassify.push(...data);
    }
  }

  if (toReclassify.length === 0) {
    console.log('[reclassify] No emails need reclassification');
    return;
  }

  console.log(`[reclassify] Total: ${toReclassify.length} emails to reclassify`);

  if (dryRun) {
    for (const msg of toReclassify) {
      console.log(`  [${msg.classification}] ${msg.from_address} — ${(msg.subject || '').substring(0, 60)}`);
    }
    console.log('[reclassify] Dry run complete — no changes made');
    return;
  }

  // 2. Clear existing classification so classifyMessages() will re-evaluate
  for (const msg of toReclassify) {
    msg.classification = null;
    msg.classification_confidence = null;
    msg.classified_at = null;
  }

  // 3. Run through classifier (will use Tier 1 → 2 → 3 as appropriate)
  const classified = await classifyMessages(toReclassify);

  // 4. Update in Supabase
  const changes = {};
  for (const msg of classified) {
    changes[msg.classification] = (changes[msg.classification] || 0) + 1;

    await supabase.from('email_messages').update({
      classification: msg.classification,
      classification_confidence: msg.classification_confidence,
      classified_at: msg.classified_at,
    }).eq('gmail_message_id', msg.gmail_message_id);
  }

  console.log('[reclassify] Results:');
  Object.entries(changes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });
  console.log('[reclassify] Done');
}

run().catch(err => {
  console.error('[reclassify] Fatal error:', err);
  process.exit(1);
});
