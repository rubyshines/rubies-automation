/**
 * CS History MCP Tools — semantic search of past conversations and FAQ patterns
 *
 * Tools: cs_search_history, cs_search_faq
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');

// ---------------------------------------------------------------------------
// Recency weighting by category
// ---------------------------------------------------------------------------
// decay_factor: how much to penalize old conversations (0 = no penalty, 1 = max penalty)
//   0.1 = old answers are almost as good as new ones (sizing — product fit doesn't change)
//   0.3 = moderate preference for recent (wholesale — terms may shift)
//   0.5 = strong preference for recent (shipping — carriers/times change)
//
// half_life_months: at this age, the conversation loses half its recency bonus
//   e.g. 18 months means an 18-month-old conversation is penalized by half of decay_factor
//
// Effective formula: score = similarity * (1 - decay_factor * min(age / (half_life * 2), 1))

const RECENCY_CONFIG = {
  sizing_fit:      { decay_factor: 0.15, half_life_months: 18 }, // Sizing system changed end of 2023. Pre-2024 may reference old youth-only sizes (4-24)
  exchange_return: { decay_factor: 0.30, half_life_months: 12 }, // Donation returns program started mid-2024. Pre-2024 answers are outdated
  product_info:    { decay_factor: 0.25, half_life_months: 18 }, // New products added 2-3x/year. Prefer recent recommendations
  wholesale:       { decay_factor: 0.30, half_life_months: 12 }, // Terms can change. Prefer recent
  payment:         { decay_factor: 0.30, half_life_months: 12 }, // Payment methods evolve
  shipping:        { decay_factor: 0.40, half_life_months: 12 }, // Carriers/times/costs change. Strong recency
  order_status:    { decay_factor: 0.50, half_life_months: 6  }, // Very time-dependent. Recent answers much more relevant
  general:         { decay_factor: 0.10, half_life_months: 36 }, // Brand voice is timeless
};

const DEFAULT_RECENCY = { decay_factor: 0.20, half_life_months: 18 };

// Key dates when major policy/product changes happened — conversations before
// these dates get an extra penalty for affected categories
const BREAKING_CHANGES = [
  {
    date: new Date('2024-01-01'), // Sizing system changed end of 2023
    categories: ['sizing_fit'],
    extra_penalty: 0.3, // Pre-2024 sizing answers penalized an extra 30%
    note: 'Sizing changed from youth-only (4-24) to Youth (4-16) + Adult (XS-4XL)',
  },
  {
    date: new Date('2024-07-01'), // Donation returns program started ~mid 2024
    categories: ['exchange_return'],
    extra_penalty: 0.4, // Pre-mid-2024 return answers are significantly outdated
    note: 'Returns changed from send-back to donation-based program',
  },
];

function computeRecencyWeight(category, createdAt) {
  const config = RECENCY_CONFIG[category] || DEFAULT_RECENCY;
  const created = new Date(createdAt);
  const ageMs = Date.now() - created.getTime();
  const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);
  const maxAgeMonths = config.half_life_months * 2;
  const ageFraction = Math.min(ageMonths / maxAgeMonths, 1);
  let weight = 1 - (config.decay_factor * ageFraction);

  // Apply extra penalty if conversation predates a breaking change
  for (const change of BREAKING_CHANGES) {
    if (change.categories.includes(category) && created < change.date) {
      weight *= (1 - change.extra_penalty);
    }
  }

  return Math.max(weight, 0.1); // Floor at 10% — never completely discard old conversations
}

// Conversations older than this get a warning in the output
const STALENESS_THRESHOLD_MONTHS = 12;

// ---------------------------------------------------------------------------
// Tool: cs_search_history
// ---------------------------------------------------------------------------

async function handleSearchHistory({ query, category, limit, successful_only, months_back }) {
  // Fetch more than needed so we can re-rank with recency weighting
  const maxResults = limit || 5;
  const fetchCount = maxResults * 3; // Over-fetch for re-ranking
  const queryEmbedding = await embed(query);

  const supabase = getSupabaseClient();

  // Use the RPC function for cosine similarity search
  const { data: conversations, error } = await supabase.rpc('cs_search_conversations', {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: fetchCount,
    filter_category: category || null,
    filter_successful: successful_only != null ? successful_only : null,
  });

  // Apply hard date filter if specified
  if (conversations && months_back) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months_back);
    const cutoffStr = cutoff.toISOString();
    conversations.splice(0, conversations.length,
      ...conversations.filter(c => c.created_at >= cutoffStr));
  }

  // Re-rank with category-aware recency weighting
  if (conversations) {
    for (const conv of conversations) {
      const recencyWeight = computeRecencyWeight(conv.category, conv.created_at);
      conv.semantic_similarity = conv.similarity;
      conv.recency_weight = recencyWeight;
      conv.similarity = conv.similarity * recencyWeight; // Combined score
    }
    conversations.sort((a, b) => b.similarity - a.similarity);
    conversations.splice(maxResults); // Trim to requested limit
  }

  if (error) throw new Error(`Search failed: ${error.message}`);
  if (!conversations || !conversations.length) {
    return { content: [{ type: 'text', text: 'No similar past conversations found.' }] };
  }

  // Fetch messages for each conversation
  const convIds = conversations.map(c => c.id);
  const { data: messages, error: msgErr } = await supabase
    .from('cs_messages')
    .select('conversation_id, sender_type, sender_name, body_text, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: true });

  if (msgErr) console.error('[csHistory] Warning: could not fetch messages:', msgErr.message);

  const msgsByConv = {};
  for (const m of (messages || [])) {
    if (!msgsByConv[m.conversation_id]) msgsByConv[m.conversation_id] = [];
    msgsByConv[m.conversation_id].push(m);
  }

  // Format output
  let md = `## Past Conversations (${conversations.length} matches)\n\n`;

  for (const conv of conversations) {
    const relevance = (conv.similarity * 100).toFixed(0);
    const dateStr = conv.created_at ? conv.created_at.split('T')[0] : '—';
    const ageMonths = conv.created_at
      ? Math.round((Date.now() - new Date(conv.created_at).getTime()) / (30 * 24 * 60 * 60 * 1000))
      : null;
    // Check for breaking change warnings
    const created = conv.created_at ? new Date(conv.created_at) : null;
    const warnings = [];
    if (created) {
      for (const change of BREAKING_CHANGES) {
        if (change.categories.includes(conv.category) && created < change.date) {
          warnings.push(change.note);
        }
      }
      if (!warnings.length && ageMonths > STALENESS_THRESHOLD_MONTHS) {
        warnings.push(`${ageMonths} months old — verify against current products/policies`);
      }
    }

    md += `### ${conv.subject || 'Untitled'} (${relevance}% relevance)\n`;
    md += `**Category:** ${conv.category || '—'} | `;
    md += `**Resolution:** ${conv.resolution_type || '—'} | `;
    md += `**Successful:** ${conv.resolution_successful ? 'Yes' : conv.resolution_successful === false ? 'No' : '—'} | `;
    md += `**Date:** ${dateStr}\n`;
    if (warnings.length) {
      md += `**OUTDATED WARNING:** ${warnings.join('; ')}\n`;
    }
    md += '\n';

    if (conv.summary) {
      md += `**Summary:** ${conv.summary}\n\n`;
    }

    // Show conversation messages (cap at 6 to keep context manageable)
    const convMsgs = msgsByConv[conv.id] || [];
    if (convMsgs.length > 0) {
      md += '**Conversation:**\n';
      for (const m of convMsgs.slice(0, 6)) {
        const sender = m.sender_type === 'customer' ? '🔵 Customer' : '🟢 Agent';
        const text = m.body_text.length > 500 ? m.body_text.slice(0, 500) + '...' : m.body_text;
        md += `> **${sender}:** ${text}\n>\n`;
      }
      if (convMsgs.length > 6) {
        md += `> *...${convMsgs.length - 6} more messages*\n`;
      }
      md += '\n';
    }

    md += '---\n\n';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: cs_search_faq
// ---------------------------------------------------------------------------

async function handleSearchFaq({ query, category, limit }) {
  const maxResults = limit || 3;
  const queryEmbedding = await embed(query);

  const supabase = getSupabaseClient();

  const { data: faqs, error } = await supabase.rpc('cs_search_faqs', {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: maxResults,
    filter_category: category || null,
  });

  if (error) throw new Error(`FAQ search failed: ${error.message}`);
  if (!faqs || !faqs.length) {
    return { content: [{ type: 'text', text: 'No matching FAQ patterns found.' }] };
  }

  let md = `## FAQ Patterns (${faqs.length} matches)\n\n`;

  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    const similarity = (faq.similarity * 100).toFixed(0);
    md += `### ${i + 1}. ${faq.question_pattern} (${similarity}% match)\n`;
    md += `**Category:** ${faq.category} | `;
    md += `**Frequency:** ${faq.frequency} occurrences | `;
    md += `**Success rate:** ${faq.success_rate != null ? `${(faq.success_rate * 100).toFixed(0)}%` : '—'}\n\n`;
    md += `**Best answer:**\n${faq.best_answer}\n\n`;
    md += '---\n\n';
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'cs_search_history',
    description: 'Search past customer service conversations by semantic similarity. Returns matching conversations with full message threads, categories, and resolution outcomes. Use this to find how similar issues were handled before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The customer query or issue description to search for (e.g. "AJ size 14 too tight", "where is my order", "wholesale pricing Australia")',
        },
        category: {
          type: 'string',
          description: 'Optional category filter: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 10)',
        },
        successful_only: {
          type: 'boolean',
          description: 'If true, only return conversations where the resolution was successful',
        },
        months_back: {
          type: 'number',
          description: 'Only search conversations from the last N months (e.g. 6 for last 6 months). Useful for product-related queries where older answers may be outdated.',
        },
      },
      required: ['query'],
    },
    handler: handleSearchHistory,
  },
  {
    name: 'cs_search_faq',
    description: 'Search extracted FAQ patterns from historical conversations. Returns canonical Q&A pairs with success rates and frequency. These are distilled "best answers" for common questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question or topic to search for',
        },
        category: {
          type: 'string',
          description: 'Optional category filter: sizing_fit, exchange_return, order_status, wholesale, shipping, product_info, payment, general',
        },
        limit: {
          type: 'number',
          description: 'Number of FAQ patterns to return (default: 3)',
        },
      },
      required: ['query'],
    },
    handler: handleSearchFaq,
  },
];

module.exports = tools;
