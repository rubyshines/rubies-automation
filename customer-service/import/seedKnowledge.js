#!/usr/bin/env node

/**
 * Smart Knowledge Base Seeder
 *
 * Pulls data from real sources and seeds cs_knowledge_base in Supabase:
 *   1. Shopify product descriptions (via GraphQL)
 *   2. Website pages from rubyshines.com (via Puppeteer)
 *   3. Curated markdown articles from customer-service/knowledge/
 *   4. Gorgias macros (via --macros flag in runImport.js, separate command)
 *
 * Usage:
 *   node customer-service/import/seedKnowledge.js                  # all sources
 *   node customer-service/import/seedKnowledge.js --products-only  # just Shopify products
 *   node customer-service/import/seedKnowledge.js --website-only   # just website pages
 *   node customer-service/import/seedKnowledge.js --articles-only  # just markdown files
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { embed } = require('../lib/embeddings');
const { fetchAllProducts } = require('../lib/shopify');

const KNOWLEDGE_DIR = path.resolve(__dirname, '../knowledge');
const WEBSITE_BASE = 'https://rubyshines.com';

// Pages on rubyshines.com to scrape for knowledge
// Pages discovered from site navigation + known URLs
const WEBSITE_PAGES = [
  // Info pages
  { path: '/pages/about-us', id: 'website-about-us', title: 'About RUBIES', category: 'product' },
  { path: '/pages/how-it-works', id: 'website-how-it-works', title: 'How RUBIES Products Work', category: 'product' },
  { path: '/pages/size-guide', id: 'website-size-guide', title: 'RUBIES Size Guide', category: 'sizing' },
  { path: '/pages/contact', id: 'website-contact', title: 'Contact RUBIES', category: 'faq' },
  { path: '/pages/returns', id: 'website-returns', title: 'Returns & Exchanges', category: 'policy' },

  // Community & programs
  { path: '/pages/donate-your-pre-loved-rubies-clothing', id: 'website-donations', title: 'Donate Your Pre-Loved RUBIES Clothing (Donation Partners)', category: 'policy' },
  { path: '/pages/collaborations', id: 'website-collaborations', title: 'RUBIES Collaborations', category: 'product' },
  { path: '/pages/community-portal', id: 'website-community', title: 'RUBIES Community Portal', category: 'product' },
  { path: '/pages/free-swimwear-for-families-in-need', id: 'website-free-swimwear', title: 'Free Swimwear for Families in Need', category: 'product' },
  { path: '/pages/lgbtq-donations', id: 'website-lgbtq-donations', title: 'LGBTQ+ Donations Program', category: 'product' },
  { path: '/pages/join-rubies-rewards-program', id: 'website-rewards', title: 'RUBIES Rewards Program', category: 'faq' },
  { path: '/pages/stock-rubies-in-your-store', id: 'website-stock-rubies', title: 'Stock RUBIES in Your Store (Wholesale)', category: 'policy' },

  // Policies
  { path: '/policies/refund-policy', id: 'website-policies-refund', title: 'Refund Policy', category: 'policy' },
  { path: '/policies/shipping-policy', id: 'website-policies-shipping', title: 'Shipping Policy', category: 'shipping' },
  { path: '/policies/privacy-policy', id: 'website-policies-privacy', title: 'Privacy Policy', category: 'policy' },
  { path: '/policies/terms-of-service', id: 'website-policies-tos', title: 'Terms of Service', category: 'policy' },

  // Collection pages (product category descriptions)
  { path: '/collections/adults', id: 'website-coll-adults', title: 'Adults Collection', category: 'product' },
  { path: '/collections/adults-underwear', id: 'website-coll-adults-underwear', title: 'Adults Underwear Collection', category: 'product' },
  { path: '/collections/adults-swimwear', id: 'website-coll-adults-swimwear', title: 'Adults Swimwear Collection', category: 'product' },
  { path: '/collections/adults-activewear', id: 'website-coll-adults-activewear', title: 'Adults Activewear Collection', category: 'product' },
  { path: '/collections/kids', id: 'website-coll-kids', title: 'Kids Collection', category: 'product' },
  { path: '/collections/kids-underwear', id: 'website-coll-kids-underwear', title: 'Kids Underwear Collection', category: 'product' },
  { path: '/collections/kids-swimwear', id: 'website-coll-kids-swimwear', title: 'Kids Swimwear Collection', category: 'product' },
  { path: '/collections/kids-activewear', id: 'website-coll-kids-activewear', title: 'Kids Activewear Collection', category: 'product' },
  { path: '/collections/pride-merch', id: 'website-coll-pride', title: 'Pride Merch Collection', category: 'product' },
  { path: '/collections/rubies-bundles', id: 'website-coll-bundles', title: 'RUBIES Bundles', category: 'product' },
  { path: '/collections/adults-bestsellers', id: 'website-coll-adults-best', title: 'Adults Bestsellers', category: 'product' },
  { path: '/collections/adults-new-arrivals', id: 'website-coll-adults-new', title: 'Adults New Arrivals', category: 'product' },
  { path: '/collections/kids-bestsellers', id: 'website-coll-kids-best', title: 'Kids Bestsellers', category: 'product' },
  { path: '/collections/kids-new-arrivals', id: 'website-coll-kids-new', title: 'Kids New Arrivals', category: 'product' },
];

// CLI args
const args = process.argv.slice(2);
const productsOnly = args.includes('--products-only');
const websiteOnly = args.includes('--website-only');
const articlesOnly = args.includes('--articles-only');
const runAll = !productsOnly && !websiteOnly && !articlesOnly;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function upsertArticle(supabase, { id, title, category, content, source, tags, priority }) {
  if (!content || content.trim().length < 20) {
    console.log(`  [Skip] ${id} — content too short`);
    return false;
  }

  let embedding = null;
  try {
    const embeddingText = `${title}\n\n${content.slice(0, 2000)}`;
    embedding = await embed(embeddingText);
  } catch (e) {
    console.error(`  [Warning] Embedding failed for ${id}: ${e.message}`);
  }

  const { error } = await supabase
    .from('cs_knowledge_base')
    .upsert({
      id,
      title,
      category,
      content: content.slice(0, 10000), // Cap at 10k chars
      source,
      tags: tags || [],
      embedding: embedding ? JSON.stringify(embedding) : null,
      priority: priority || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) {
    console.error(`  [Error] ${id}: ${error.message}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Source 1: Shopify Product Descriptions
// ---------------------------------------------------------------------------

async function seedFromShopify(supabase) {
  console.log('\n=== Shopify Product Descriptions ===\n');

  // Fetch all products (uses the expanded GraphQL query with descriptionHtml)
  const allProducts = [];
  let cursor = null;
  while (true) {
    const { products, pageInfo } = await fetchAllProducts(cursor);
    allProducts.push(...products);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  const activeProducts = allProducts.filter(p => p.status === 'ACTIVE');
  console.log(`Found ${activeProducts.length} active products`);

  let seeded = 0;
  for (const product of activeProducts) {
    const description = stripHtml(product.descriptionHtml || '');
    if (!description || description.length < 20) {
      console.log(`  [Skip] ${product.title} — no description`);
      continue;
    }

    // Build rich content: description + available sizes + tags
    let content = `# ${product.title}\n\n`;
    content += `${description}\n\n`;

    // Add available sizes
    const sizes = product.variants
      .map(v => {
        const sizeOpt = (v.selectedOptions || []).find(o => o.name.toLowerCase().includes('size'));
        return sizeOpt?.value;
      })
      .filter(Boolean);
    const uniqueSizes = [...new Set(sizes)];
    if (uniqueSizes.length > 0) {
      content += `**Available sizes:** ${uniqueSizes.join(', ')}\n\n`;
    }

    // Add colors
    const colors = product.variants
      .map(v => {
        const colorOpt = (v.selectedOptions || []).find(o =>
          o.name.toLowerCase().includes('color') || o.name.toLowerCase().includes('colour')
        );
        return colorOpt?.value;
      })
      .filter(Boolean);
    const uniqueColors = [...new Set(colors)];
    if (uniqueColors.length > 0) {
      content += `**Available colors:** ${uniqueColors.join(', ')}\n\n`;
    }

    // Price range
    const prices = product.variants.map(v => parseFloat(v.price)).filter(p => !isNaN(p));
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      content += min === max ? `**Price:** $${min.toFixed(2)}\n\n` : `**Price range:** $${min.toFixed(2)} – $${max.toFixed(2)}\n\n`;
    }

    if (product.tags?.length) {
      content += `**Tags:** ${product.tags.join(', ')}\n`;
    }

    const ok = await upsertArticle(supabase, {
      id: `product:${product.handle}`,
      title: product.title,
      category: 'product',
      content,
      source: 'shopify',
      tags: product.tags || [],
      priority: 5,
    });

    if (ok) {
      seeded++;
      console.log(`  ✓ ${product.title}`);
    }

    // Small delay for Voyage rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nShopify: Seeded ${seeded}/${activeProducts.length} product articles`);
  return seeded;
}

// ---------------------------------------------------------------------------
// Source 2: Website Pages
// ---------------------------------------------------------------------------

async function seedFromWebsite(supabase) {
  console.log('\n=== Website Pages (rubyshines.com) ===\n');

  let seeded = 0;

  for (const page of WEBSITE_PAGES) {
    const url = `${WEBSITE_BASE}${page.path}`;
    console.log(`  Fetching: ${url}`);

    try {
      let text = '';

      // Simple fetch — Shopify pages don't need Puppeteer
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.log(`  [Skip] ${page.path} — HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      text = stripHtml(html);

      if (!text || text.length < 50) {
        console.log(`  [Skip] ${page.path} — no meaningful content`);
        continue;
      }

      // Try to extract just the main content (remove header/footer noise)
      // Look for common Shopify content markers
      const mainContent = extractMainContent(text);

      const ok = await upsertArticle(supabase, {
        id: page.id,
        title: page.title,
        category: page.category,
        content: mainContent,
        source: 'website',
        tags: [page.category, 'website'],
        priority: 7, // Website pages are authoritative
      });

      if (ok) {
        seeded++;
        console.log(`  ✓ ${page.title} (${mainContent.length} chars)`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log(`  [Skip] ${page.path} — ${e.message}`);
    }
  }

  console.log(`\nWebsite: Seeded ${seeded} page articles`);
  return seeded;
}

/**
 * Try to extract the main content area from page text,
 * removing header/footer/nav noise.
 */
function extractMainContent(text) {
  // Common patterns: look for content between navigation and footer
  // This is a heuristic — works for most Shopify themes
  const lines = text.split(/\s+/);

  // If text is short enough, use it all
  if (lines.length < 200) return text;

  // Try to skip the first ~50 words (usually nav) and last ~50 (footer)
  const start = Math.min(50, Math.floor(lines.length * 0.1));
  const end = Math.max(lines.length - 50, Math.floor(lines.length * 0.9));
  return lines.slice(start, end).join(' ');
}

// ---------------------------------------------------------------------------
// Source 3: Curated Markdown Articles
// ---------------------------------------------------------------------------

async function seedFromMarkdown(supabase) {
  console.log('\n=== Curated Markdown Articles ===\n');

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
  if (!files.length) {
    console.log('No .md files found');
    return 0;
  }

  let seeded = 0;
  for (const file of files) {
    const filePath = path.join(KNOWLEDGE_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const { meta, body } = parseFrontmatter(content);

    const id = file.replace('.md', '');
    const title = meta.title || id;

    const ok = await upsertArticle(supabase, {
      id,
      title,
      category: meta.category || 'general',
      content: body,
      source: meta.source || 'manual',
      tags: meta.tags || [],
      priority: meta.priority || 0,
    });

    if (ok) {
      seeded++;
      console.log(`  ✓ ${title}`);
    }
  }

  console.log(`\nMarkdown: Seeded ${seeded}/${files.length} articles`);
  return seeded;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const frontmatter = match[1];
  const body = match[2].trim();
  const meta = {};

  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;

    if (key === 'tags') {
      const tagMatch = value.match(/\[([^\]]*)\]/);
      meta.tags = tagMatch
        ? tagMatch[1].split(',').map(t => t.trim())
        : [value.trim()];
    } else if (key === 'priority') {
      meta.priority = parseInt(value, 10) || 0;
    } else {
      meta[key] = value.trim();
    }
  }

  return { meta, body };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseClient();
  let total = 0;

  if (runAll || productsOnly) {
    total += await seedFromShopify(supabase);
  }

  if (runAll || websiteOnly) {
    total += await seedFromWebsite(supabase);
  }

  if (runAll || articlesOnly) {
    total += await seedFromMarkdown(supabase);
  }

  console.log(`\n========================================`);
  console.log(`Total: ${total} knowledge articles seeded`);
  console.log(`========================================`);
  console.log(`\nNext steps:`);
  console.log(`  • Import Gorgias macros: npm run cs-import-macros`);
  console.log(`  • Import conversations:  npm run cs-import-gorgias`);
}

main().catch(err => {
  console.error('[SeedKnowledge] Fatal error:', err);
  process.exit(1);
});
