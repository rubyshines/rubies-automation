/**
 * AI-powered conversation categorizer.
 *
 * Processes uncategorized cs_conversations rows (category IS NULL):
 * - Assigns category, subcategories, sentiment
 * - Determines resolution success and type
 * - Generates a summary
 *
 * Invoked by the historical import (runImport.js) and the daily sync
 * ("Conversation Categorizer" sub-pipeline), which keeps the corpus
 * categorized continuously — it went dark 2026-03-12 when the ongoing
 * conversation sync replaced the import path and nothing called this.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Batch classification with a fail-closed fallback ('general') and no
// customer-facing output — Haiku per the model policy.
const MODEL = process.env.AI_MODEL || MODELS.HAIKU;

const CATEGORIES = [
  'sizing_fit',       // sizing questions, fit advice, size comparisons
  'exchange_return',  // exchange requests, returns, refunds
  'order_status',     // where is my order, tracking, delays
  'wholesale',        // wholesale inquiries, retailer orders
  'shipping',         // shipping costs, international shipping, delivery times
  'product_info',     // product materials, care instructions, product comparisons
  'payment',          // payment issues, discount codes, billing
  'general',          // everything else
];

const RESOLUTION_TYPES = ['exchange', 'refund', 'info_provided', 'no_action', 'escalated', 'other'];

const SYSTEM_PROMPT = `You are a customer service conversation analyzer for RUBIES, a gender-affirming underwear brand.

Analyze the conversation and return a JSON object with:
- category: one of [${CATEGORIES.join(', ')}]
- subcategories: array of secondary categories that also apply (can be empty)
- sentiment: "positive", "neutral", or "negative" (the customer's overall sentiment)
- resolution_successful: true if the customer seemed satisfied, false if not, null if unclear
- resolution_type: one of [${RESOLUTION_TYPES.join(', ')}]
- summary: 1-2 sentence summary of the conversation and outcome

RUBIES products: AJ, Charlie, Brooke, Ruby (youth/numeric sizing: 4-16), Ava, Cheeky, Sassy (letter sizing: XXS-4X).

Return ONLY valid JSON, no markdown or explanation.`;

/**
 * Build a prompt from a conversation and its messages.
 */
function buildPrompt(conversation, messages) {
  let text = '';
  if (conversation.subject) text += `Subject: ${conversation.subject}\n`;
  if (conversation.customer_email) text += `Customer: ${conversation.customer_email}\n`;
  if (conversation.tags?.length) text += `Tags: ${conversation.tags.join(', ')}\n`;
  text += `Channel: ${conversation.channel || 'unknown'}\n`;
  text += `Status: ${conversation.status || 'unknown'}\n\n`;

  text += 'Messages:\n';
  for (const m of messages.slice(0, 10)) { // Cap at 10 messages to control cost
    const sender = m.sender_type === 'customer' ? 'Customer' : 'Agent';
    const body = m.body_text.slice(0, 500); // Cap each message
    text += `[${sender}]: ${body}\n\n`;
  }

  return text.slice(0, 4000); // Hard cap for token management
}

/**
 * Parse + validate the model's JSON response into an update payload.
 * Returns null when the response is unparseable.
 */
function parseCategorizerResponse(text) {
  let result;
  try {
    // Handle possible markdown wrapping
    const jsonStr = String(text || '').replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    result = JSON.parse(jsonStr);
  } catch (parseErr) {
    return null;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

  return {
    category: CATEGORIES.includes(result.category) ? result.category : 'general',
    subcategories: Array.isArray(result.subcategories)
      ? result.subcategories.filter((s) => CATEGORIES.includes(s))
      : [],
    sentiment: ['positive', 'neutral', 'negative'].includes(result.sentiment)
      ? result.sentiment
      : 'neutral',
    resolution_successful: typeof result.resolution_successful === 'boolean'
      ? result.resolution_successful
      : null,
    resolution_type: RESOLUTION_TYPES.includes(result.resolution_type)
      ? result.resolution_type
      : 'other',
    summary: typeof result.summary === 'string' && result.summary.trim()
      ? result.summary.trim()
      : null,
  };
}

/**
 * Categorize a batch of uncategorized conversations.
 * Returns { processed, categorized, remaining }.
 */
async function categorizeConversations({ batchSize = 20 } = {}) {
  const supabase = getSupabaseClient();

  // Find uncategorized conversations
  const { data: convos, error } = await supabase
    .from('cs_conversations')
    .select('id, subject, customer_email, status, channel, tags')
    .is('category', null)
    .limit(batchSize);

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!convos || !convos.length) {
    console.log('[Categorize] No uncategorized conversations found. All done!');
    return { processed: 0, categorized: 0, remaining: 0 };
  }

  console.log(`[Categorize] Processing ${convos.length} conversations...`);
  let categorized = 0;

  for (const conv of convos) {
    try {
      // Fetch messages
      const { data: messages } = await supabase
        .from('cs_messages')
        .select('sender_type, body_text, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(10);

      if (!messages || !messages.length) {
        // No messages to classify — mark 'general' so the row doesn't
        // requeue forever (the pre-2026 import had the same dead rows).
        await supabase.from('cs_conversations')
          .update({ category: 'general', summary: null })
          .eq('id', conv.id);
        console.log(`[Categorize] ${conv.id} has no messages — marked general`);
        continue;
      }

      const prompt = buildPrompt(conv, messages);

      const response = await callClaude({
        component: 'conv_categorizer',
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.text || '';
      const update = parseCategorizerResponse(text);
      if (!update) {
        console.error(`[Categorize] Could not parse response for ${conv.id}:`, text.slice(0, 200));
        continue;
      }

      const { error: updateErr } = await supabase
        .from('cs_conversations')
        .update(update)
        .eq('id', conv.id);

      if (updateErr) {
        console.error(`[Categorize] Error updating ${conv.id}:`, updateErr.message);
      } else {
        categorized++;
        if (categorized % 5 === 0) {
          console.log(`[Categorize] Processed ${categorized}/${convos.length}...`);
        }
      }

      // Small delay to respect API rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`[Categorize] Error processing ${conv.id}:`, err.message);
    }
  }

  console.log(`\n[Categorize] Done! Categorized ${categorized}/${convos.length} conversations.`);

  // Check remaining
  const { count } = await supabase
    .from('cs_conversations')
    .select('id', { count: 'exact', head: true })
    .is('category', null);

  if (count > 0) {
    console.log(`[Categorize] ${count} more conversations need categorization. Run again to continue.`);
  }
  return { processed: convos.length, categorized, remaining: count || 0 };
}

/**
 * Daily-sync entry point: drain the uncategorized queue up to a daily cap.
 * Normal daily volume is ~10-30 new conversations; the cap only matters if
 * the categorizer has been dark and a backlog built up.
 */
async function run({ maxPerRun = 200, batchSize = 20 } = {}) {
  let total = 0;
  let categorized = 0;
  for (let i = 0; i < Math.ceil(maxPerRun / batchSize); i++) {
    const stats = await categorizeConversations({ batchSize });
    total += stats.processed;
    categorized += stats.categorized;
    if (stats.remaining === 0 || stats.processed === 0) break;
  }
  return { processed: total, categorized };
}

module.exports = { categorizeConversations, run, parseCategorizerResponse, CATEGORIES, RESOLUTION_TYPES };
