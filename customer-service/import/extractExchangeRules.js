#!/usr/bin/env node

/**
 * Extract Exchange Decision Rules from Conversations
 *
 * Mines successful exchange conversations from Supabase using Claude Sonnet
 * to extract structured decision patterns, sizing triage approaches,
 * multi-item handling, and tone/framing examples.
 *
 * Usage:
 *   node customer-service/import/extractExchangeRules.js
 *   node customer-service/import/extractExchangeRules.js --limit 50     # process fewer conversations
 *   node customer-service/import/extractExchangeRules.js --category sizing_exchange
 *   node customer-service/import/extractExchangeRules.js --dry-run      # extract but don't save
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { MODELS } = require('../../shared/aiPricing');

const BATCH_SIZE = 10;
const DEFAULT_LIMIT = 200;

// Subcategories to mine, in priority order
const SUBCATEGORIES = [
  { filter: 'sizing', label: 'Sizing exchanges', weight: 3 },
  { filter: 'product_switch', label: 'Product switches', weight: 1 },
  { filter: 'multi_item', label: 'Multi-item exchanges', weight: 1 },
  { filter: 'refund_conversion', label: 'Refund-to-exchange conversions', weight: 1 },
  { filter: 'failed', label: 'Failed exchanges', weight: 1, successful: false },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const limit = parseInt(args.find((_, i, a) => a[i - 1] === '--limit') || DEFAULT_LIMIT, 10);
const categoryFilter = args.find((_, i, a) => a[i - 1] === '--category') || null;
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Fetch exchange conversations from Supabase
// ---------------------------------------------------------------------------

async function fetchExchangeConversations(supabase, maxCount) {
  console.log(`Fetching up to ${maxCount} exchange conversations...`);

  let query = supabase
    .from('cs_conversations')
    .select('id, customer_email, subject, category, resolution_type, resolution_successful, summary, created_at')
    .eq('category', 'exchange_return')
    .order('created_at', { ascending: false })
    .limit(maxCount);

  const { data: conversations, error } = await query;
  if (error) throw new Error(`Failed to fetch conversations: ${error.message}`);

  console.log(`Found ${conversations?.length || 0} exchange conversations`);
  return conversations || [];
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
// Extract rules via Claude Sonnet
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are analyzing customer service conversations from RUBIES, a gender-affirming underwear brand. Your job is to extract structured decision rules from successful exchange/return conversations.

For each batch of conversations, extract:

1. **Decision patterns**: What triggered the exchange? How was the decision made?
2. **Sizing triage type**: close-fit (1-2 sizes off), way-off (wrong size system), measurement-based
3. **Multi-item handling**: Did the agent proactively check if other items needed exchanging?
4. **Measurement usage**: Were measurements requested? In inches or cm? For which body part?
5. **Product-specific fit notes**: Any product-specific sizing observations (e.g., "AJ runs small")
6. **Tone/framing**: How did the agent frame the exchange offer? What language worked well?
7. **Anti-patterns**: Anything the agent did poorly or that led to a worse outcome

Return a JSON array of extracted rules. Each rule should have:
{
  "rule_key": "kebab-case-slug",
  "category": "sizing_exchange|product_switch|multi_item|refund_conversion|defect|product_not_working",
  "condition_description": "When this rule applies",
  "action_description": "What to do",
  "priority": 50,  // 0-100, higher = more important
  "examples": [{"conversation_id": "...", "summary": "brief summary"}],
  "anti_patterns": ["things NOT to do"]
}

Merge similar patterns into single rules. Aim for quality over quantity — 3-8 well-defined rules per batch is ideal.

Focus on rules that are:
- Repeatable and consistent (not one-off situations)
- Actionable (clear enough for an AI agent to follow)
- Non-obvious (don't extract rules like "be polite" — extract sizing-specific, product-specific patterns)

IMPORTANT: RUBIES creates feminine shaping (mound), NOT flattening. This is by design. When customers say "it doesn't work," it's often an expectation mismatch, not a defect.`;

async function extractRulesFromBatch(client, conversations, messagesByConv) {
  // Format conversations for the prompt
  let conversationText = '';
  for (const conv of conversations) {
    conversationText += `\n--- Conversation: ${conv.id} ---\n`;
    conversationText += `Subject: ${conv.subject || 'N/A'}\n`;
    conversationText += `Resolution: ${conv.resolution_type} (${conv.resolution_successful ? 'successful' : 'failed'})\n`;
    conversationText += `Summary: ${conv.summary || 'N/A'}\n`;

    const msgs = messagesByConv[conv.id] || [];
    if (msgs.length > 0) {
      conversationText += 'Messages:\n';
      for (const m of msgs.slice(0, 8)) { // Cap at 8 messages per conv
        const sender = m.sender_type === 'customer' ? 'Customer' : 'Agent';
        const text = m.body_text?.slice(0, 500) || '';
        conversationText += `  [${sender}]: ${text}\n`;
      }
      if (msgs.length > 8) {
        conversationText += `  ... (${msgs.length - 8} more messages)\n`;
      }
    }
  }

  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\nHere are ${conversations.length} exchange conversations to analyze:\n${conversationText}\n\nReturn ONLY a JSON array of extracted rules. No markdown fences, no explanation.`,
    }],
  });

  const text = response.content[0]?.text || '[]';

  // Parse JSON — handle potential markdown fences
  const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('  [Warning] Failed to parse AI response as JSON:', e.message);
    console.error('  Response preview:', text.slice(0, 200));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplicate and merge rules
// ---------------------------------------------------------------------------

function mergeRules(allRules) {
  const byKey = new Map();

  for (const rule of allRules) {
    if (!rule.rule_key || !rule.category) continue;

    const existing = byKey.get(rule.rule_key);
    if (existing) {
      // Merge examples
      existing.examples = [...(existing.examples || []), ...(rule.examples || [])].slice(0, 5);
      existing.anti_patterns = [...new Set([...(existing.anti_patterns || []), ...(rule.anti_patterns || [])])];
      // Keep higher priority
      existing.priority = Math.max(existing.priority || 50, rule.priority || 50);
    } else {
      byKey.set(rule.rule_key, { ...rule });
    }
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Save to Supabase
// ---------------------------------------------------------------------------

async function saveRules(supabase, rules) {
  let saved = 0;
  for (const rule of rules) {
    const { error } = await supabase
      .from('exchange_decision_rules')
      .upsert({
        rule_key: rule.rule_key,
        category: rule.category,
        condition_description: rule.condition_description,
        action_description: rule.action_description,
        priority: rule.priority || 50,
        examples: rule.examples || [],
        anti_patterns: rule.anti_patterns || [],
        active: false, // Requires Jamie's review
        source: 'extracted',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'rule_key' });

    if (error) {
      console.error(`  [Error] ${rule.rule_key}: ${error.message}`);
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

  // Fetch conversations
  const conversations = await fetchExchangeConversations(supabase, limit);
  if (conversations.length === 0) {
    console.log('No exchange conversations found. Run cs-import-gorgias first.');
    return;
  }

  // Classify into subcategories based on summary/resolution
  const classified = {
    sizing: [],
    product_switch: [],
    multi_item: [],
    refund_conversion: [],
    failed: [],
    other: [],
  };

  for (const conv of conversations) {
    const text = `${conv.summary || ''} ${conv.subject || ''} ${conv.resolution_type || ''}`.toLowerCase();

    if (!conv.resolution_successful) {
      classified.failed.push(conv);
    } else if (text.includes('size') || text.includes('fit') || text.includes('tight') || text.includes('loose') || text.includes('measurement')) {
      classified.sizing.push(conv);
    } else if (text.includes('different product') || text.includes('switch') || text.includes('instead')) {
      classified.product_switch.push(conv);
    } else if (text.includes('multiple') || text.includes('both') || text.includes('all items')) {
      classified.multi_item.push(conv);
    } else if (text.includes('refund') || text.includes('return')) {
      classified.refund_conversion.push(conv);
    } else {
      classified.other.push(conv);
    }
  }

  console.log('\nConversation breakdown:');
  for (const [cat, convs] of Object.entries(classified)) {
    console.log(`  ${cat}: ${convs.length}`);
  }

  // Process in batches
  const allConvs = categoryFilter
    ? (classified[categoryFilter] || [])
    : [...classified.sizing, ...classified.product_switch, ...classified.multi_item,
       ...classified.refund_conversion, ...classified.failed, ...classified.other];

  console.log(`\nProcessing ${allConvs.length} conversations in batches of ${BATCH_SIZE}...`);

  const allRules = [];
  for (let i = 0; i < allConvs.length; i += BATCH_SIZE) {
    const batch = allConvs.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map(c => c.id);

    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allConvs.length / BATCH_SIZE)} (${batch.length} conversations)`);

    // Fetch messages for this batch
    const messagesByConv = await fetchMessages(supabase, batchIds);

    // Skip conversations with no messages
    const withMessages = batch.filter(c => (messagesByConv[c.id] || []).length > 0);
    if (withMessages.length === 0) {
      console.log('  No messages found, skipping batch');
      continue;
    }

    // Extract rules
    const rules = await extractRulesFromBatch(client, withMessages, messagesByConv);
    console.log(`  Extracted ${rules.length} rules`);
    allRules.push(...rules);

    // Rate limit between batches
    if (i + BATCH_SIZE < allConvs.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Merge duplicate rules
  const mergedRules = mergeRules(allRules);
  console.log(`\n========================================`);
  console.log(`Extracted ${allRules.length} raw rules → ${mergedRules.length} merged rules`);
  console.log(`========================================`);

  // Display rules
  for (const rule of mergedRules) {
    console.log(`\n[${rule.category}] ${rule.rule_key} (priority: ${rule.priority})`);
    console.log(`  When: ${rule.condition_description}`);
    console.log(`  Do: ${rule.action_description}`);
    if (rule.anti_patterns?.length) {
      console.log(`  Don't: ${rule.anti_patterns.join('; ')}`);
    }
  }

  // Save to Supabase
  if (!dryRun) {
    console.log(`\nSaving ${mergedRules.length} rules to Supabase (active=false, awaiting review)...`);
    const saved = await saveRules(supabase, mergedRules);
    console.log(`Saved ${saved}/${mergedRules.length} rules`);
    console.log(`\nNext: run 'node customer-service/import/reviewExchangeRules.js' to review and approve rules.`);
  } else {
    console.log('\n[DRY RUN] Rules not saved to Supabase.');
  }
}

main().catch(err => {
  console.error('[extractExchangeRules] Fatal error:', err);
  process.exit(1);
});
