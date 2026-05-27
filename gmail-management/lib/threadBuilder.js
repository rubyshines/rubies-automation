/**
 * Thread Builder — Aggregate messages into threads, summarize, determine next actions.
 *
 * Key design:
 *   - Incremental summaries: when a thread already has a summary, feed the
 *     existing summary + only new messages to Sonnet (cheaper + preserves context).
 *   - Next action + due date determined on every summary pass.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { OUR_ADDRESS, FOLLOW_UP_CADENCE, AREA_URGENCY } = require('../config');

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Thread aggregation (structural — no AI)
// ---------------------------------------------------------------------------

/**
 * Build thread rows from an array of classified messages.
 * Groups by gmail_thread_id and computes structural fields.
 */
function aggregateThreads(messages) {
  const threadMap = new Map();

  for (const msg of messages) {
    if (msg.classification === 'skip') continue;

    const tid = msg.gmail_thread_id;
    if (!threadMap.has(tid)) {
      threadMap.set(tid, {
        gmail_thread_id: tid,
        subject: msg.subject,
        messages: [],
        participants: new Set(),
        classifications: new Map(), // classification → count
      });
    }

    const thread = threadMap.get(tid);
    thread.messages.push(msg);

    // Track participants
    if (msg.from_address) thread.participants.add(msg.from_address);
    (msg.to_addresses || []).forEach(a => thread.participants.add(a));

    // Track classifications (majority vote)
    if (msg.classification && msg.classification !== 'sent') {
      const c = msg.classification;
      thread.classifications.set(c, (thread.classifications.get(c) || 0) + 1);
    }
  }

  // Build thread rows
  const threads = [];
  for (const [tid, thread] of threadMap) {
    // Sort messages by date
    thread.messages.sort((a, b) => new Date(a.date) - new Date(b.date));
    const first = thread.messages[0];
    const last = thread.messages[thread.messages.length - 1];

    // Classification: majority vote from non-sent messages
    let classification = 'internal';
    let maxCount = 0;
    for (const [c, count] of thread.classifications) {
      if (count > maxCount) { classification = c; maxCount = count; }
    }

    // Who sent last? If us → awaiting them. If them → awaiting us.
    const lastSender = last.from_address;
    const awaiting = lastSender === OUR_ADDRESS ? 'them' : 'us';

    threads.push({
      gmail_thread_id: tid,
      subject: first.subject || last.subject,
      classification,
      participants: [...thread.participants],
      message_count: thread.messages.length,
      first_message_at: first.date,
      last_message_at: last.date,
      last_sender: lastSender,
      awaiting_response_from: awaiting,
      is_active: true,
      messages: thread.messages, // keep for summarization, not stored
    });
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Consecutive no-response count
// ---------------------------------------------------------------------------

function countConsecutiveNoResponses(messages) {
  // Count how many consecutive messages from us at the end of the thread
  // (i.e., we sent N messages and they haven't replied)
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].is_sent) count++;
    else break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// AI-powered summarization + next action
// ---------------------------------------------------------------------------

/**
 * Summarize a thread and determine next action.
 *
 * If existingSummary is provided, does an incremental update:
 *   sends existing summary + only new messages → cheaper.
 */
async function summarizeThread(thread, { existingSummary, existingNextAction, summaryUpdatedAt } = {}) {
  const messages = thread.messages || [];
  if (messages.length === 0) return null;

  // Determine which messages are "new" (after the last summary)
  let newMessages = messages;
  let isIncremental = false;
  if (existingSummary && summaryUpdatedAt) {
    const cutoff = new Date(summaryUpdatedAt);
    newMessages = messages.filter(m => new Date(m.date) > cutoff);
    if (newMessages.length === 0) return null; // nothing new
    isIncremental = true;
  }

  // Build message text for the prompt
  // For full summaries: first message + last 9 (cap at 10)
  // For incremental: existing summary + new messages
  let messageText;
  if (isIncremental) {
    const newMsgText = newMessages.map(m =>
      `[${new Date(m.date).toISOString().split('T')[0]}] ${m.is_sent ? 'Us (Jamie)' : m.from_name || m.from_address}: ${(m.body_text || '').substring(0, 2000)}`
    ).join('\n\n---\n\n');

    messageText = `EXISTING SUMMARY (up to ${summaryUpdatedAt}):\n${existingSummary}\n\nCURRENT NEXT ACTION: ${existingNextAction || 'none'}\n\nNEW MESSAGES SINCE THEN:\n${newMsgText}`;
  } else {
    // Full summary: first + last 9
    let selectedMsgs = messages;
    if (messages.length > 10) {
      selectedMsgs = [messages[0], ...messages.slice(-9)];
    }
    messageText = selectedMsgs.map(m =>
      `[${new Date(m.date).toISOString().split('T')[0]}] ${m.is_sent ? 'Us (Jamie)' : m.from_name || m.from_address}: ${(m.body_text || '').substring(0, 2000)}`
    ).join('\n\n---\n\n');
  }

  const noResponseCount = countConsecutiveNoResponses(messages);
  const lastMessageDate = new Date(messages[messages.length - 1].date);
  const daysSinceLastMessage = Math.floor((Date.now() - lastMessageDate.getTime()) / (1000 * 60 * 60 * 24));

  const prompt = isIncremental
    ? `You are updating a conversation summary for a small gender-affirming underwear brand called RUBIES. The owner is Jamie.

${messageText}

Update the summary incorporating the new messages. Keep it concise (2-4 sentences). Then determine the next action.

Today is ${new Date().toISOString().split('T')[0]}. The last message was ${daysSinceLastMessage} day(s) ago. ${noResponseCount > 0 ? `We sent the last ${noResponseCount} message(s) with no reply.` : 'They sent the most recent message.'}

Return JSON:
{
  "summary": "Updated 2-4 sentence summary of the full conversation",
  "key_decisions": ["any new decisions or commitments from the new messages"],
  "next_action": "specific one-sentence action item, or null if thread is concluded",
  "next_action_owner": "us" or "them" or null,
  "suggested_days_until_action": number or null,
  "is_concluded": true/false
}`
    : `Summarize this email thread for a small gender-affirming underwear brand called RUBIES. The owner is Jamie.

THREAD SUBJECT: ${thread.subject}
CLASSIFICATION: ${thread.classification}
MESSAGES (${messages.length} total${messages.length > 10 ? ', showing first + last 9' : ''}):

${messageText}

Today is ${new Date().toISOString().split('T')[0]}. The last message was ${daysSinceLastMessage} day(s) ago. ${noResponseCount > 0 ? `We sent the last ${noResponseCount} message(s) with no reply.` : 'They sent the most recent message.'}

Return JSON:
{
  "summary": "Concise 2-4 sentence summary of the conversation",
  "key_decisions": ["decisions or commitments made in this thread"],
  "next_action": "specific one-sentence action item, or null if thread is concluded",
  "next_action_owner": "us" or "them" or null,
  "suggested_days_until_action": number or null,
  "is_concluded": true/false
}`;

  const response = await callClaude({
    component: 'gmail_thread_builder',
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const result = JSON.parse(jsonStr);

    // Calculate next_action_due from suggested_days or cadence
    let nextActionDue = null;
    if (result.next_action && !result.is_concluded) {
      let days = result.suggested_days_until_action;
      if (!days || days <= 0) {
        // Fall back to cadence-based calculation
        const baseDays = FOLLOW_UP_CADENCE[Math.min(noResponseCount, 5)] || 7;
        const urgencyMultiplier = AREA_URGENCY[thread.classification] || 1.0;
        days = Math.max(1, Math.round(baseDays * urgencyMultiplier));
      }
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + days);
      nextActionDue = dueDate.toISOString().split('T')[0];
    }

    return {
      summary: result.summary,
      key_decisions: result.key_decisions || [],
      next_action: result.next_action || null,
      next_action_owner: result.next_action_owner || null,
      next_action_due: nextActionDue,
      is_active: !result.is_concluded,
      summary_updated_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error('Failed to parse summary response:', e.message);
    return null;
  }
}

/**
 * Summarize multiple threads, respecting existing summaries for incremental updates.
 * Fetches existing thread data from Supabase to check for prior summaries.
 */
async function summarizeThreads(threads, { onProgress } = {}) {
  const supabase = getSupabaseClient();

  // Load existing thread summaries
  const threadIds = threads.map(t => t.gmail_thread_id);
  const { data: existingThreads } = await supabase
    .from('email_threads')
    .select('gmail_thread_id, summary, next_action, summary_updated_at')
    .in('gmail_thread_id', threadIds);

  const existingMap = new Map(
    (existingThreads || []).map(t => [t.gmail_thread_id, t])
  );

  let completed = 0;
  for (const thread of threads) {
    const existing = existingMap.get(thread.gmail_thread_id);
    const result = await summarizeThread(thread, {
      existingSummary: existing?.summary,
      existingNextAction: existing?.next_action,
      summaryUpdatedAt: existing?.summary_updated_at,
    });

    if (result) {
      Object.assign(thread, result);
    }

    completed++;
    if (onProgress) onProgress(completed, threads.length);
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Save threads to Supabase
// ---------------------------------------------------------------------------

async function upsertThreads(threads) {
  const supabase = getSupabaseClient();
  const rows = threads.map(t => ({
    gmail_thread_id: t.gmail_thread_id,
    subject: t.subject,
    classification: t.classification,
    participants: t.participants,
    message_count: t.message_count,
    first_message_at: t.first_message_at,
    last_message_at: t.last_message_at,
    last_sender: t.last_sender,
    awaiting_response_from: t.awaiting_response_from,
    summary: t.summary || null,
    summary_updated_at: t.summary_updated_at || null,
    key_decisions: t.key_decisions || null,
    next_action: t.next_action || null,
    next_action_due: t.next_action_due || null,
    next_action_owner: t.next_action_owner || null,
    is_active: t.is_active !== undefined ? t.is_active : true,
    updated_at: new Date().toISOString(),
  }));

  // Batch upsert in chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase.from('email_threads').upsert(batch, {
      onConflict: 'gmail_thread_id',
    });
    if (error) throw new Error(`Failed to upsert threads: ${error.message}`);
  }

  return rows.length;
}

module.exports = {
  aggregateThreads,
  summarizeThread,
  summarizeThreads,
  upsertThreads,
  countConsecutiveNoResponses,
};
