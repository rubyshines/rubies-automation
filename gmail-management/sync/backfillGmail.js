#!/usr/bin/env node

/**
 * Gmail Backfill — Two-pass backfill with iterative tuning support.
 *
 * Usage:
 *   # Phase 0: Fetch + classify 500 messages (tuning batch)
 *   node email-intelligence/sync/backfillGmail.js --limit 500
 *
 *   # Review what was classified
 *   node email-intelligence/sync/backfillGmail.js --review
 *
 *   # Summarize threads + determine next actions (costs Sonnet tokens)
 *   node email-intelligence/sync/backfillGmail.js --summarize
 *   node email-intelligence/sync/backfillGmail.js --summarize --limit 20  # just 20 threads
 *
 *   # Re-classify messages that were reset (classification = null)
 *   node email-intelligence/sync/backfillGmail.js --reclassify
 *
 *   # Full 2-year backfill
 *   node email-intelligence/sync/backfillGmail.js --after 2024-03-29
 *
 *   # Continue interrupted backfill (uses stored page token)
 *   node email-intelligence/sync/backfillGmail.js --continue
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { getSupabaseClient, upsert, fetchAllPaginated } = require('../../shared/supabaseClient');
const { getGmail } = require('../lib/gmailClient');
const { listMessages, fetchMessages } = require('../lib/gmailSync');
const { classifyMessages } = require('../lib/classifier');
const { aggregateThreads, summarizeThreads, upsertThreads } = require('../lib/threadBuilder');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] || true) : null;
};
const hasFlag = (name) => args.includes(name);

const LIMIT = getArg('--limit') ? parseInt(getArg('--limit')) : null;
const AFTER_DATE = getArg('--after') ? new Date(getArg('--after')) : null;
const REVIEW_MODE = hasFlag('--review');
const SUMMARIZE_MODE = hasFlag('--summarize');
const RECLASSIFY_MODE = hasFlag('--reclassify');
const CONTINUE_MODE = hasFlag('--continue');

// ---------------------------------------------------------------------------
// Review mode — show what's been classified so far
// ---------------------------------------------------------------------------

async function runReview() {
  const supabase = getSupabaseClient();

  console.log('\n========================================');
  console.log('  EMAIL INTELLIGENCE — REVIEW');
  console.log('========================================\n');

  // Classification distribution
  const { data: messages } = await supabase
    .from('email_messages')
    .select('classification, from_address, subject, date, is_sent')
    .order('date', { ascending: false });

  if (!messages || messages.length === 0) {
    console.log('  No messages synced yet. Run a backfill first.');
    return;
  }

  // Classification counts
  const classCounts = {};
  for (const m of messages) {
    const c = m.classification || 'unclassified';
    classCounts[c] = (classCounts[c] || 0) + 1;
  }

  console.log(`  Total messages: ${messages.length}\n`);
  console.log('  Classification Distribution:');
  const sorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
  for (const [cls, count] of sorted) {
    const pct = ((count / messages.length) * 100).toFixed(0);
    const bar = '#'.repeat(Math.ceil(count / Math.max(1, messages.length / 40)));
    console.log(`    ${cls.padEnd(22)} ${String(count).padStart(5)} (${pct.padStart(2)}%) ${bar}`);
  }

  // Top senders that needed AI (not tier 1)
  const aiClassified = messages.filter(m =>
    m.classification && !['skip', 'sent'].includes(m.classification)
  );
  const domainCounts = {};
  for (const m of aiClassified) {
    if (m.is_sent) continue;
    const domain = m.from_address?.split('@')[1] || 'unknown';
    if (!domainCounts[domain]) domainCounts[domain] = { count: 0, classification: m.classification, subjects: [] };
    domainCounts[domain].count++;
    if (domainCounts[domain].subjects.length < 2) {
      domainCounts[domain].subjects.push(m.subject?.substring(0, 50));
    }
  }

  console.log('\n  AI-Classified Domains (top 20):');
  const sortedDomains = Object.entries(domainCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  for (const [domain, info] of sortedDomains) {
    console.log(`    ${String(info.count).padStart(4)}  ${domain} → ${info.classification}`);
    for (const subj of info.subjects) {
      console.log(`          "${subj}"`);
    }
  }

  // Thread summary
  const { data: threads } = await supabase
    .from('email_threads')
    .select('*')
    .order('last_message_at', { ascending: false })
    .limit(50);

  if (threads && threads.length > 0) {
    console.log('\n  Threads (most recent 50):');
    const withSummary = threads.filter(t => t.summary);
    const withAction = threads.filter(t => t.next_action);
    console.log(`    Total: ${threads.length}, With summary: ${withSummary.length}, With next action: ${withAction.length}\n`);

    // Backfill missing subjects from email_messages
    const noSubject = threads.filter(t => !t.subject);
    if (noSubject.length > 0) {
      const { data: subjectLookup } = await supabase
        .from('email_messages')
        .select('gmail_thread_id, subject')
        .in('gmail_thread_id', noSubject.map(t => t.gmail_thread_id))
        .not('subject', 'is', null);
      if (subjectLookup) {
        const subjectMap = new Map();
        for (const row of subjectLookup) {
          if (!subjectMap.has(row.gmail_thread_id)) subjectMap.set(row.gmail_thread_id, row.subject);
        }
        for (const t of noSubject) {
          t.subject = subjectMap.get(t.gmail_thread_id) || '(no subject)';
        }
      }
    }

    // Group by classification
    const byClass = {};
    for (const t of threads) {
      const c = t.classification || 'unclassified';
      if (!byClass[c]) byClass[c] = [];
      byClass[c].push(t);
    }

    for (const [cls, classThreads] of Object.entries(byClass).sort()) {
      console.log(`    --- ${cls.toUpperCase()} (${classThreads.length} threads) ---`);
      for (const t of classThreads.slice(0, 5)) {
        const status = t.awaiting_response_from === 'us' ? '[NEEDS REPLY]' : '[WAITING]';
        console.log(`      ${status} ${(t.subject || '(no subject)').substring(0, 60)}`);
        if (t.summary) console.log(`        Summary: ${t.summary.substring(0, 100)}...`);
        if (t.next_action) console.log(`        Next: ${t.next_action} (due: ${t.next_action_due || 'unset'})`);
      }
      console.log('');
    }
  }

  // Action items due
  const { data: actionItems } = await supabase
    .from('email_threads')
    .select('gmail_thread_id, subject, classification, next_action, next_action_due, next_action_owner, awaiting_response_from')
    .not('next_action', 'is', null)
    .order('next_action_due', { ascending: true })
    .limit(20);

  if (actionItems && actionItems.length > 0) {
    // For threads with missing subject, look it up from messages
    const missingSubjects = actionItems.filter(a => !a.subject);
    if (missingSubjects.length > 0) {
      const { data: subjectLookup } = await supabase
        .from('email_messages')
        .select('gmail_thread_id, subject')
        .in('gmail_thread_id', missingSubjects.map(a => a.gmail_thread_id))
        .not('subject', 'is', null)
        .limit(missingSubjects.length * 5);
      if (subjectLookup) {
        const subjectMap = new Map();
        for (const row of subjectLookup) {
          if (!subjectMap.has(row.gmail_thread_id)) subjectMap.set(row.gmail_thread_id, row.subject);
        }
        for (const item of missingSubjects) {
          item.subject = subjectMap.get(item.gmail_thread_id) || '(no subject)';
        }
      }
    }

    console.log('\n  ========== ACTION ITEMS ==========\n');
    for (const item of actionItems) {
      const overdue = item.next_action_due && new Date(item.next_action_due) < new Date() ? ' OVERDUE' : '';
      console.log(`    [${item.classification}] ${item.next_action}`);
      console.log(`      Thread: ${(item.subject || '(no subject)').substring(0, 60)}`);
      console.log(`      Due: ${item.next_action_due || 'unset'} | Owner: ${item.next_action_owner || '?'}${overdue}`);
      console.log('');
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch + Classify (Pass 1)
// ---------------------------------------------------------------------------

async function runFetchAndClassify() {
  const gmail = await getGmail();
  const supabase = getSupabaseClient();

  console.log('\n========================================');
  console.log('  BACKFILL — Fetch & Classify');
  console.log('========================================\n');

  // List messages
  const listOpts = {};
  if (AFTER_DATE) {
    listOpts.afterDate = AFTER_DATE;
    console.log(`  Fetching messages after ${AFTER_DATE.toISOString().split('T')[0]}...`);
  }
  if (LIMIT) {
    listOpts.maxResults = LIMIT;
    console.log(`  Limit: ${LIMIT} messages`);
  }

  console.log('  Listing messages...');
  const messageList = await listMessages(gmail, listOpts);
  console.log(`  Found ${messageList.length} message IDs\n`);

  if (messageList.length === 0) {
    console.log('  No messages to process.');
    return;
  }

  // Check which ones we already have
  const existingIds = new Set();
  for (let i = 0; i < messageList.length; i += 1000) {
    const batch = messageList.slice(i, i + 1000).map(m => m.id);
    const { data } = await supabase
      .from('email_messages')
      .select('gmail_message_id')
      .in('gmail_message_id', batch);
    if (data) data.forEach(r => existingIds.add(r.gmail_message_id));
  }

  const newIds = messageList.filter(m => !existingIds.has(m.id));
  console.log(`  Already synced: ${existingIds.size}, New: ${newIds.length}\n`);

  if (newIds.length === 0) {
    console.log('  All messages already synced. Use --reclassify to re-run classification.');
    return;
  }

  // Fetch full messages
  console.log('  Fetching full messages...');
  const messages = await fetchMessages(gmail, newIds.map(m => m.id), {
    onProgress: (done, total) => process.stderr.write(`  Fetched ${done}/${total}...\r`),
  });
  console.log(`  Fetched ${messages.length} messages\n`);

  // Classify
  console.log('  Classifying...');
  const classified = await classifyMessages(messages);
  const tier3Count = classified.filter(m => !['skip', 'sent'].includes(m.classification)).length;
  console.log(`  Classified ${classified.length} messages (${tier3Count} non-skip/sent)\n`);

  // Save to Supabase
  console.log('  Saving to Supabase...');
  const rows = classified.map(m => ({
    gmail_message_id: m.gmail_message_id,
    gmail_thread_id: m.gmail_thread_id,
    subject: m.subject,
    from_address: m.from_address,
    from_name: m.from_name,
    to_addresses: m.to_addresses,
    cc_addresses: m.cc_addresses,
    date: m.date,
    body_text: m.classification === 'skip' ? null : m.body_text, // don't store body for skipped
    labels: m.labels,
    is_sent: m.is_sent,
    has_attachments: m.has_attachments,
    attachment_meta: m.attachment_meta,
    is_auto_reply: m.is_auto_reply,
    word_count: m.word_count,
    raw_size_bytes: m.raw_size_bytes,
    classification: m.classification,
    classification_confidence: m.classification_confidence,
    classified_at: m.classified_at,
    synced_at: new Date().toISOString(),
  }));

  // Batch upsert
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await upsert('email_messages', batch, ['gmail_message_id']);
  }
  console.log(`  Saved ${rows.length} messages\n`);

  // Build threads (structural only — no AI). Omit summary columns so a re-run
  // can't null summaries written by the summarization pass below.
  console.log('  Building threads...');
  const threads = aggregateThreads(classified);
  await upsertThreads(threads, { includeSummary: false });
  console.log(`  Built ${threads.length} threads\n`);

  // Summary
  const classCounts = {};
  for (const m of classified) {
    const c = m.classification || 'unknown';
    classCounts[c] = (classCounts[c] || 0) + 1;
  }
  console.log('  Classification breakdown:');
  for (const [c, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(22)} ${count}`);
  }

  console.log('\n  Done! Run --review to inspect results, --summarize to generate summaries.\n');
}

// ---------------------------------------------------------------------------
// Reclassify (re-run AI on unclassified or reset messages)
// ---------------------------------------------------------------------------

async function runReclassify() {
  const supabase = getSupabaseClient();

  console.log('\n  Reclassifying unclassified messages...');
  const { data: messages } = await supabase
    .from('email_messages')
    .select('*')
    .is('classification', null)
    .order('date', { ascending: false })
    .limit(LIMIT || 1000);

  if (!messages || messages.length === 0) {
    console.log('  No unclassified messages found.');
    return;
  }

  console.log(`  Found ${messages.length} unclassified messages`);
  const classified = await classifyMessages(messages);

  // Update only classification fields (not full upsert)
  const supabase2 = getSupabaseClient();
  let updated = 0;
  for (const m of classified) {
    const { error } = await supabase2
      .from('email_messages')
      .update({
        classification: m.classification,
        classification_confidence: m.classification_confidence,
        classified_at: m.classified_at,
      })
      .eq('gmail_message_id', m.gmail_message_id);
    if (error) console.error(`  Error updating ${m.gmail_message_id}: ${error.message}`);
    else updated++;
  }
  console.log(`  Reclassified ${updated} messages\n`);
}

// ---------------------------------------------------------------------------
// Summarize (Pass 2 — costs Sonnet tokens)
// ---------------------------------------------------------------------------

async function runSummarize() {
  const supabase = getSupabaseClient();

  console.log('\n========================================');
  console.log('  BACKFILL — Summarize Threads');
  console.log('========================================\n');

  // Get threads that need summarization (no summary, or new messages since last summary)
  // Fetch all eligible threads first, then apply limit after filtering
  const { data: threadRows } = await supabase
    .from('email_threads')
    .select('gmail_thread_id, classification, subject, summary, summary_updated_at, next_action, last_message_at')
    .neq('classification', 'skip')
    .neq('classification', 'internal')
    .neq('classification', 'spam')
    .order('last_message_at', { ascending: false })
    .limit(500);

  if (!threadRows || threadRows.length === 0) {
    console.log('  No threads to summarize.');
    return;
  }

  // Filter to threads that need work, then apply limit
  let needsSummary = threadRows.filter(t =>
    !t.summary || (t.summary_updated_at && new Date(t.last_message_at) > new Date(t.summary_updated_at))
  );
  if (LIMIT) needsSummary = needsSummary.slice(0, LIMIT);

  console.log(`  Threads found: ${threadRows.length}`);
  console.log(`  Need summarization: ${needsSummary.length}`);
  if (needsSummary.length === 0) {
    console.log('  All threads are up to date.');
    return;
  }

  // Load messages for these threads — paginated: up to 500 threads easily
  // exceeds the 1000-row cap, which silently dropped the newest messages.
  const threadIds = needsSummary.map(t => t.gmail_thread_id);
  const allMessages = await fetchAllPaginated(() => supabase
    .from('email_messages')
    .select('*')
    .in('gmail_thread_id', threadIds)
    .neq('classification', 'skip')
    .order('date', { ascending: true })
    .order('gmail_message_id', { ascending: true }));

  // Group messages by thread
  const msgsByThread = new Map();
  for (const msg of (allMessages || [])) {
    if (!msgsByThread.has(msg.gmail_thread_id)) msgsByThread.set(msg.gmail_thread_id, []);
    msgsByThread.get(msg.gmail_thread_id).push(msg);
  }

  // Build thread objects with messages attached
  const threadsToSummarize = needsSummary.map(t => ({
    ...t,
    messages: msgsByThread.get(t.gmail_thread_id) || [],
  })).filter(t => t.messages.length > 0);

  console.log(`  Threads with messages: ${threadsToSummarize.length}\n`);
  console.log('  Summarizing (this uses Sonnet tokens)...');

  await summarizeThreads(threadsToSummarize, {
    onProgress: (done, total) => process.stderr.write(`  Summarized ${done}/${total}...\r`),
  });

  // Save updated threads
  await upsertThreads(threadsToSummarize);
  console.log(`\n  Summarized ${threadsToSummarize.length} threads\n`);

  // Show sample results
  const withActions = threadsToSummarize.filter(t => t.next_action);
  console.log(`  Threads with next actions: ${withActions.length}\n`);
  for (const t of withActions.slice(0, 10)) {
    // Subject might be on the thread row from Supabase or the messages
    const subj = t.subject || t.messages?.[0]?.subject || '(no subject)';
    console.log(`  [${t.classification}] ${subj.substring(0, 60)}`);
    console.log(`    Summary: ${t.summary?.substring(0, 120)}`);
    console.log(`    Next: ${t.next_action} (due: ${t.next_action_due}, owner: ${t.next_action_owner})`);
    console.log('');
  }

  console.log('  Done! Run --review to see the full picture.\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (REVIEW_MODE) return runReview();
  if (SUMMARIZE_MODE) return runSummarize();
  if (RECLASSIFY_MODE) return runReclassify();
  return runFetchAndClassify();
}

main().catch(err => {
  console.error('\nError:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
