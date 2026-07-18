#!/usr/bin/env node

/**
 * Knowledge Corpus Harvest — Step 1 (project_corpus_harvest)
 *
 * Pulls Jamie's published word into the kb_sources staging table, source-linked
 * and hashed for change detection:
 *   1. Shopify products (Admin GraphQL — descriptions, sizes, colors, prices)
 *   2. Shopify collections (Admin GraphQL — category descriptions)
 *   3. Shopify pages (Admin GraphQL — page body HTML)
 *   4. Shopify shop policies (refund/shipping/privacy/ToS)
 *   5. rubyshines.com rendered pages (sitemap-discovered /pages/ URLs whose
 *      Shopify page body is thin — theme-section-built pages like how-it-works)
 *
 * No AI calls, no embeddings here — staging is raw. Extraction (Claude Code)
 * and embedding happen downstream. Re-runnable: upserts by stable id, bumps
 * last_changed_at only on content hash change, marks vanished rows 'gone'.
 *
 * Usage:
 *   node customer-service/import/harvestKbSources.js               # all sources, writes
 *   node customer-service/import/harvestKbSources.js --dry-run     # fetch + report, no writes
 *   node customer-service/import/harvestKbSources.js --products-only | --collections-only | --pages-only | --policies-only | --website-only
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const crypto = require('crypto');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { fetchAllProducts, fetchAllCollections, shopifyGraphQL } = require('../lib/shopify');

const WEBSITE_BASE = 'https://rubyshines.com';
const CONTENT_CAP = 50000;         // staging cap; ToS-length policies fit well under this
const THIN_PAGE_CHARS = 200;       // Admin page body shorter than this = theme-built, fetch rendered
const FETCH_DELAY_MS = 250;        // politeness delay between website fetches

// ---------------------------------------------------------------------------
// Deterministic helpers (exported for tests)
// ---------------------------------------------------------------------------

function hashContent(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<(h[1-6]|p|li|tr|div|section|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

// Rendered theme pages bury content in chrome; <main> is where Shopify themes
// put the page itself. Fall back to the whole document if no <main> exists.
function extractMainContent(html) {
  if (!html) return '';
  const match = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  return stripHtml(match ? match[1] : html);
}

function extractPageTitle(html, fallback) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) return fallback;
  const title = match[1]
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[‌​﻿]/g, '')   // zero-width chars some titles carry
    .replace(/\s+/g, ' ')
    .replace(/\s*[–—|-]\s*RUBIES\s*$/i, '')
    .trim();
  return title || fallback;
}

// Mechanical junk that carries no customer-facing knowledge: test/redirect
// pages, feed endpoints, form-confirmation utility pages, app-generated
// collections. Deterministic data hygiene only — real content judgment
// happens at the extraction step.
const JUNK_ID_PATTERNS = [
  /^website:\/pages\/test(-|$)/,
  /^website:\/pages\/redirect-page$/,
  /^website:\/pages\/multi-feed-for-google-shopping/,
  /^website:\/pages\/completed-order$/,
  /^website:\/pages\/thanks-for-lettings-us-know$/,
  /^website:\/pages\/holiday-survey$/,
  /^website:\/pages\/rubies-friendships-(signup|match-reported|unsubscribe)$/,
  /^collection:orderlyemails-recommended-products$/,
  /^collection:for-shopify-performance-tracking$/,
  /^collection:segment-survey-confirmation-/,
];

function isJunkSource(id) {
  return JUNK_ID_PATTERNS.some(re => re.test(id));
}

function composeProductContent(product) {
  const description = stripHtml(product.descriptionHtml || '');
  let content = `# ${product.title}\n\n${description}\n`;

  const optionValues = (name) => [...new Set(
    (product.variants || [])
      .map(v => (v.selectedOptions || []).find(o => o.name.toLowerCase().includes(name))?.value)
      .filter(Boolean)
  )];
  const sizes = optionValues('size');
  const colors = [...new Set([...optionValues('color'), ...optionValues('colour')])];
  if (sizes.length) content += `\nAvailable sizes: ${sizes.join(', ')}\n`;
  if (colors.length) content += `Available colors: ${colors.join(', ')}\n`;

  const prices = (product.variants || []).map(v => parseFloat(v.price)).filter(p => !isNaN(p));
  if (prices.length) {
    const min = Math.min(...prices), max = Math.max(...prices);
    content += min === max ? `Price: $${min.toFixed(2)}\n` : `Price range: $${min.toFixed(2)} – $${max.toFixed(2)}\n`;
  }
  if (product.seo?.description) content += `\n${product.seo.description}\n`;

  return { content: content.trim(), sizes, colors, priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null };
}

// ---------------------------------------------------------------------------
// Source fetchers — each returns [{ id, source_type, source_url, title, content, meta }]
// ---------------------------------------------------------------------------

async function harvestProducts() {
  const all = [];
  let cursor = null;
  while (true) {
    const { products, pageInfo } = await fetchAllProducts(cursor);
    all.push(...products);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  const active = all.filter(p => p.status === 'ACTIVE');
  const rows = [];
  for (const p of active) {
    const { content, sizes, colors, priceMin, priceMax } = composeProductContent(p);
    if (stripHtml(p.descriptionHtml || '').length < 20) {
      console.warn(`  [warn] product ${p.handle}: description under 20 chars — staged anyway (title/options only)`);
    }
    rows.push({
      id: `product:${p.handle}`,
      source_type: 'shopify_product',
      source_url: `${WEBSITE_BASE}/products/${p.handle}`,
      title: p.title,
      content,
      meta: { handle: p.handle, tags: p.tags || [], productType: p.productType || null, sizes, colors, priceMin, priceMax },
    });
  }
  console.log(`Products: ${rows.length} staged (${all.length - active.length} non-active skipped)`);
  return rows;
}

async function harvestCollections() {
  const all = [];
  let cursor = null;
  while (true) {
    const { collections, pageInfo } = await fetchAllCollections(cursor);
    all.push(...collections);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  const rows = [];
  let skipped = 0;
  for (const c of all) {
    const description = stripHtml(c.descriptionHtml || '');
    if (description.length < 20) { skipped++; continue; }  // nothing to know from a bare title
    rows.push({
      id: `collection:${c.handle}`,
      source_type: 'shopify_collection',
      source_url: `${WEBSITE_BASE}/collections/${c.handle}`,
      title: c.title,
      content: `# ${c.title}\n\n${description}`,
      meta: { handle: c.handle, productsCount: c.productsCount },
    });
  }
  console.log(`Collections: ${rows.length} staged (${skipped} without descriptions skipped)`);
  return rows;
}

async function fetchAllShopifyPages() {
  const pages = [];
  let cursor = null;
  while (true) {
    const data = await shopifyGraphQL(`
      query fetchPages($after: String) {
        pages(first: 50, after: $after) {
          edges { node { id title handle body isPublished } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after: cursor });
    pages.push(...data.pages.edges.map(e => e.node));
    if (!data.pages.pageInfo.hasNextPage) break;
    cursor = data.pages.pageInfo.endCursor;
  }
  return pages.filter(p => p.isPublished);
}

// Returns { rows, thinHandles } — thin pages are theme-built; the website pass renders them.
async function harvestPages() {
  const pages = await fetchAllShopifyPages();
  const rows = [];
  const thinHandles = new Set();
  for (const p of pages) {
    const text = stripHtml(p.body || '');
    if (text.length < THIN_PAGE_CHARS) {
      thinHandles.add(p.handle);
      continue;
    }
    rows.push({
      id: `page:${p.handle}`,
      source_type: 'shopify_page',
      source_url: `${WEBSITE_BASE}/pages/${p.handle}`,
      title: p.title,
      content: `# ${p.title}\n\n${text}`,
      meta: { handle: p.handle },
    });
  }
  console.log(`Pages: ${rows.length} staged from Admin API; ${thinHandles.size} thin (theme-built) deferred to website fetch`);
  return { rows, thinHandles };
}

const POLICY_TITLES = {
  REFUND_POLICY: 'Refund Policy',
  SHIPPING_POLICY: 'Shipping Policy',
  PRIVACY_POLICY: 'Privacy Policy',
  TERMS_OF_SERVICE: 'Terms of Service',
  SUBSCRIPTION_POLICY: 'Subscription Policy',
  CONTACT_INFORMATION: 'Contact Information',
  LEGAL_NOTICE: 'Legal Notice',
};

async function harvestPolicies() {
  const data = await shopifyGraphQL(`
    query { shop { shopPolicies { type body url } } }
  `);
  const rows = [];
  for (const pol of data.shop.shopPolicies || []) {
    const text = stripHtml(pol.body || '');
    if (text.length < 20) continue;
    const title = POLICY_TITLES[pol.type] || pol.type;
    rows.push({
      id: `policy:${pol.type.toLowerCase()}`,
      source_type: 'shopify_policy',
      source_url: pol.url,
      title,
      content: `# ${title}\n\n${text}`,
      meta: { policyType: pol.type },
    });
  }
  console.log(`Policies: ${rows.length} staged`);
  return rows;
}

async function fetchSitemapPagePaths() {
  const paths = new Set();
  try {
    const indexXml = await (await fetch(`${WEBSITE_BASE}/sitemap.xml`)).text();
    const subSitemaps = [...indexXml.matchAll(/<loc>([^<]*sitemap_pages[^<]*)<\/loc>/g)].map(m => m[1]);
    for (const sm of subSitemaps) {
      const xml = await (await fetch(sm)).text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const u = new URL(m[1]);
        if (u.pathname.startsWith('/pages/')) paths.add(u.pathname);
      }
    }
  } catch (e) {
    console.error(`  [WARN] sitemap fetch failed (${e.message}) — website pass will only cover thin Admin pages`);
  }
  return paths;
}

// Rendered-page pass: sitemap /pages/ URLs that Admin staging didn't cover
// (thin theme-built bodies, or app-generated pages absent from the Pages API).
async function harvestWebsitePages(coveredHandles, thinHandles) {
  const sitemapPaths = await fetchSitemapPagePaths();
  for (const handle of thinHandles) sitemapPaths.add(`/pages/${handle}`);

  const targets = [...sitemapPaths].filter(p => {
    const handle = p.replace('/pages/', '');
    return !coveredHandles.has(handle) && !isJunkSource(`website:${p}`);
  });

  const rows = [];
  for (const pagePath of targets) {
    const url = `${WEBSITE_BASE}${pagePath}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      if (!res.ok) { console.warn(`  [warn] ${pagePath}: HTTP ${res.status} — skipped`); continue; }
      const html = await res.text();
      const text = extractMainContent(html);
      if (text.length < 50) { console.warn(`  [warn] ${pagePath}: under 50 chars after extraction — skipped`); continue; }
      rows.push({
        id: `website:${pagePath}`,
        source_type: 'website_page',
        source_url: url,
        title: extractPageTitle(html, pagePath),
        content: text,
        meta: { path: pagePath },
      });
    } catch (e) {
      console.warn(`  [warn] ${pagePath}: fetch failed (${e.message}) — skipped`);
    }
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
  }
  console.log(`Website: ${rows.length} rendered pages staged (${targets.length - rows.length} skipped)`);
  return rows;
}

// ---------------------------------------------------------------------------
// Writer — upsert by id, bump last_changed_at only on hash change, mark gone
// ---------------------------------------------------------------------------

async function loadExisting(supabase) {
  const existing = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('kb_sources')
      .select('id, content_hash, status')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`kb_sources read failed: ${error.message}`);
    for (const row of data) existing.set(row.id, row);
    if (data.length < PAGE) break;
  }
  return existing;
}

async function writeRows(supabase, harvested, { fullRun }) {
  const existing = await loadExisting(supabase);
  const now = new Date().toISOString();
  const stats = { inserted: 0, changed: 0, unchanged: 0, gone: 0 };

  const upserts = [];
  const unchangedIds = [];
  for (const row of harvested) {
    const content = row.content.slice(0, CONTENT_CAP);
    const hash = hashContent(content);
    const prev = existing.get(row.id);
    if (prev && prev.content_hash === hash) {
      unchangedIds.push(row.id);
      stats.unchanged++;
      continue;
    }
    upserts.push({
      id: row.id,
      source_type: row.source_type,
      source_url: row.source_url,
      title: row.title,
      content,
      content_hash: hash,
      meta: row.meta,
      status: 'active',
      last_fetched_at: now,
      last_changed_at: now,
    });
    if (prev) stats.changed++; else stats.inserted++;
  }

  for (let i = 0; i < upserts.length; i += 100) {
    const chunk = upserts.slice(i, i + 100);
    const { error } = await supabase.from('kb_sources').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`kb_sources upsert failed: ${error.message}`);
  }

  for (let i = 0; i < unchangedIds.length; i += 200) {
    const chunk = unchangedIds.slice(i, i + 200);
    const { error } = await supabase
      .from('kb_sources')
      .update({ last_fetched_at: now, status: 'active' })
      .in('id', chunk);
    if (error) throw new Error(`kb_sources touch failed: ${error.message}`);
  }

  // Only a full harvest can conclude a row vanished upstream; a filtered run
  // never saw the other source types. Mark (not delete) so audit survives.
  if (fullRun) {
    const seen = new Set(harvested.map(r => r.id));
    const goneIds = [...existing.entries()]
      .filter(([id, row]) => row.status === 'active' && !seen.has(id))
      .map(([id]) => id);
    for (let i = 0; i < goneIds.length; i += 200) {
      const chunk = goneIds.slice(i, i + 200);
      const { error } = await supabase.from('kb_sources').update({ status: 'gone' }).in('id', chunk);
      if (error) throw new Error(`kb_sources gone-marking failed: ${error.message}`);
    }
    stats.gone = goneIds.length;
    if (goneIds.length) console.log(`Marked gone: ${goneIds.slice(0, 10).join(', ')}${goneIds.length > 10 ? ` (+${goneIds.length - 10} more)` : ''}`);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runHarvest({ only = '', dryRun = false } = {}) {
  const run = (name) => !only || only === name;

  const harvested = [];
  let thinHandles = new Set();
  const coveredHandles = new Set();

  if (run('products')) harvested.push(...await harvestProducts());
  if (run('collections')) harvested.push(...await harvestCollections());
  if (run('pages') || run('website')) {
    // Website pass needs the Admin pages result to know what's already covered,
    // so a --website-only run still reads (but doesn't stage) Admin pages.
    const { rows, thinHandles: thin } = await harvestPages();
    thinHandles = thin;
    for (const r of rows) coveredHandles.add(r.meta.handle);
    if (run('pages')) harvested.push(...rows);
  }
  if (run('website')) harvested.push(...await harvestWebsitePages(coveredHandles, thinHandles));
  if (run('policies')) harvested.push(...await harvestPolicies());

  const junk = harvested.filter(r => isJunkSource(r.id));
  if (junk.length) console.log(`Junk filtered: ${junk.map(r => r.id).join(', ')}`);
  const kept = harvested.filter(r => !isJunkSource(r.id));

  console.log(`\nTotal harvested: ${kept.length} sources`);

  if (dryRun) {
    for (const r of kept) {
      console.log(`  ${r.id}  [${r.content.length} chars]  ${r.title}`);
    }
    console.log('\nDry run — nothing written.');
    return;
  }

  const supabase = getSupabaseClient();
  const stats = await writeRows(supabase, kept, { fullRun: !only });
  console.log(`\nkb_sources: ${stats.inserted} inserted, ${stats.changed} changed, ${stats.unchanged} unchanged, ${stats.gone} marked gone`);
}

async function main() {
  const args = process.argv.slice(2);
  return runHarvest({
    dryRun: args.includes('--dry-run'),
    only: (args.find(a => /^--(products|collections|pages|policies|website)-only$/.test(a)) || '').replace(/^--|-only$/g, ''),
  });
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run: runHarvest, stripHtml, extractMainContent, extractPageTitle, hashContent, composeProductContent, isJunkSource };
