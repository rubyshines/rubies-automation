/**
 * AI-powered conversation categorizer using Claude Haiku.
 *
 * Processes uncategorized conversations in batches:
 * - Assigns category, subcategories, sentiment
 * - Determines resolution success and type
 * - Generates a summary
 *
 * Uses @anthropic-ai/sdk (already a dependency).
 * Model: MODELS.HAIKU (~$0.01 per conversation)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { MODELS } = require('../../shared/aiPricing');

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

const SYSTEM_PROMPT = `You are a customer service conversation analyzer for RUBIES, a gender-affirming underwear brand.

Analyze the conversation and return a JSON object with:
- category: one of [${CATEGORIES.join(', ')}]
- subcategories: array of secondary categories that also apply (can be empty)
- sentiment: "positive", "neutral", or "negative" (the customer's overall sentiment)
- resolution_successful: true if the customer seemed satisfied, false if not, null if unclear
- resolution_type: one of ["exchange", "refund", "info_provided", "no_action", "escalated", "other"]
- summary: 1-2 sentence summary of the conversation and outcome

RUBIES products: AJ, Charlie, Brooke, Ruby (youth/numeric sizing: 4-16), Ava, Cheeky, Sassy (letter sizing: XXS-4X).

Return ONLY valid JSON, no markdown or explanation.`;

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return new Anthropic({ apiKey });
}

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
 * Categorize a batch of conversations.
 */
async function categorizeConversations({ batchSize = 20 } = {}) {
  const supabase = getSupabaseClient();
  const client = getClient();

  // Find uncategorized conversations
  const { data: convos, error } = await supabase
    .from('cs_conversations')
    .select('id, subject, customer_email, status, channel, tags')
    .is('category', null)
    .limit(batchSize);

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!convos || !convos.length) {
    console.log('[Categorize] No uncategorized conversations found. All done!');
    return;
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
        console.log(`[Categorize] Skipping ${conv.id} — no messages`);
        continue;
      }

      const prompt = buildPrompt(conv, messages);

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.text || '';

      // Parse JSON from response
      let result;
      try {
        // Handle possible markdown wrapping
        const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        result = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.error(`[Categorize] Could not parse response for ${conv.id}:`, text.slice(0, 200));
        continue;
      }

      // Validate category
      if (!CATEGORIES.includes(result.category)) {
        result.category = 'general';
      }

      // Update conversation
      const { error: updateErr } = await supabase
        .from('cs_conversations')
        .update({
          category: result.category,
          subcategories: result.subcategories || [],
          sentiment: result.sentiment || 'neutral',
          resolution_successful: result.resolution_successful,
          resolution_type: result.resolution_type || 'other',
          summary: result.summary || null,
        })
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
}

module.exports = { categorizeConversations };
