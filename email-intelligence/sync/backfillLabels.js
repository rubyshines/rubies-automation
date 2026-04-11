#!/usr/bin/env node

/**
 * Backfill Gmail labels based on existing classifications in Supabase.
 * Does NOT run intake, Gorgias routing, or archiving — just adds R/ labels.
 *
 * Usage:
 *   node email-intelligence/sync/backfillLabels.js
 *   node email-intelligence/sync/backfillLabels.js --dry-run
 *   node email-intelligence/sync/backfillLabels.js --since 2026-03-01
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getGmail, getOrCreateLabel, labelMessage } = require('../lib/gmailClient');

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
  spam: 'R/Spam',
  auto_reply: 'R/Auto-Reply',
  newsletter: 'R/Newsletter',
  skip: 'R/Automated',
  sent: null, // don't label our own sent emails
};

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const sinceIdx = process.argv.indexOf('--since');
  const since = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : '2026-03-01';

  const supabase = getSupabaseClient();
  const gmail = await getGmail();

  console.log(`[backfill-labels] ${dryRun ? 'DRY RUN — ' : ''}Labeling emails since ${since}`);

  // Pre-create all labels
  const labelIds = {};
  for (const [cls, name] of Object.entries(CLASSIFICATION_LABELS)) {
    if (!name) continue;
    try {
      labelIds[name] = await getOrCreateLabel(gmail, name);
    } catch (err) {
      console.warn(`  Could not create label '${name}': ${err.message}`);
    }
  }
  console.log(`  Created/found ${Object.keys(labelIds).length} labels`);

  // Fetch all classified emails
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('email_messages')
      .select('gmail_message_id, classification')
      .not('classification', 'is', null)
      .gte('date', since)
      .order('date', { ascending: true })
      .range(from, from + 999);

    if (error) { console.error('Query error:', error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`  Found ${all.length} classified emails`);

  if (dryRun) {
    const dist = {};
    for (const m of all) {
      dist[m.classification] = (dist[m.classification] || 0) + 1;
    }
    console.log('  Distribution:');
    Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
    console.log('[backfill-labels] Dry run complete');
    return;
  }

  // Label each email
  let labeled = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < all.length; i++) {
    const msg = all[i];
    const labelName = CLASSIFICATION_LABELS[msg.classification];
    if (!labelName || !labelIds[labelName]) {
      skipped++;
      continue;
    }

    try {
      await labelMessage(gmail, msg.gmail_message_id, labelIds[labelName]);
      labeled++;
      if (labeled % 50 === 0) console.log(`  Labeled ${labeled}/${all.length}...`);
    } catch (err) {
      // Message might have been deleted from Gmail
      if (err.code === 404) { skipped++; continue; }
      console.warn(`  Error labeling ${msg.gmail_message_id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[backfill-labels] Done — labeled: ${labeled}, skipped: ${skipped}, errors: ${errors}`);
}

run().catch(err => {
  console.error('[backfill-labels] Fatal:', err);
  process.exit(1);
});
