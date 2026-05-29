/**
 * SEO Meta MCP Tools: seo_meta_draft + seo_meta_update
 *
 * Reads from synced `collections` / `products` tables and `gsc_keyword_pages`.
 * Writes via Shopify GraphQL `collectionUpdate` / `productUpdate`.
 *
 * House style is encoded in the draft prompt — see project_seo_meta_tooling.md.
 * Validation rules in validateMeta() are tested in test/seoMeta.test.js.
 */

const { updateCollectionSeo, updateProductSeo, getAdminUrl } = require('../shopify');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { MODELS } = require('../../../shared/aiPricing');

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 165;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const EM_DASH_RE = /—/;
const STORE_BASE = 'https://rubyshines.com';

// ─── Validation ──────────────────────────────────────────────────────────────

function validateMeta({ type, newHandle, title, description }) {
  const errors = [];
  if (type !== 'collection' && type !== 'product') {
    errors.push(`type must be "collection" or "product", got "${type}"`);
  }
  if (newHandle === undefined && title === undefined && description === undefined) {
    errors.push('At least one of new_handle, title, description must be provided');
  }
  if (newHandle !== undefined) {
    if (typeof newHandle !== 'string' || !HANDLE_RE.test(newHandle)) {
      errors.push(`new_handle "${newHandle}" must be lowercase alphanumeric with hyphens (no leading hyphen, no special chars)`);
    }
  }
  if (title !== undefined) {
    if (typeof title !== 'string') errors.push('title must be a string');
    else {
      if (title.length > TITLE_MAX) errors.push(`title is ${title.length} chars, max ${TITLE_MAX}`);
      if (EM_DASH_RE.test(title)) errors.push('title contains em dash (—). Use periods, commas, or parentheses instead.');
    }
  }
  if (description !== undefined) {
    if (typeof description !== 'string') errors.push('description must be a string');
    else {
      if (description.length > DESCRIPTION_MAX) errors.push(`description is ${description.length} chars, max ${DESCRIPTION_MAX}`);
      if (EM_DASH_RE.test(description)) errors.push('description contains em dash (—). Use periods, commas, or parentheses instead.');
    }
  }
  return errors;
}

// ─── Shared lookup ───────────────────────────────────────────────────────────

async function loadSyncedRow(supabase, type, handle) {
  const table = type === 'collection' ? 'collections' : 'products';
  const idCol = type === 'collection' ? 'shopify_collection_id' : 'shopify_product_id';
  const cols = type === 'collection'
    ? `${idCol}, handle, title, seo_title, seo_description, product_handles`
    : `${idCol}, handle, title, seo_title, seo_description, description_html, fit_description, best_for, comparison_notes, materials_composition, tags, age_groups, kid_sizes, adult_sizes`;
  const { data, error } = await supabase
    .from(table)
    .select(cols)
    .eq('handle', handle)
    .maybeSingle();
  if (error) throw new Error(`${table} lookup failed: ${error.message}`);
  if (!data) throw new Error(`${type} with handle "${handle}" not found in synced ${table} table. Run \`npm run cs-sync-${table}\` if it was just created in Shopify.`);
  return { id: data[idCol], ...data };
}

async function loadProductsByHandles(supabase, handles) {
  if (!handles || !handles.length) return [];
  const { data, error } = await supabase
    .from('products')
    .select('handle, title, fit_description, best_for, comparison_notes, tags, age_groups, kid_sizes, adult_sizes')
    .in('handle', handles);
  if (error) throw new Error(`products lookup failed: ${error.message}`);
  // Preserve the order from the input handles list.
  const byHandle = new Map((data || []).map(p => [p.handle, p]));
  return handles.map(h => byHandle.get(h)).filter(Boolean);
}

function summarizeProductForDraft(p) {
  const bits = [`"${p.title}"`];
  if (p.fit_description) bits.push(`fit: ${p.fit_description.slice(0, 120)}`);
  if (p.best_for) bits.push(`best for: ${p.best_for.slice(0, 80)}`);
  const sizes = [];
  if (p.kid_sizes?.length) sizes.push(`youth ${p.kid_sizes.join('/')}`);
  if (p.adult_sizes?.length) sizes.push(`adult ${p.adult_sizes.join('/')}`);
  if (sizes.length) bits.push(`sizes: ${sizes.join(' + ')}`);
  return `- ${bits.join('  •  ')}`;
}

function inferAudienceFromProducts(products) {
  let hasKid = false;
  let hasAdult = false;
  for (const p of products) {
    if (p.kid_sizes?.length || (p.age_groups || []).some(a => /kid|youth/i.test(a))) hasKid = true;
    if (p.adult_sizes?.length || (p.age_groups || []).some(a => /adult|women/i.test(a))) hasAdult = true;
  }
  if (hasKid && hasAdult) return 'mixed (kids and adults)';
  if (hasKid) return 'kids only';
  if (hasAdult) return 'adults only';
  return null;
}

function pageUrlFor(type, handle) {
  return type === 'collection'
    ? `${STORE_BASE}/collections/${handle}`
    : `${STORE_BASE}/products/${handle}`;
}

// ─── seo_meta_update ─────────────────────────────────────────────────────────

async function handleUpdate({ type, handle, new_handle, title, description, description_html }) {
  const errs = validateMeta({ type, newHandle: new_handle, title, description });
  if (errs.length) {
    return {
      content: [{ type: 'text', text: `Validation failed:\n- ${errs.join('\n- ')}` }],
      isError: true,
    };
  }

  const supabase = getSupabaseClient();
  const row = await loadSyncedRow(supabase, type, handle);

  const updateInput = {
    id: row.id,
    ...(new_handle !== undefined && { handle: new_handle }),
    ...(title !== undefined && { seoTitle: title }),
    ...(description !== undefined && { seoDescription: description }),
    ...(description_html !== undefined && { descriptionHtml: description_html }),
  };

  const updater = type === 'collection' ? updateCollectionSeo : updateProductSeo;
  const updated = await updater(updateInput);

  // Mirror the change to Supabase immediately so callers see fresh state
  // without waiting for the next sync.
  const tableName = type === 'collection' ? 'collections' : 'products';
  const idCol = type === 'collection' ? 'shopify_collection_id' : 'shopify_product_id';
  const patch = {
    handle: updated.handle,
    seo_title: updated.seo?.title ?? null,
    seo_description: updated.seo?.description ?? null,
    ...(description_html !== undefined && { description_html: updated.descriptionHtml ?? null }),
  };
  const { error: upErr } = await supabase.from(tableName).update(patch).eq(idCol, row.id);
  if (upErr) console.error(`[seo_meta_update] Supabase mirror update failed (will reconcile on next sync): ${upErr.message}`);

  const newUrl = pageUrlFor(type, updated.handle);
  const adminUrl = getAdminUrl(updated.id);
  const handleChanged = new_handle && new_handle !== handle;

  const lines = [];
  lines.push(`Updated ${type} "${updated.title}" (${updated.handle})`);
  if (handleChanged) lines.push(`Handle: ${handle} → ${updated.handle} (Shopify auto-creates a 301 redirect from the old URL)`);
  if (title !== undefined) lines.push(`SEO title: ${updated.seo?.title || '(cleared)'}`);
  if (description !== undefined) lines.push(`SEO description: ${updated.seo?.description || '(cleared)'}`);
  if (description_html !== undefined) lines.push(`On-page description: updated`);
  lines.push(`Storefront URL: ${newUrl}`);
  lines.push(`Admin: ${adminUrl}`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── seo_meta_draft ──────────────────────────────────────────────────────────

const HOUSE_STYLE_PROMPT = `You are drafting SEO meta tags for a RUBIES collection or product page. RUBIES makes gender-affirming underwear and swimwear for trans girls and women — patented no-tuck shaping that looks and feels like regular clothing.

CATEGORY ANCHORING (most important rule):
The page's display title and handle define the category this page is about. The SEO title and description MUST stay within that category. Do not broaden to adjacent categories even if some products span them.
- Collection page titled "Tops For Adults" → the SEO title is about TOPS, not "tops, bras and swimwear" or "tops and bottoms". Bras and bikini tops ARE tops, so they fit; swimwear as a category does not.
- Collection page titled "Bottoms" → about BOTTOMS, even if some products are also in a Swimwear collection.
- The product list is supporting evidence for SPECIFICS within the category (which kinds of tops, which kinds of bottoms), not for redefining what the page is.
- If the products clearly contradict the title (e.g. a "Tops" collection contains only underwear), flag it in the reasoning instead of adopting the broader scope.

HOUSE STYLE (extracted from existing live meta — match it):

TITLE pattern: [Descriptor] [Category from page title] for [Audience] | RUBIES
- Length 55–80 chars. Always end with " | RUBIES".
- Descriptors: "No-Tuck", "Gender-Affirming", "Bestselling".
- Category: take from the page's display title. Do not add adjacent categories.
- Audience: "Trans Women" (adults) or "Trans Girls & Kids" (kids) or both.
- Optional sub-category list (e.g. "| Bras & Bikini Tops") is allowed only when ALL items listed fit inside the page's category.

DESCRIPTION pattern (140–165 chars):
- Lead clause: descriptor + product type + audience, matching the page's category.
- You can name specific in-category sub-types from the product list (e.g. "bras and bikini tops" inside a Tops page).
- Sizing range: "Sizes XS–4XL" (adults) or "Youth sizes 4–16" (kids). Use en dash –.
- Trust signal at end: "60-day guarantee" / "Trusted by thousands of families" / "As seen on CNN and GMA".
- Adults audience: "trans women and teens" (catches teens shopping adult sizing).
- Kids audience: "trans girls and gender-diverse kids" (parent-facing, more inclusive).

HARD RULES (do not break):
- NO em dashes (—). Use periods, commas, or parentheses.
- Title ≤ 80 chars. Description ≤ 165 chars. (Counts include spaces.)
- Brand voice: playful, supportive, warm. Never political, righteous, or judgmental.
- Use the actual top GSC search queries provided as keyword anchors when they fit the page category. Skip queries that don't fit.

OUTPUT FORMAT (strict JSON, no prose, no code fences):
{"title":"...","description":"...","reasoning":"one short sentence covering category fit and keyword choice"}`;

async function fetchTopKeywordsForPage(supabase, pageUrl, days = 90) {
  // Match on suffix because GSC stores full URLs but page may be canonical-with-trailing-slash etc.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('gsc_keyword_pages')
    .select('keyword, impressions, clicks, position')
    .ilike('page_url', `%${pageUrl.replace(STORE_BASE, '')}%`)
    .gte('date', since);
  if (error) throw new Error(`gsc_keyword_pages query failed: ${error.message}`);

  const agg = new Map();
  for (const r of data || []) {
    const k = r.keyword;
    const cur = agg.get(k) || { keyword: k, impressions: 0, clicks: 0, positions: [] };
    cur.impressions += r.impressions || 0;
    cur.clicks += r.clicks || 0;
    if (typeof r.position === 'number') cur.positions.push(r.position);
    agg.set(k, cur);
  }
  return [...agg.values()]
    .map(k => ({
      keyword: k.keyword,
      impressions: k.impressions,
      clicks: k.clicks,
      avg_position: k.positions.length ? +(k.positions.reduce((a, b) => a + b, 0) / k.positions.length).toFixed(1) : null,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30);
}

async function handleDraft({ type, handle, audience, extra_context }) {
  if (type !== 'collection' && type !== 'product') {
    return { content: [{ type: 'text', text: `type must be "collection" or "product"` }], isError: true };
  }
  const supabase = getSupabaseClient();
  const row = await loadSyncedRow(supabase, type, handle);
  const pageUrl = pageUrlFor(type, row.handle);
  const keywords = await fetchTopKeywordsForPage(supabase, pageUrl);

  // For collections: pull the actual products inside so the model sees what
  // the page contains (bras vs panties, kids vs adults, etc.) instead of
  // guessing from the collection title alone.
  let collectionProducts = [];
  let inferredAudience = null;
  if (type === 'collection' && row.product_handles?.length) {
    collectionProducts = await loadProductsByHandles(supabase, row.product_handles);
    inferredAudience = inferAudienceFromProducts(collectionProducts);
  }

  const productSection = type === 'collection'
    ? (collectionProducts.length
        ? `Products in this collection (${collectionProducts.length}):\n${collectionProducts.map(summarizeProductForDraft).join('\n')}\n\nInferred audience from products: ${inferredAudience || 'unclear'}`
        : `(No products found in this collection — sync may be stale or collection is empty.)`)
    : [
        `Product details:`,
        row.fit_description ? `- Fit: ${row.fit_description}` : null,
        row.best_for ? `- Best for: ${row.best_for}` : null,
        row.comparison_notes ? `- Comparison: ${row.comparison_notes.slice(0, 200)}` : null,
        row.kid_sizes?.length ? `- Youth sizes: ${row.kid_sizes.join(', ')}` : null,
        row.adult_sizes?.length ? `- Adult sizes: ${row.adult_sizes.join(', ')}` : null,
        row.tags?.length ? `- Tags: ${row.tags.join(', ')}` : null,
      ].filter(Boolean).join('\n');

  const userPrompt = [
    `Drafting SEO meta for a ${type} page.`,
    ``,
    `Page URL: ${pageUrl}`,
    `Display title: ${row.title}`,
    `Handle: ${row.handle}`,
    audience ? `Audience hint from operator: ${audience}` : null,
    extra_context ? `Extra context: ${extra_context}` : null,
    ``,
    `Current SEO title: ${row.seo_title || '(default — uses display title)'}`,
    `Current SEO description: ${row.seo_description || '(default — uses description excerpt)'}`,
    ``,
    productSection,
    ``,
    keywords.length
      ? `Top GSC queries this page receives impressions on (last 90 days, sorted by impressions):\n${keywords.map(k => `- "${k.keyword}" — ${k.impressions} imp, ${k.clicks} clicks, avg position ${k.avg_position}`).join('\n')}`
      : `No GSC keyword data found for this page (likely a new or low-traffic page). Lean on category/audience inference, the product list above, and brand-voice norms.`,
    ``,
    `Return strict JSON: {"title":"...","description":"...","reasoning":"..."}`,
  ].filter(Boolean).join('\n');

  const { callClaude } = require('../../../shared/aiClient');
  const response = await callClaude({
    component: 'seo_meta_draft',
    model: MODELS.OPUS,
    max_tokens: 800,
    system: HOUSE_STYLE_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = response.content[0]?.text || '';
  let proposed;
  try {
    proposed = JSON.parse(raw);
  } catch {
    return {
      content: [{ type: 'text', text: `Draft model returned non-JSON output:\n\n${raw}\n\nTry again or adjust extra_context.` }],
      isError: true,
    };
  }

  const errs = validateMeta({ type, title: proposed.title, description: proposed.description });
  const errSection = errs.length
    ? `\n\n⚠️ Draft has validation issues — fix before pushing:\n- ${errs.join('\n- ')}`
    : '';

  const productSummaryForReport = type === 'collection' && collectionProducts.length
    ? [
        ``,
        `### Products in collection (${collectionProducts.length})`,
        collectionProducts.map(p => `- ${p.title}${p.kid_sizes?.length ? ' (youth)' : ''}${p.adult_sizes?.length ? ' (adult)' : ''}`).join('\n'),
        inferredAudience ? `\n_Inferred audience: ${inferredAudience}_` : '',
      ].join('\n')
    : '';

  const text = [
    `## SEO Meta Draft for ${type} \`${row.handle}\``,
    ``,
    `**Display title:** ${row.title}`,
    `**Storefront URL:** ${pageUrl}`,
    `**Admin:** ${getAdminUrl(row.id)}`,
    ``,
    `### Current`,
    `- Title: ${row.seo_title || '(default)'}`,
    `- Description: ${row.seo_description || '(default)'}`,
    productSummaryForReport,
    ``,
    `### Proposed`,
    `- Title (${proposed.title?.length ?? 0} chars): ${proposed.title}`,
    `- Description (${proposed.description?.length ?? 0} chars): ${proposed.description}`,
    `- Reasoning: ${proposed.reasoning || '(none)'}`,
    ``,
    `### Top GSC keywords (last 90 days)`,
    keywords.length
      ? keywords.slice(0, 10).map(k => `- "${k.keyword}" — ${k.impressions} imp, pos ${k.avg_position}`).join('\n')
      : '_No GSC data for this page._',
    errSection,
    ``,
    `To push: call \`seo_meta_update\` with type="${type}", handle="${row.handle}", title=..., description=...`,
  ].join('\n');

  return { content: [{ type: 'text', text }] };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const tools = [
  {
    name: 'seo_meta_update',
    description: 'Update the SEO title, SEO description, URL handle, and/or on-page description of a Shopify collection or product. Pass only the fields you want to change. Renaming the handle auto-creates a 301 redirect in Shopify. Validates: title ≤ 80 chars, description ≤ 165 chars, no em dashes, handle format. Resolves the target via the synced collections/products table — if a brand new collection was just created in Shopify admin, run cs-sync-collections first.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['collection', 'product'],
          description: 'Whether to update a collection or a product.',
        },
        handle: {
          type: 'string',
          description: 'The current handle (URL slug) of the collection or product to update. Required.',
        },
        new_handle: {
          type: 'string',
          description: 'New handle (URL slug). Lowercase alphanumeric with hyphens. Shopify auto-creates a 301 redirect from the old handle to the new one.',
        },
        title: {
          type: 'string',
          description: 'New SEO title (the <title> tag and search result heading). Max 80 chars. No em dashes.',
        },
        description: {
          type: 'string',
          description: 'New SEO description (the meta description). Max 165 chars. No em dashes.',
        },
        description_html: {
          type: 'string',
          description: 'Optional new on-page (visible) description HTML for the collection/product page itself. Use sparingly — pushes will replace whatever Natta has set.',
        },
      },
      required: ['type', 'handle'],
    },
    handler: handleUpdate,
  },
  {
    name: 'seo_meta_draft',
    description: 'Generate a proposed SEO title and description for a RUBIES collection or product, based on (1) the synced page metadata, (2) top GSC search queries that page receives impressions on, and (3) RUBIES house style for SEO meta. Returns a draft for human review — does NOT push any changes. To push, call seo_meta_update separately with the (possibly edited) values.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['collection', 'product'],
          description: 'Whether to draft for a collection or a product.',
        },
        handle: {
          type: 'string',
          description: 'The handle (URL slug) of the collection or product.',
        },
        audience: {
          type: 'string',
          description: 'Optional hint about the target audience (e.g. "kids only", "adults bottoms", "bras for trans women"). The model already infers from page data, but this can override.',
        },
        extra_context: {
          type: 'string',
          description: 'Optional free-form context the model should consider (e.g. "this is replacing the old new-arrivals-for-adults-copy collection").',
        },
      },
      required: ['type', 'handle'],
    },
    handler: handleDraft,
  },
];

module.exports = tools;
module.exports.validateMeta = validateMeta;
module.exports.handleUpdate = handleUpdate;
module.exports.handleDraft = handleDraft;
