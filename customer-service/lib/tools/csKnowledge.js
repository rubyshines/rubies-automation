/**
 * CS Knowledge MCP Tools — knowledge base retrieval and sizing guidance
 *
 * Tools: cs_get_knowledge, cs_get_sizing_guide
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');
const { searchProducts, getProducts } = require('../productCache');
const { NUMERIC_SIZES, LETTER_SIZES, NUMERIC_TO_LETTER_UPPER } = require('../sizeUtils');

// Size chart display data — sizes/equivalences come from sizeUtils (the single
// source of truth) so the customer-facing chart can never drift from the engine.
const SIZE_CHART = {
  numeric: {
    label: 'Youth Size (Numeric)',
    products: 'AJ, Charlie, Brooke, Ruby',
    sizes: NUMERIC_SIZES,
  },
  letter: {
    label: 'Size (Letter)',
    products: 'Ava, Cheeky, Sassy',
    sizes: LETTER_SIZES,
  },
  numericToLetter: NUMERIC_TO_LETTER_UPPER,
};

// ---------------------------------------------------------------------------
// Tool: cs_get_knowledge
// ---------------------------------------------------------------------------

async function handleGetKnowledge({ query, category, limit }) {
  const maxResults = limit || 3;
  const supabase = getSupabaseClient();

  if (query) {
    // Semantic search
    const queryEmbedding = await embed(query);
    const { data: articles, error } = await supabase.rpc('cs_search_knowledge', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: maxResults,
      filter_category: category || null,
    });

    if (error) throw new Error(`Knowledge search failed: ${error.message}`);
    if (!articles || !articles.length) {
      return { content: [{ type: 'text', text: 'No matching knowledge base articles found.' }] };
    }

    let md = `## Knowledge Base (${articles.length} results)\n\n`;
    for (const article of articles) {
      const similarity = (article.similarity * 100).toFixed(0);
      md += `### ${article.title} (${similarity}% match)\n`;
      md += `**Category:** ${article.category} | **Priority:** ${article.priority}\n\n`;
      md += article.content + '\n\n---\n\n';
    }
    return { content: [{ type: 'text', text: md }] };

  } else if (category) {
    // Category browse
    const { data: articles, error } = await supabase
      .from('cs_knowledge_base')
      .select('id, title, category, content, priority')
      .eq('category', category)
      .order('priority', { ascending: false })
      .limit(maxResults);

    if (error) throw new Error(`Knowledge lookup failed: ${error.message}`);
    if (!articles || !articles.length) {
      return { content: [{ type: 'text', text: `No knowledge base articles found in category "${category}".` }] };
    }

    let md = `## Knowledge Base — ${category} (${articles.length} articles)\n\n`;
    for (const article of articles) {
      md += `### ${article.title}\n\n`;
      md += article.content + '\n\n---\n\n';
    }
    return { content: [{ type: 'text', text: md }] };

  } else {
    return { content: [{ type: 'text', text: 'Please provide a query or category to search the knowledge base.' }] };
  }
}

// ---------------------------------------------------------------------------
// Tool: cs_get_sizing_guide
// ---------------------------------------------------------------------------

async function handleSizingGuide({ product, current_size, issue }) {
  const supabase = getSupabaseClient();

  let md = '## RUBIES Sizing Guide\n\n';

  // 1. Size charts
  md += '### Size Systems\n\n';
  md += `**${SIZE_CHART.numeric.label}** (${SIZE_CHART.numeric.products})\n`;
  md += `Sizes: ${SIZE_CHART.numeric.sizes.join(', ')}\n\n`;
  md += `**${SIZE_CHART.letter.label}** (${SIZE_CHART.letter.products})\n`;
  md += `Sizes: ${SIZE_CHART.letter.sizes.join(', ')}\n\n`;
  md += '**Numeric → Letter Equivalence** (for letter-only products):\n';
  for (const [num, letter] of Object.entries(SIZE_CHART.numericToLetter)) {
    md += `- Youth ${num} → ${letter}\n`;
  }
  md += '\n';

  // 2. Product-specific info
  if (product) {
    const results = searchProducts(product);
    if (results.length > 0) {
      // Group by product
      const byProduct = {};
      for (const r of results) {
        if (!byProduct[r.productTitle]) byProduct[r.productTitle] = [];
        byProduct[r.productTitle].push(r);
      }

      md += '### Available Sizes & Inventory\n\n';
      for (const [title, variants] of Object.entries(byProduct)) {
        md += `**${title}:**\n`;
        // Deduplicate by size option
        const seen = new Set();
        for (const v of variants) {
          const sizeOpt = (v.options || []).find(o => o.name.toLowerCase().includes('size'));
          const size = sizeOpt ? sizeOpt.value : v.variantTitle;
          const key = `${size}-${v.variantTitle}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const stock = v.inventoryQuantity > 0 ? `${v.inventoryQuantity} in stock` : 'OUT OF STOCK';
          md += `- ${v.variantTitle} — $${v.price} (${stock})\n`;
        }
        md += '\n';
      }
    } else {
      md += `*No products found matching "${product}"*\n\n`;
    }
  }

  // 3. Size direction guidance
  if (current_size && issue) {
    md += '### Sizing Recommendation\n\n';
    const issueLower = issue.toLowerCase();
    if (issueLower.includes('tight') || issueLower.includes('small') || issueLower.includes('snug')) {
      md += `Current size: **${current_size}** — Issue: too tight/small\n`;
      md += '**Recommendation:** Try **one size up**.\n\n';
    } else if (issueLower.includes('loose') || issueLower.includes('big') || issueLower.includes('large')) {
      md += `Current size: **${current_size}** — Issue: too loose/big\n`;
      md += '**Recommendation:** Try **one size down**.\n\n';
    } else {
      md += `Current size: **${current_size}** — Issue: ${issue}\n`;
      md += '**Note:** Check past conversations for specific guidance on this fit issue.\n\n';
    }
  }

  // 4. Pull sizing knowledge base articles
  try {
    const queryText = [product, current_size, issue].filter(Boolean).join(' ') || 'sizing fit guide';
    const queryEmbedding = await embed(queryText);
    const { data: articles } = await supabase.rpc('cs_search_knowledge', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 2,
      filter_category: 'sizing',
    });

    if (articles && articles.length > 0) {
      md += '### From Knowledge Base\n\n';
      for (const article of articles) {
        md += `**${article.title}:**\n${article.content}\n\n`;
      }
    }
  } catch (e) {
    // Knowledge base may not be populated yet — that's fine
  }

  // 5. Pull relevant FAQ patterns
  try {
    const queryText = [product, current_size, issue, 'sizing'].filter(Boolean).join(' ');
    const queryEmbedding = await embed(queryText);
    const { data: faqs } = await supabase.rpc('cs_search_faqs', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 2,
      filter_category: 'sizing_fit',
    });

    if (faqs && faqs.length > 0) {
      md += '### Common Sizing Questions\n\n';
      for (const faq of faqs) {
        md += `**Q:** ${faq.question_pattern}\n`;
        md += `**A:** ${faq.best_answer}\n`;
        md += `*(Asked ${faq.frequency} times, ${faq.success_rate != null ? `${(faq.success_rate * 100).toFixed(0)}% success` : 'no success data'})*\n\n`;
      }
    }
  } catch (e) {
    // FAQ patterns may not exist yet — that's fine
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'cs_get_knowledge',
    description: 'Search the RUBIES knowledge base for articles about policies, products, shipping, sizing, and more. Use semantic search (query) or browse by category.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Semantic search query (e.g. "return policy", "washing instructions", "international shipping")',
        },
        category: {
          type: 'string',
          description: 'Browse by category: sizing, policy, faq, product, shipping',
        },
        limit: {
          type: 'number',
          description: 'Number of articles to return (default: 3)',
        },
      },
      required: [],
    },
    handler: handleGetKnowledge,
  },
  {
    name: 'cs_get_sizing_guide',
    description: 'Get comprehensive RUBIES sizing guidance. Combines size charts, live inventory data, knowledge base articles, and past sizing conversations. Use for any sizing or fit question.',
    inputSchema: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: 'Product name or style (e.g. "AJ", "Ava", "Charlie Black")',
        },
        current_size: {
          type: 'string',
          description: 'Customer\'s current size (e.g. "14", "M", "XS+")',
        },
        issue: {
          type: 'string',
          description: 'Fit issue description (e.g. "too tight around waist", "too loose", "between sizes")',
        },
      },
      required: [],
    },
    handler: handleSizingGuide,
  },
];

module.exports = tools;
