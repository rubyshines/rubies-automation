#!/usr/bin/env node

/**
 * RUBIES Gmail Daily Sync — Incremental fetch, classify, summarize.
 *
 * Designed for daily use from the unified runner (`daily-sync-all.js`)
 * or standalone: `node email-intelligence/sync/syncGmail.js`
 *
 * Gracefully skips if Gmail creds are not configured.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient, upsert, fetchAllPaginated } = require('../../shared/supabaseClient');
const { getGmail } = require('../lib/gmailClient');
const { listMessages, fetchMessages } = require('../lib/gmailSync');
const { classifyMessages } = require('../lib/classifier');
const { aggregateThreads, summarizeThreads, upsertThreads } = require('../lib/threadBuilder');

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Gmail Sync — starting');

  let messagesFetched = 0;
  let messagesClassified = 0;
  let threadsSummarized = 0;
  let hadError = false;
  let lastError = null;

  // --- Step 0: Check Gmail creds ---
  let gmail;
  try {
    gmail = await getGmail();
  } catch (err) {
    console.warn(`  Gmail auth failed — skipping: ${err.message}`);
    return {
      sources: { gmail: { success: false, rowsWritten: 0, error: err.message } },
      status: 'failure',
    };
  }

  const supabase = getSupabaseClient();

  // --- Step 1: Determine high-water mark ---
  const { data: latest } = await supabase
    .from('email_messages')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  let afterDate;
  if (latest?.[0]?.date) {
    // Overlap by 6 hours for safety (dedup handled by gmail_message_id PK)
    const d = new Date(latest[0].date);
    d.setHours(d.getHours() - 6);
    afterDate = d;
  } else {
    // No messages yet — fetch last 30 days
    const d = new Date();
    d.setDate(d.getDate() - 30);
    afterDate = d;
  }

  console.log(`  Fetching messages after ${afterDate.toISOString().split('T')[0]}...`);

  // --- Step 2: List + dedup ---
  try {
    const messageList = await listMessages(gmail, { afterDate });
    console.log(`  Found ${messageList.length} message IDs`);

    // Check which we already have
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
    console.log(`  Already synced: ${existingIds.size}, New: ${newIds.length}`);

    if (newIds.length === 0) {
      console.log('  No new messages.');
      return {
        sources: {
          gmail: { success: true, rowsWritten: 0 },
        },
        status: 'ok',
      };
    }

    // --- Step 3: Fetch full messages ---
    const messages = await fetchMessages(gmail, newIds.map(m => m.id), {
      onProgress: (done, total) => process.stderr.write(`  Fetched ${done}/${total}...\r`),
    });
    messagesFetched = messages.length;
    console.log(`  Fetched ${messages.length} messages`);

    // --- Step 4: Classify ---
    const classified = await classifyMessages(messages);
    messagesClassified = classified.length;

    // --- Step 5: Save messages ---
    const rows = classified.map(m => ({
      gmail_message_id: m.gmail_message_id,
      gmail_thread_id: m.gmail_thread_id,
      subject: m.subject,
      from_address: m.from_address,
      from_name: m.from_name,
      to_addresses: m.to_addresses,
      cc_addresses: m.cc_addresses,
      date: m.date,
      body_text: m.classification === 'spam' ? null : m.body_text,
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
    }));

    await upsert('email_messages', rows, ['gmail_message_id']);
    console.log(`  Saved ${rows.length} messages`);

    // --- Step 6: Rebuild thread stats from the FULL thread ---
    // Aggregate from every stored message in each affected thread (not just the
    // newly-fetched ones) so message_count / first_message_at / participants
    // reflect the whole thread. Load once and reuse for summarization below.
    const affectedThreadIds = [...new Set(
      classified.filter(m => m.classification !== 'skip').map(m => m.gmail_thread_id)
    )];

    if (affectedThreadIds.length > 0) {
      const allMsgs = await fetchAllPaginated(() => supabase
        .from('email_messages')
        .select('*')
        .in('gmail_thread_id', affectedThreadIds)
        .neq('classification', 'skip')
        .order('date', { ascending: true })
        .order('gmail_message_id', { ascending: true }));

      const threads = aggregateThreads(allMsgs || []);
      // Structural pass: omit the summary columns so an existing thread's
      // summary/next_action survives (they are written by the pass below).
      await upsertThreads(threads, { includeSummary: false });
      console.log(`  Updated ${threads.length} threads`);

      // --- Step 7: Summarize new/updated threads (skip internal, spam, skip) ---
      const msgsByThread = new Map();
      for (const msg of (allMsgs || [])) {
        if (!msgsByThread.has(msg.gmail_thread_id)) msgsByThread.set(msg.gmail_thread_id, []);
        msgsByThread.get(msg.gmail_thread_id).push(msg);
      }

      const threadsToSummarize = threads
        .filter(t => !['skip', 'internal', 'spam'].includes(t.classification))
        .map(t => ({ ...t, messages: msgsByThread.get(t.gmail_thread_id) || [] }))
        .filter(t => t.messages.length > 0);

      if (threadsToSummarize.length > 0) {
        console.log(`  Summarizing ${threadsToSummarize.length} threads...`);
        await summarizeThreads(threadsToSummarize, {
          onProgress: (done, total) => process.stderr.write(`  Summarized ${done}/${total}...\r`),
        });
        await upsertThreads(threadsToSummarize, { includeSummary: true });
        threadsSummarized = threadsToSummarize.length;
        console.log(`  Summarized ${threadsSummarized} threads`);
      }
    }

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    hadError = true;
    lastError = err.message;
  }

  const totalRows = messagesFetched + threadsSummarized;

  return {
    sources: {
      gmail_messages: {
        success: !hadError,
        rowsWritten: messagesFetched,
        error: hadError ? lastError : undefined,
      },
      gmail_threads: {
        success: !hadError,
        rowsWritten: threadsSummarized,
        error: hadError ? lastError : undefined,
      },
    },
    status: hadError ? 'failure' : 'ok',
  };
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------

if (require.main === module) {
  run()
    .then(result => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      if (result.status !== 'ok') process.exit(1);
    })
    .catch(err => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
