/**
 * Tool: reload_products — fetch fresh product catalog from Shopify and sync to Supabase
 */

const { loadProducts, getProducts } = require('../productCache');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { embed } = require('../embeddings');
const { getVariantSize, getVariantColor } = require('../sizeUtils');

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Update product knowledge base articles from the product cache.
 * Called automatically when products are reloaded.
 */
async function updateProductKnowledge() {
  const products = getProducts();
  if (!products.length) return 0;

  const supabase = getSupabaseClient();
  let updated = 0;

  for (const product of products) {
    const description = stripHtml(product.descriptionHtml || '');
    if (!description || description.length < 20) continue;

    let content = `# ${product.title}\n\n${description}\n\n`;
    const sizes = [...new Set(product.variants
      .map(v => getVariantSize(v))
      .filter(Boolean))];
    if (sizes.length) content += `**Available sizes:** ${sizes.join(', ')}\n\n`;

    const colors = [...new Set(product.variants
      .map(v => getVariantColor(v))
      .filter(Boolean))];
    if (colors.length) content += `**Available colors:** ${colors.join(', ')}\n\n`;

    if (product.tags?.length) content += `**Tags:** ${product.tags.join(', ')}\n`;

    let embedding = null;
    try {
      embedding = await embed(`${product.title}\n\n${content.slice(0, 2000)}`);
    } catch (e) {
      // Embedding may fail due to rate limits — still save the article without it
    }

    const { error } = await supabase
      .from('cs_knowledge_base')
      .upsert({
        id: `product:${product.handle}`,
        title: product.title,
        category: 'product',
        content: content.slice(0, 10000),
        source: 'shopify',
        tags: product.tags || [],
        embedding: embedding ? JSON.stringify(embedding) : null,
        priority: 5,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (!error) updated++;
  }

  return updated;
}

const tools = [
  {
    name: 'reload_products',
    description: 'Reload the product catalog from Shopify, save to Supabase, and update the knowledge base with current product descriptions. Use this after adding or changing products.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      await loadProducts();
      const count = getProducts().length;

      // Update knowledge base in background (don't block the response)
      let kbMsg = '';
      try {
        const kbCount = await updateProductKnowledge();
        kbMsg = ` Knowledge base updated with ${kbCount} product articles.`;
      } catch (e) {
        kbMsg = ` Warning: knowledge base update failed: ${e.message}`;
      }

      return {
        content: [{ type: 'text', text: `Product catalog reloaded — ${count} active products cached.${kbMsg}` }],
      };
    },
  },
];

module.exports = tools;
