#!/usr/bin/env node

/**
 * Extract Tone Samples from Conversations
 *
 * Mines successful conversations for Jamie's signature phrases, framing patterns,
 * and language style. These become few-shot examples that the AI agent references
 * to sound like Jamie rather than generic CS.
 *
 * This extracts HOW Jamie says things, not WHAT decisions were made.
 * (Decision rules are handled by extractExchangeRules.js)
 *
 * Situations captured:
 *   - opening_exchange: how Jamie opens an exchange conversation
 *   - explaining_donation: how Jamie frames the donation program
 *   - nudge_toward_exchange: how Jamie gently steers away from refund
 *   - product_not_working_probe: how Jamie asks "what didn't work?"
 *   - sizing_recommendation: how Jamie presents size change options
 *   - parent_sensitivity: language for parent/kid conversations
 *   - defect_photo_request: how Jamie asks for a defect photo without sounding distrustful
 *   - closing_positive: how Jamie closes a conversation warmly
 *   - empathy_acknowledgment: how Jamie acknowledges frustration/disappointment
 *   - expectation_explanation: how Jamie explains shaping vs. tucking
 *
 * Usage:
 *   node customer-service/import/extractToneSamples.js
 *   node customer-service/import/extractToneSamples.js --limit 100
 *   node customer-service/import/extractToneSamples.js --dry-run
 *   node customer-service/import/extractToneSamples.js --category exchange_return
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const BATCH_SIZE = 8; // Fewer per batch than rules — need full message context
const DEFAULT_LIMIT = 150;

const args = process.argv.slice(2);
const limit = parseInt(args.find((_, i, a) => a[i - 1] === '--limit') || DEFAULT_LIMIT, 10);
const categoryFilter = args.find((_, i, a) => a[i - 1] === '--category') || null;
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Tone extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are analyzing customer service conversations from RUBIES, a gender-affirming underwear brand. Your job is to extract the AGENT's signature phrases, framing patterns, and language style — NOT what decisions were made, but HOW things were said.

Focus on agent messages that are:
- Warm but not saccharine
- Specific rather than generic (don't extract "Happy to help!" — extract phrases unique to this brand/agent)
- Effective at building trust, easing anxiety, or turning a negative into a positive
- Distinctively voiced — if you could tell it's THIS agent vs. a random CS bot, extract it

For each conversation batch, extract tone samples. Each sample should have:
{
  "situation": one of: "opening_exchange", "explaining_donation", "nudge_toward_exchange", "product_not_working_probe", "sizing_recommendation", "parent_sensitivity", "defect_photo_request", "closing_positive", "empathy_acknowledgment", "expectation_explanation",
  "agent_message": the EXACT agent message (or the key portion — keep it under 300 chars). Do NOT paraphrase. Copy their actual words.,
  "context": what the customer said right before this (1 sentence summary),
  "conversation_id": the conversation ID this came from,
  "tags": relevant tags like ["sizing", "empathetic", "parent", "refund", "donation"]
}

Rules:
- Extract 3-6 samples per batch. Quality over quantity.
- ONLY extract from AGENT messages, never customer messages.
- Prefer messages that show personality, not just information delivery.
- If the agent uses the same phrasing across multiple conversations, that's a signature phrase — flag it.
- Skip generic responses like "Let me look into that" or "Thank you for your patience."
- DO extract:
  - How they ask for measurements (the specific wording)
  - How they explain the donation program (the framing)
  - How they handle "this doesn't work" (the probe question)
  - How they close conversations (the farewell style)
  - How they acknowledge frustration without being sycophantic
  - How they frame size changes ("gives you an extra 2 inches" vs "should be less tight")

Return ONLY a JSON array. No markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Fetch conversations with full messages (need agent's actual words)
// ---------------------------------------------------------------------------

async function fetchConversations(supabase) {
  let query = supabase
    .from('cs_conversations')
    .select('id, customer_email, subject, category, resolution_type, resolution_successful, summary, created_at')
    .eq('resolution_successful', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (categoryFilter) {
    query = query.eq('category', categoryFilter);
  } else {
    // Focus on exchange/return and sizing conversations — richest tone data
    query = query.in('category', ['exchange_return', 'sizing_fit', 'product_info']);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);
  return data || [];
}

async function fetchMessages(supabase, conversationIds) {
  const { data: messages, error } = await supabase
    .from('cs_messages')
    .select('conversation_id, sender_type, sender_name, body_text, created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch messages: ${error.message}`);

  const byConv = {};
  for (const m of (messages || [])) {
    if (!byConv[m.conversation_id]) byConv[m.conversation_id] = [];
    byConv[m.conversation_id].push(m);
  }
  return byConv;
}

// ---------------------------------------------------------------------------
// Extract tone samples via Claude Sonnet
// ---------------------------------------------------------------------------

async function extractToneFromBatch(client, conversations, messagesByConv) {
  let conversationText = '';
  for (const conv of conversations) {
    const msgs = messagesByConv[conv.id] || [];
    if (msgs.length < 2) continue; // Need at least a back-and-forth

    conversationText += `\n--- Conversation: ${conv.id} (${conv.category}) ---\n`;
    conversationText += `Subject: ${conv.subject || 'N/A'}\n`;
    conversationText += `Resolution: ${conv.resolution_type} (successful)\n`;
    conversationText += 'Messages:\n';

    // Include more messages for tone extraction — we need full context
    for (const m of msgs.slice(0, 12)) {
      const sender = m.sender_type === 'customer' ? 'Customer' : 'Agent';
      const text = m.body_text?.slice(0, 600) || '';
      conversationText += `  [${sender}]: ${text}\n`;
    }
    if (msgs.length > 12) {
      conversationText += `  ... (${msgs.length - 12} more messages)\n`;
    }
  }

  if (!conversationText.trim()) return [];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\nHere are ${conversations.length} conversations to analyze for tone:\n${conversationText}\n\nReturn ONLY a JSON array of tone samples.`,
    }],
  });

  const text = response.content[0]?.text || '[]';
  const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('  [Warning] Failed to parse AI response:', e.message);
    console.error('  Preview:', text.slice(0, 200));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate — same message appearing in multiple batches
// ---------------------------------------------------------------------------

function deduplicateSamples(samples) {
  const seen = new Map();

  for (const sample of samples) {
    if (!sample.agent_message || !sample.situation) continue;

    // Normalize for dedup: lowercase, trim, collapse whitespace
    const key = sample.agent_message.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);

    if (seen.has(key)) {
      // Keep the one with more context
      const existing = seen.get(key);
      if ((sample.context?.length || 0) > (existing.context?.length || 0)) {
        seen.set(key, sample);
      }
    } else {
      seen.set(key, sample);
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Save to Supabase
// ---------------------------------------------------------------------------

async function saveSamples(supabase, samples) {
  let saved = 0;
  for (const sample of samples) {
    const { error } = await supabase
      .from('cs_tone_samples')
      .insert({
        situation: sample.situation,
        agent_message: sample.agent_message.slice(0, 500),
        context: sample.context?.slice(0, 300) || null,
        conversation_id: sample.conversation_id || null,
        tags: sample.tags || [],
        active: true, // Tone samples are active by default (less risky than decision rules)
        source: 'extracted',
      });

    if (error) {
      console.error(`  [Error] ${sample.situation}: ${error.message}`);
    } else {
      saved++;
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseClient();
  const client = new Anthropic();

  console.log('Extracting Tone Samples');
  console.log('=======================\n');

  const conversations = await fetchConversations(supabase);
  if (conversations.length === 0) {
    console.log('No conversations found. Import conversations first.');
    return;
  }
  console.log(`Found ${conversations.length} successful conversations`);

  // Filter to conversations that have enough agent messages
  const convIds = conversations.map(c => c.id);
  const allMessages = await fetchMessages(supabase, convIds);

  // Only process conversations with 3+ agent messages (enough to show voice)
  const richConvs = conversations.filter(c => {
    const msgs = allMessages[c.id] || [];
    const agentMsgs = msgs.filter(m => m.sender_type === 'agent');
    return agentMsgs.length >= 2;
  });

  console.log(`${richConvs.length} conversations have 2+ agent messages\n`);

  // Process in batches
  const allSamples = [];
  for (let i = 0; i < richConvs.length; i += BATCH_SIZE) {
    const batch = richConvs.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(c => c.id);
    const batchMessages = {};
    for (const id of batchIds) {
      if (allMessages[id]) batchMessages[id] = allMessages[id];
    }

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(richConvs.length / BATCH_SIZE);
    process.stdout.write(`Batch ${batchNum}/${totalBatches}... `);

    const samples = await extractToneFromBatch(client, batch, batchMessages);
    console.log(`${samples.length} samples`);
    allSamples.push(...samples);

    // Rate limit
    if (i + BATCH_SIZE < richConvs.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Deduplicate
  const unique = deduplicateSamples(allSamples);

  // Group by situation for display
  const bySituation = {};
  for (const s of unique) {
    if (!bySituation[s.situation]) bySituation[s.situation] = [];
    bySituation[s.situation].push(s);
  }

  console.log(`\n========================================`);
  console.log(`Extracted ${allSamples.length} raw → ${unique.length} unique tone samples`);
  console.log(`========================================\n`);

  console.log('By situation:');
  for (const [sit, samples] of Object.entries(bySituation).sort()) {
    console.log(`\n  ${sit} (${samples.length}):`);
    for (const s of samples.slice(0, 3)) {
      const preview = s.agent_message.slice(0, 80);
      console.log(`    "${preview}${s.agent_message.length > 80 ? '...' : ''}"`);
    }
    if (samples.length > 3) {
      console.log(`    ... +${samples.length - 3} more`);
    }
  }

  // Save
  if (!dryRun) {
    console.log(`\nSaving ${unique.length} tone samples to Supabase...`);
    const saved = await saveSamples(supabase, unique);
    console.log(`Saved ${saved}/${unique.length} samples`);
    console.log(`\nTone samples are active by default — the exchange_advisor will use them immediately.`);
  } else {
    console.log('\n[DRY RUN] Samples not saved.');
  }
}

main().catch(err => {
  console.error('[extractToneSamples] Fatal error:', err);
  process.exit(1);
});
