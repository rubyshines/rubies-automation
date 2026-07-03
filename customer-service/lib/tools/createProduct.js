/**
 * Tool: create_product — build a launch-complete RUBIES product in Shopify + Supabase.
 *
 * Codifies the manual Evey finish (scripts/_finishEvey.js) into a reusable,
 * idempotent operation. One call produces a product that is comparison-table
 * ready and known to the CS advisor:
 *   - Shopify product (DRAFT) with correct title/handle (no "THE"), tiered
 *     variants + SKUs, the full custom.* metafield set (live keys), copied
 *     shopify.* taxonomy, SEO, description, and collection membership.
 *   - product_cs_config row so sizing/advisor classify it.
 *
 * Idempotent: keyed by handle. If the product already exists (e.g. a half-built
 * DRAFT cloned in the admin), it UPDATES rather than duplicates — matching
 * variants by their color/size options.
 *
 * Architecture note: Shopify is the source of truth for product data; this tool
 * writes Shopify and mirrors to Supabase via the standard product sync. The only
 * thing it owns outright is the CS-config row (no Shopify equivalent).
 *
 * Design-specific taxonomy (bra-style / bra-strap-type / bra-coverage) is
 * intentionally NOT set here — those are picked visually in the admin.
 */

const {
  shopifyGraphQL,
  createShopifyProduct,
  createProductVariants,
  updateProductStatus,
  updateProductSeo,
  getAdminUrl,
} = require('../shopify');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { callClaude } = require('../../../shared/aiClient');
const { MODELS } = require('../../../shared/aiPricing');

// ---------------------------------------------------------------------------
// Category defaults (starting suggestions only — callers pass explicit sizes,
// since real products deviate, e.g. bras ship XS–4X not the full XXS–4X)
// ---------------------------------------------------------------------------

const CATEGORY_DEFAULTS = {
  underwear_bottom: { deltaWording: 'bottom', productType: 'Underwear', productCollection: ['Underwear'], productCategory: ['Bottoms'] },
  underwear_top:    { deltaWording: 'bra',    productType: 'Bra',       productCollection: ['Underwear'], productCategory: ['Tops'] },
  swim_bottom:      { deltaWording: 'bottom', productType: 'Swimwear',  productCollection: ['Swimwear'],  productCategory: ['Bottoms'] },
  swim_top:         { deltaWording: 'bikini_top', productType: 'Swimwear', productCollection: ['Swimwear'], productCategory: ['Tops'] },
  onepiece:         { deltaWording: 'bottom', productType: 'Swimwear',  productCollection: ['Swimwear'],  productCategory: ['Onepiece'] },
  chest_pads:       { deltaWording: null,     productType: 'Accessories', productCollection: ['Accessories'], productCategory: [] },
  accessory:        { deltaWording: null,     productType: 'Accessories', productCollection: ['Accessories'], productCategory: [] },
};

// Numeric (youth) sizes are "kids"; letter sizes are "adult".
const NUMERIC_SIZE_RE = /^\d+$/;
function isYouthSize(size) { return NUMERIC_SIZE_RE.test(String(size)); }

// ---------------------------------------------------------------------------
// Deterministic builders (pure — covered by tests)
// ---------------------------------------------------------------------------

/** Strip a leading "the", lowercase, hyphenate → Shopify handle. */
function deriveHandle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^the-/, '');
}

/** Uppercase display title with any leading "THE " removed. */
function normalizeTitle(title) {
  return String(title || '').trim().replace(/^the\s+/i, '').toUpperCase();
}

function skuFor(prefix, colorCode, size) {
  return `${prefix}-${colorCode}-${size}`;
}

/**
 * pricing is either { flat: N } or { tiers: [{ sizes:[...], price:N }], default:N }.
 * Returns a "NN.00" string.
 */
function priceFor(size, pricing) {
  let n;
  if (pricing && pricing.flat != null) {
    n = pricing.flat;
  } else if (pricing && Array.isArray(pricing.tiers)) {
    const tier = pricing.tiers.find(t => (t.sizes || []).map(String).includes(String(size)));
    n = tier ? tier.price : pricing.default;
  }
  if (n == null) throw new Error(`priceFor: no price for size "${size}"`);
  return Number(n).toFixed(2);
}

/**
 * Build the Shopify variant inputs (one per color × size).
 * colors: [{ name, code }], sizes: ordered string[] (youth first, then adult).
 */
function buildVariants({ sizes, colors, skuPrefix, pricing, sizeOptionName = 'Size' }) {
  const variants = [];
  for (const color of colors) {
    for (const size of sizes) {
      variants.push({
        optionValues: [
          { name: String(size), optionName: sizeOptionName },
          { name: color.name, optionName: 'Color' },
        ],
        sku: skuFor(skuPrefix, color.code, size),
        price: priceFor(size, pricing),
      });
    }
  }
  return variants;
}

/**
 * Map plan variants to the productVariantsBulkCreate input shape. SKU lives under
 * inventoryItem in the current Admin API (a top-level `sku` field is rejected).
 */
function toBulkCreateInput(variants) {
  return variants.map(v => ({
    optionValues: v.optionValues,
    price: v.price,
    inventoryItem: { sku: v.sku },
  }));
}

/** Build the materials_composition rich-text value from {body, lining} or a prebuilt object/string. */
function materialsRichText(materials) {
  if (!materials) return null;
  if (typeof materials === 'string') return materials;
  if (materials.type === 'root') return JSON.stringify(materials); // already rich text
  const lines = [];
  if (materials.body) lines.push(`Body: ${materials.body}`);
  if (materials.lining) lines.push(`Lining: ${materials.lining}`);
  if (!lines.length) return null;
  return JSON.stringify({
    type: 'root',
    children: lines.map(value => ({ type: 'paragraph', children: [{ type: 'text', value }] })),
  });
}

function list(values) { return JSON.stringify(values); }

/** Build the custom.* metafields using the LIVE Shopify keys. */
function buildCustomMetafields(input) {
  const mf = [];
  const add = (key, type, value) => { if (value != null && value !== '') mf.push({ key, type, value }); };
  const L = 'list.single_line_text_field';
  const S = 'single_line_text_field';

  add('product_collection', L, input.productCollection ? list(input.productCollection) : null);
  add('product_category', L, input.productCategory ? list(input.productCategory) : null);
  add('product_age', L, input.ageGroups ? list(input.ageGroups) : null);
  if (input.adultSizes?.length) add('adult_sizes', L, list(input.adultSizes));
  if (input.kidSizes?.length) add('kid_sizes', L, list(input.kidSizes));
  const colorNames = (input.colors || []).map(c => c.name);
  if (colorNames.length) {
    add('adult_colors', L, list(colorNames));
    if ((input.ageGroups || []).includes('Kids')) add('kid_colors', L, list(colorNames));
  }
  add('nickname', S, input.nickname);
  add('fit_description', S, input.copy?.fit_description);
  add('best_for', S, input.copy?.best_for);
  add('comparison_notes', S, input.copy?.comparison_notes);
  const mat = materialsRichText(input.copy?.materials);
  add('materials_composition', 'rich_text_field', mat);
  return mf;
}

function buildCsConfigRow(input) {
  const cat = CATEGORY_DEFAULTS[input.category] || {};
  return {
    product_handle: input.handle,
    nickname: input.nickname,
    category: input.category,
    keywords: input.keywords && input.keywords.length ? input.keywords : [String(input.nickname || '').toLowerCase()],
    delta_wording: input.deltaWording || cat.deltaWording || null,
    sizes_override: input.sizesOverride || null,
    style_switch: input.styleSwitch || null,
    status: 'draft',
  };
}

/**
 * Assemble the full deterministic plan from a normalized input.
 * Does NOT touch Shopify/Supabase — pure. applyPlan() executes it.
 */
function buildPlan(rawInput) {
  const cat = CATEGORY_DEFAULTS[rawInput.category] || {};
  const handle = rawInput.handle || deriveHandle(rawInput.title);
  const title = normalizeTitle(rawInput.title);

  const kidSizes = rawInput.kidSizes || [];
  const adultSizes = rawInput.adultSizes || [];
  const sizes = [...kidSizes, ...adultSizes];
  const ageGroups = rawInput.ageGroups
    || [...(kidSizes.length ? ['Kids'] : []), ...(adultSizes.length ? ['Adults'] : [])];
  // Combined youth+adult products label the size option "Youth Size" on the live store.
  const sizeOptionName = kidSizes.length && adultSizes.length ? 'Youth Size' : 'Size';

  const input = {
    ...rawInput,
    handle, title, ageGroups,
    productCollection: rawInput.productCollection || cat.productCollection,
    productCategory: rawInput.productCategory || cat.productCategory,
  };

  const variants = buildVariants({
    sizes,
    colors: rawInput.colors || [],
    skuPrefix: rawInput.skuPrefix,
    pricing: rawInput.pricing,
    sizeOptionName,
  });

  return {
    existingHandle: rawInput.existingHandle || null,
    product: {
      title, handle,
      status: 'DRAFT',
      vendor: 'RUBIES',
      productType: rawInput.productType || cat.productType || null,
      tags: rawInput.tags || [rawInput.category, ...ageGroups].filter(Boolean),
      descriptionHtml: rawInput.description || null,
    },
    seo: rawInput.seo || null,
    variants,
    customMetafields: buildCustomMetafields(input),
    copyTaxonomyFrom: rawInput.copyTaxonomyFrom || null,
    deleteLegacy: rawInput.deleteLegacy || [],
    collections: rawInput.collections || [],
    csConfig: buildCsConfigRow(input),
  };
}

/** Which launch-critical pieces are missing from a plan. */
function checkCompleteness(plan) {
  const missing = [];
  if (!plan.product.title) missing.push('title');
  if (!plan.product.handle) missing.push('handle');
  if (!plan.product.descriptionHtml) missing.push('description');
  if (!plan.variants.length) missing.push('variants');
  if (plan.variants.some(v => !v.sku)) missing.push('variant SKUs');
  if (plan.variants.some(v => !v.price || Number(v.price) <= 0)) missing.push('variant prices');
  const keys = new Set(plan.customMetafields.map(m => m.key));
  for (const req of ['product_collection', 'product_category', 'product_age', 'nickname',
    'fit_description', 'best_for', 'comparison_notes', 'materials_composition']) {
    if (!keys.has(req)) missing.push(`metafield ${req}`);
  }
  if (!plan.seo?.title || !plan.seo?.description) missing.push('seo');
  if (!plan.collections.length) missing.push('collections');
  if (!plan.csConfig.category) missing.push('cs_config category');
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Shopify side effects
// ---------------------------------------------------------------------------

async function fetchProductByHandle(handle) {
  const q = `query($h:String!){ productByHandle(handle:$h){ id title handle status
    variants(first:100){ edges{ node{ id selectedOptions{ name value } } } } } }`;
  const d = await shopifyGraphQL(q, { h: handle });
  return d.productByHandle;
}

async function setMetafields(ownerId, listOfMf, namespace) {
  if (!listOfMf.length) return 0;
  const metafields = listOfMf.map(m => ({ ownerId, namespace, key: m.key, type: m.type, value: m.value }));
  const d = await shopifyGraphQL(`
    mutation metafieldsSet($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){ metafields{ key } userErrors{ field message } } }`,
    { metafields });
  return d.metafieldsSet.metafields.length;
}

async function deleteMetafields(ownerId, identifiers) {
  for (const id of identifiers) {
    await shopifyGraphQL(`
      mutation metafieldsDelete($metafields:[MetafieldIdentifierInput!]!){
        metafieldsDelete(metafields:$metafields){ deletedMetafields{ key } userErrors{ field message } } }`,
      { metafields: [{ ownerId, namespace: id.namespace || 'custom', key: id.key }] });
  }
}

/** Copy design-independent shopify.* taxonomy from an analog product. */
async function copyTaxonomyFromAnalog(fromHandle, toProductId) {
  const SAFE_KEYS = ['color-pattern', 'target-gender', 'fabric', 'care-instructions', 'bra-closure-type', 'bra-features'];
  const q = `query($h:String!){ productByHandle(handle:$h){ metafields(first:60){ edges{ node{ namespace key type value } } } } }`;
  const p = (await shopifyGraphQL(q, { h: fromHandle })).productByHandle;
  if (!p) return 0;
  const copy = p.metafields.edges.map(e => e.node)
    .filter(m => m.namespace === 'shopify' && SAFE_KEYS.includes(m.key))
    .map(m => ({ key: m.key, type: m.type, value: m.value }));
  return setMetafields(toProductId, copy, 'shopify');
}

async function resolveCollectionIds(handles) {
  if (!handles.length) return [];
  const ids = [];
  for (const h of handles) {
    const d = await shopifyGraphQL(`query($h:String!){ collectionByHandle(handle:$h){ id } }`, { h });
    if (d.collectionByHandle?.id) ids.push(d.collectionByHandle.id);
  }
  return ids;
}

async function addToCollections(productId, handles) {
  const ids = await resolveCollectionIds(handles);
  for (const collectionId of ids) {
    await shopifyGraphQL(`
      mutation collectionAddProducts($id:ID!,$productIds:[ID!]!){
        collectionAddProducts(id:$id, productIds:$productIds){ collection{ handle } userErrors{ field message } } }`,
      { id: collectionId, productIds: [productId] });
  }
  return ids.length;
}

/** Update SKUs + prices on an existing product by matching color/size options. */
async function reconcileVariants(existing, plannedVariants) {
  const bySig = new Map();
  for (const e of existing.variants.edges.map(x => x.node)) {
    const color = e.selectedOptions.find(o => o.name === 'Color')?.value;
    const size = e.selectedOptions.find(o => o.name !== 'Color')?.value;
    bySig.set(`${color}/${size}`, e.id);
  }
  const updates = [];
  for (const v of plannedVariants) {
    const color = v.optionValues.find(o => o.optionName === 'Color')?.name;
    const size = v.optionValues.find(o => o.optionName !== 'Color')?.name;
    const id = bySig.get(`${color}/${size}`);
    if (id) updates.push({ id, price: v.price, inventoryItem: { sku: v.sku } });
  }
  if (!updates.length) return 0;
  await shopifyGraphQL(`
    mutation productVariantsBulkUpdate($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
      productVariantsBulkUpdate(productId:$productId, variants:$variants){ productVariants{ id } userErrors{ field message } } }`,
    { productId: existing.id, variants: updates });
  return updates.length;
}

async function upsertCsConfig(row) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('product_cs_config')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'product_handle' });
  if (error) throw new Error(`cs config upsert failed: ${error.message}`);
}

/**
 * Generate a description in the house style, learned from an analog product.
 * Returns HTML. Enforces no em dashes (brand rule) as a final guard.
 */
async function generateDescription({ analogHandle, facts }) {
  let styleSample = '';
  if (analogHandle) {
    const q = `query($h:String!){ productByHandle(handle:$h){ descriptionHtml } }`;
    styleSample = (await shopifyGraphQL(q, { h: analogHandle }))?.productByHandle?.descriptionHtml || '';
  }
  const system = [
    'You write product descriptions for RUBIES, which makes gender-affirming underwear and swimwear for trans girls and women.',
    'Voice: playful but respectful, confident but approachable, positive and supportive. Never political, righteous, or judgmental.',
    'Hard rules: no em dashes (use commas, parentheses, or short sentences). Keep it open and inclusive, do not narrow the audience to any medical status. Two short paragraphs, plain HTML <p> tags only.',
    styleSample ? `Match the tone and structure of this existing RUBIES description:\n${styleSample}` : '',
  ].filter(Boolean).join('\n\n');

  const res = await callClaude({
    component: 'create_product',
    model: MODELS.OPUS,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: `Write the description for this product:\n${JSON.stringify(facts, null, 2)}` }],
  });
  let html = (res?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  html = html.replace(/—/g, ',').replace(/\s*—\s*/g, ', ');
  return html;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyPlan(plan, { log = () => {} } = {}) {
  const findHandle = plan.existingHandle || plan.product.handle;
  let existing = await fetchProductByHandle(findHandle);
  let productId;

  if (existing) {
    productId = existing.id;
    await updateProductSeo({
      id: productId,
      handle: plan.product.handle,
      title: plan.product.title,
      descriptionHtml: plan.product.descriptionHtml || undefined,
      seoTitle: plan.seo?.title,
      seoDescription: plan.seo?.description,
    });
    log('updated product (title/handle/seo/description)');
    const n = await reconcileVariants(existing, plan.variants);
    log(`reconciled ${n} variants (sku + price)`);
  } else {
    const created = await createShopifyProduct({
      title: plan.product.title,
      handle: plan.product.handle,
      status: 'DRAFT',
      vendor: plan.product.vendor,
      productType: plan.product.productType || undefined,
      tags: plan.product.tags,
      descriptionHtml: plan.product.descriptionHtml || `<p>${plan.product.title}</p>`,
    });
    productId = created.id;
    log(`created product ${created.id}`);
    if (plan.variants.length) {
      const made = await createProductVariants(productId, toBulkCreateInput(plan.variants));
      log(`created ${made.length} variants`);
    }
    if (plan.seo) {
      await updateProductSeo({ id: productId, seoTitle: plan.seo.title, seoDescription: plan.seo.description });
      log('set seo');
    }
  }

  await setMetafields(productId, plan.customMetafields, 'custom');
  log(`set ${plan.customMetafields.length} custom metafields`);
  if (plan.deleteLegacy.length) { await deleteMetafields(productId, plan.deleteLegacy); log('removed legacy metafields'); }
  if (plan.copyTaxonomyFrom) { const t = await copyTaxonomyFromAnalog(plan.copyTaxonomyFrom, productId); log(`copied ${t} shopify.* taxonomy fields`); }
  if (plan.collections.length) { const c = await addToCollections(productId, plan.collections); log(`added to ${c} collections`); }
  await upsertCsConfig(plan.csConfig);
  log('upserted product_cs_config (draft)');

  return { productId, adminUrl: getAdminUrl(productId), created: !existing };
}

/** Full pipeline: (optionally generate description) -> plan -> preview/commit. */
async function runCreateProduct(input, { commit = false } = {}) {
  const enriched = { ...input };
  if (input.generateDescriptionFrom || input.description === 'generate') {
    enriched.description = await generateDescription({
      analogHandle: input.generateDescriptionFrom || input.copyTaxonomyFrom,
      facts: {
        name: input.nickname, title: input.title, category: input.category,
        fit: input.copy?.fit_description, best_for: input.copy?.best_for,
        features: input.copy?.comparison_notes,
      },
    });
  }
  const plan = buildPlan(enriched);
  const completeness = checkCompleteness(plan);
  if (!commit) return { preview: plan, completeness };
  const logs = [];
  const result = await applyPlan(plan, { log: m => logs.push(m) });
  // Mirror to Supabase immediately (drafts now sync). Best-effort — a sync failure
  // must not undo a successful Shopify write; the daily sync reconciles regardless.
  try {
    const { run: syncProducts } = require('../../sync/syncProducts');
    await syncProducts();
    logs.push('synced to Supabase');
  } catch (err) {
    logs.push(`sync skipped: ${err.message}`);
  }
  return { result, completeness, logs, generatedDescription: enriched.description };
}

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'create_product',
    description: 'Create a launch-complete RUBIES product in Shopify (as DRAFT) and register it with the CS advisor, or finish a half-built DRAFT (idempotent by handle). Sets tiered variants + SKUs, the full custom.* metafield set (comparison-table + PDP fields), copies design-independent shopify.* taxonomy from an analog product, SEO, description (can be auto-generated in house style from an analog), collection membership, and a product_cs_config row. Design-specific taxonomy (bra-style/strap/coverage) and product images are left for the Shopify admin. Two-phase: call with commit=false (default) to preview the full plan + a completeness check; call with commit=true to apply. Never publishes — the product stays DRAFT.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Full product title (a leading "THE" is stripped; result is upper-cased).' },
        existingHandle: { type: 'string', description: 'If finishing a product that already exists under a different handle, its current handle. Omit for a brand-new product.' },
        category: { type: 'string', enum: Object.keys(CATEGORY_DEFAULTS), description: 'CS sizing category. Drives delta wording, product type, and taxonomy defaults.' },
        kidSizes: { type: 'array', items: { type: 'string' }, description: 'Youth (numeric) sizes, e.g. ["6","8","10","12","14","16"]. Omit for adult-only.' },
        adultSizes: { type: 'array', items: { type: 'string' }, description: 'Adult (letter) sizes, e.g. ["XS","S","M","L","1X","2X","3X","4X"].' },
        colors: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' } }, required: ['name', 'code'] }, description: 'Colors with SKU codes, e.g. [{"name":"Black","code":"BLK"}].' },
        skuPrefix: { type: 'string', description: 'SKU prefix, e.g. "SPB". SKUs become PREFIX-COLORCODE-SIZE.' },
        pricing: { type: 'object', description: 'Either {"flat": 42} or {"tiers":[{"sizes":["6","8","10"],"price":39}],"default":42}.' },
        nickname: { type: 'string', description: 'Short customer-facing name, e.g. "Evey".' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'CS match keywords for the advisor/sizing.' },
        copy: { type: 'object', description: 'Comparison/PDP copy: { fit_description, best_for, comparison_notes, materials: { body, lining } }.' },
        description: { type: 'string', description: 'PDP description HTML, or the literal "generate" to auto-write it in house style (uses generateDescriptionFrom or copyTaxonomyFrom as the style analog).' },
        generateDescriptionFrom: { type: 'string', description: 'Analog product handle whose description style to imitate when auto-generating.' },
        seo: { type: 'object', description: '{ title, description } for search. Keep title <=80, description <=165, no em dashes.' },
        collections: { type: 'array', items: { type: 'string' }, description: 'Collection handles to add the product to, e.g. ["adults-underwear","kids-underwear"].' },
        copyTaxonomyFrom: { type: 'string', description: 'Analog product handle to copy design-independent shopify.* taxonomy from (e.g. "the-brooke-bra").' },
        deleteLegacy: { type: 'array', items: { type: 'object', properties: { namespace: { type: 'string' }, key: { type: 'string' } }, required: ['key'] }, description: 'Legacy metafields to remove (e.g. cloned pre_order_skus).' },
        commit: { type: 'boolean', description: 'false (default) previews the plan + completeness; true applies to Shopify + Supabase.' },
      },
      required: ['title', 'category', 'colors', 'skuPrefix', 'pricing', 'nickname'],
    },
    handler: async (args) => {
      const { commit = false, ...input } = args;
      try {
        const out = await runCreateProduct(input, { commit });
        if (!commit) {
          const p = out.preview;
          const lines = [
            `PREVIEW — ${p.product.title} (${p.product.handle})  [not written]`,
            `Variants: ${p.variants.length}  (${p.variants.slice(0, 3).map(v => `${v.sku} $${v.price}`).join(', ')}...)`,
            `Metafields: ${p.customMetafields.map(m => m.key).join(', ')}`,
            `Taxonomy from: ${p.copyTaxonomyFrom || '(none)'}  Collections: ${p.collections.join(', ') || '(none)'}`,
            `CS config: ${p.csConfig.category} / kw=${p.csConfig.keywords.join('|')}`,
            out.completeness.ok ? 'Completeness: OK' : `Completeness: MISSING -> ${out.completeness.missing.join(', ')}`,
            'Re-run with commit=true to apply.',
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        const r = out.result;
        return { content: [{ type: 'text', text: [
          `${r.created ? 'Created' : 'Updated'} ${input.title} (DRAFT).`,
          ...out.logs.map(l => `  - ${l}`),
          out.completeness.ok ? 'Completeness: OK — ready to publish once images + design taxonomy are set in admin.' : `Still missing: ${out.completeness.missing.join(', ')}`,
          `Admin: ${r.adminUrl}`,
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `create_product failed: ${err.message}` }] };
      }
    },
  },
];

module.exports = tools;
Object.assign(module.exports, {
  deriveHandle, normalizeTitle, skuFor, priceFor, buildVariants, toBulkCreateInput,
  materialsRichText, buildCustomMetafields, buildCsConfigRow, buildPlan,
  checkCompleteness, generateDescription, runCreateProduct, applyPlan,
});

// ---------------------------------------------------------------------------
// CLI: node customer-service/lib/tools/createProduct.js <input.json> [--commit]
// Reads a product spec from a JSON file (same shape as the create_product tool
// input). Previews by default; --commit applies. Thin wrapper over the tool.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
  const fs = require('fs');
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('Usage: createProduct.js <input.json> [--commit]'); process.exit(1); }
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));

  runCreateProduct(input, { commit })
    .then(out => {
      if (!commit) {
        console.log(`\nPREVIEW — ${out.preview.product.title} (${out.preview.product.handle})`);
        console.log(`Variants: ${out.preview.variants.length}, metafields: ${out.preview.customMetafields.length}`);
        console.log(out.completeness.ok ? 'Completeness: OK' : `Missing: ${out.completeness.missing.join(', ')}`);
        console.log('Re-run with --commit to apply.');
      } else {
        (out.logs || []).forEach(l => console.log(`  - ${l}`));
        console.log(out.completeness.ok ? 'Completeness: OK' : `Still missing: ${out.completeness.missing.join(', ')}`);
        console.log(`Admin: ${out.result.adminUrl}`);
      }
    })
    .catch(e => { console.error('ERR', e.message); process.exit(1); });
}
