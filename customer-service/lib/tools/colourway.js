/**
 * colourway.js — register_colourway
 *
 * A new colourway does not arrive as one event. The variants appear in Shopify
 * when someone builds them, the units appear in the warehouse weeks later when
 * a container lands, and the things that TELL the business the colour exists —
 * the colour metafields, the operator facts, the knowledge base — are updated
 * by hand or not at all. Sandstone on the Sassy is the worked example: 27
 * variants live in Shopify, `custom.adult_colors` still read ["Black","Pink"],
 * and an active advisor fact said "there are no new colors at the current
 * business size". The advisor offered a customer a colour that had never been
 * in stock in any size.
 *
 * This tool is the go-live half of a colourway launch: once the variants exist,
 * make every system that describes the product agree with them. It deliberately
 * does NOT decide how many units to manufacture — that is Rule 5 of the
 * ordering algorithm (initiative_production_pipeline.md), needs
 * `production_orders` history, and shares no data with this.
 *
 * WHAT IT WRITES vs WHAT IT REPORTS
 *
 * It writes exactly one thing: the `custom.adult_colors` / `custom.kid_colors`
 * metafields, recomputed from the variants that actually exist. That is a
 * derived value being brought back in line with its own source, so it is safe
 * to compute rather than ask about.
 *
 * Everything else is REPORTED for the founder to action. Retiring an
 * `advisor_facts` row is a founder decision by standing policy (facts are
 * approved and retired by Jamie, never silently), and re-extracting a KB
 * article is a pipeline run with its own review step. A tool that quietly
 * retired a fact would be doing the one thing the facts table exists to
 * prevent. So this surfaces the contradiction and names the row.
 *
 * WHY THE METAFIELD IS DERIVED, NOT ASKED FOR
 *
 * The variants are the only thing that can be wrong in a way nobody notices.
 * `adult_colors` is a hand-maintained restatement of them, so asking an operator
 * to type the colour list again just moves the drift one step later. The union
 * of colours present on live variants IS the answer; the metafield is a cache of
 * it. Note this is availability-blind ON PURPOSE — the metafield answers "what
 * colours is this product made in", which stays true while a colour sits at zero
 * waiting for a container. What can SHIP is a different question, answered from
 * live inventory by `colorsInStock` (see productCache.js), and the two must not
 * be collapsed: a colour that is real but unavailable still belongs in the
 * catalogue.
 *
 * Sizes decide which metafield a colour lands in: a product with kid sizes gets
 * kid_colors, adult sizes get adult_colors, and a product with both gets both,
 * matching how syncProducts maps them back.
 */
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { shopifyGraphQL, getAdminUrl } = require('../shopify');
const { colorsInStock } = require('../productCache');

// Adult letter sizes, in the spelling Shopify variant titles use. Anything that
// is not one of these and not empty is treated as a kid size (the numeric
// range), which is how the catalogue splits them.
const ADULT_SIZES = new Set(['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', 'XL', '1X', '2XL', '2X', '3XL', '3X', '4XL', '4X']);

function splitVariantTitle(title) {
  const parts = String(title || '').split('/');
  if (parts.length < 2) return { color: null, size: (parts[0] || '').trim() || null };
  return { color: parts[0].trim() || null, size: parts.slice(1).join('/').trim() || null };
}

/**
 * Recompute the colour lists from the variants that exist.
 *
 * Availability-blind by design (see file header): a colour on the container is
 * still a colour the product is made in. Returns null lists for a product with
 * no colour axis at all (bundles, gift cards — variant title "Default Title"),
 * so the caller can skip rather than write an empty list over a real one.
 */
function deriveColorLists(variants) {
  const adult = new Set();
  const kid = new Set();
  let sawColorAxis = false;
  for (const v of variants || []) {
    const { color, size } = splitVariantTitle(v.title);
    if (!color || !size) continue;
    sawColorAxis = true;
    const normalized = size.toUpperCase();
    if (ADULT_SIZES.has(normalized)) adult.add(color);
    else kid.add(color);
  }
  if (!sawColorAxis) return null;
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b));
  return { adult_colors: sort(adult), kid_colors: sort(kid) };
}

function sameList(a, b) {
  const x = [...(a || [])].sort();
  const y = [...(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Facts that assert something about colours. Deliberately a wide net matched on
 * the fact TEXT rather than a category: the Sandstone-contradicting fact was
 * filed under a supply/policy category, so a category filter would have missed
 * the one row that mattered. Over-reporting here costs the founder a glance;
 * under-reporting leaves a confidently wrong statement in every draft.
 */
async function contradictingFacts(supabase) {
  const { data, error } = await supabase
    .from('advisor_facts')
    .select('id, fact, status, category')
    .eq('status', 'active');
  if (error) throw new Error(`advisor_facts lookup failed: ${error.message}`);
  return (data || []).filter(f => /colou?rway|colou?rs?\b/i.test(f.fact || ''));
}

/** KB articles about this product, which may enumerate its colours in prose. */
async function kbSourcesForProduct(supabase, productTitle) {
  const { data, error } = await supabase
    .from('kb_sources')
    .select('id, title, source_url, status')
    .ilike('title', `%${productTitle.split(' ')[0]}%`)
    .limit(25);
  if (error) throw new Error(`kb_sources lookup failed: ${error.message}`);
  return data || [];
}

async function setColorMetafields(ownerId, lists) {
  const metafields = [];
  if (lists.adult_colors.length) {
    metafields.push({ ownerId, namespace: 'custom', key: 'adult_colors', type: 'list.single_line_text_field', value: JSON.stringify(lists.adult_colors) });
  }
  if (lists.kid_colors.length) {
    metafields.push({ ownerId, namespace: 'custom', key: 'kid_colors', type: 'list.single_line_text_field', value: JSON.stringify(lists.kid_colors) });
  }
  if (!metafields.length) return 0;
  const d = await shopifyGraphQL(`
    mutation metafieldsSet($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){ metafields{ key } userErrors{ field message } } }`,
    { metafields });
  const errs = d?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet failed: ${errs.map(e => e.message).join('; ')}`);
  return (d.metafieldsSet.metafields || []).length;
}

/**
 * The whole report. Pure-ish: reads Supabase + Shopify, writes only when
 * `confirmed`. Split out from the MCP handler so tests can call it directly.
 */
async function planColourway({ product, colour, confirmed = false }) {
  const supabase = getSupabaseClient();

  const { data: matches, error } = await supabase
    .from('products')
    .select('shopify_product_id, title, handle, adult_colors, kid_colors, status')
    .or(`title.ilike.%${product}%,handle.ilike.%${product}%`);
  if (error) throw new Error(`product lookup failed: ${error.message}`);
  const active = (matches || []).filter(p => p.status === 'ACTIVE');
  const pool = active.length ? active : (matches || []);
  if (!pool.length) return { error: `No product matching "${product}".` };
  if (pool.length > 1) {
    return { error: `"${product}" matches ${pool.length} products: ${pool.map(p => p.title).join(', ')}. Be more specific.` };
  }
  const p = pool[0];

  const { data: variants, error: vErr } = await supabase
    .from('product_variants')
    .select('sku, title, inventory_quantity, pre_order_incoming, pre_order_date')
    .eq('shopify_product_id', p.shopify_product_id);
  if (vErr) throw new Error(`variant lookup failed: ${vErr.message}`);

  const derived = deriveColorLists(variants);
  if (!derived) {
    return { error: `${p.title} has no colour axis on its variants — nothing to register.` };
  }

  const colourVariants = (variants || []).filter(v => {
    const { color } = splitVariantTitle(v.title);
    return color && color.toLowerCase() === String(colour || '').toLowerCase();
  });
  if (!colourVariants.length) {
    const present = [...new Set((variants || []).map(v => splitVariantTitle(v.title).color).filter(Boolean))];
    return { error: `No "${colour}" variants exist on ${p.title}. Colours on its variants: ${present.join(', ') || '(none)'}. Build the variants in Shopify first — this tool makes the rest of the business agree with them, it does not create them.` };
  }

  // Availability, stated as three distinct states. "On the water" is the state
  // that has no representation anywhere else and is the whole reason a launch
  // window is confusing: real, catalogued, and unshippable.
  const onHand = colourVariants.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
  const incoming = colourVariants.reduce((s, v) => s + (v.pre_order_incoming || 0), 0);
  const availability = onHand > 0 ? 'sellable' : (incoming > 0 ? 'on_the_water' : 'none');

  const metafieldChange = {
    adult_colors: { from: p.adult_colors || [], to: derived.adult_colors, changed: !sameList(p.adult_colors, derived.adult_colors) },
    kid_colors: { from: p.kid_colors || [], to: derived.kid_colors, changed: !sameList(p.kid_colors, derived.kid_colors) },
  };

  const facts = await contradictingFacts(supabase);
  const kb = await kbSourcesForProduct(supabase, p.title);

  const plan = {
    product: { title: p.title, handle: p.handle, admin_url: getAdminUrl(p.shopify_product_id) },
    colour,
    variants_found: colourVariants.length,
    availability,
    units_on_hand: onHand,
    units_incoming: incoming,
    in_stock_colours_now: colorsInStock(colourVariants.map(v => ({ variantTitle: v.title, inventoryQuantity: v.inventory_quantity }))),
    metafields: metafieldChange,
    facts_to_review: facts,
    kb_sources_to_recheck: kb,
    applied: false,
  };

  if (!confirmed) return plan;

  if (metafieldChange.adult_colors.changed || metafieldChange.kid_colors.changed) {
    plan.metafields_written = await setColorMetafields(p.shopify_product_id, derived);
    // Pull the write back into the mirror immediately. Best-effort: a sync
    // failure must not undo a successful Shopify write, and the daily sync
    // reconciles regardless (same contract as create_product).
    try {
      const { run: syncProducts } = require('../../sync/syncProducts');
      await syncProducts();
      plan.synced = true;
    } catch (err) {
      plan.synced = false;
      plan.sync_error = err.message;
    }
  } else {
    plan.metafields_written = 0;
  }
  plan.applied = true;
  return plan;
}

function render(plan) {
  if (plan.error) return plan.error;
  const L = [];
  L.push(`## ${plan.applied ? 'Registered' : 'Preview —'} ${plan.colour} on ${plan.product.title}`);
  L.push('');
  L.push(`${plan.variants_found} ${plan.colour} variants exist.`);
  const avail = {
    sellable: `**Sellable now** — ${plan.units_on_hand} units on hand.`,
    on_the_water: `**Not sellable yet** — 0 on hand, ${plan.units_incoming} units incoming. The colour is real and catalogued but nothing can ship in it.`,
    none: `**Not sellable and nothing inbound** — 0 on hand, no incoming units recorded.`,
  }[plan.availability];
  L.push(avail);
  L.push('');

  const mf = plan.metafields;
  if (mf.adult_colors.changed || mf.kid_colors.changed) {
    L.push(plan.applied ? '### Colour metafields updated' : '### Colour metafields to update');
    for (const key of ['adult_colors', 'kid_colors']) {
      if (mf[key].changed) L.push(`- \`${key}\`: ${JSON.stringify(mf[key].from)} → ${JSON.stringify(mf[key].to)}`);
    }
  } else {
    L.push('### Colour metafields already correct');
  }
  L.push('');

  if (plan.facts_to_review.length) {
    L.push('### Operator facts mentioning colour — review these');
    L.push('These are injected verbatim into every draft and outrank the knowledge base, so a stale one is stated confidently. Retire or edit in the dashboard Facts panel; this tool never changes them.');
    for (const f of plan.facts_to_review) L.push(`- **#${f.id}** (${f.category || 'uncategorized'}): ${f.fact}`);
    L.push('');
  }

  if (plan.kb_sources_to_recheck.length) {
    L.push('### Knowledge base articles to re-check');
    L.push('Any that enumerate colours in prose need re-extraction, and the copy on the site is the source they are harvested from — fix that too or the next harvest reintroduces it.');
    for (const s of plan.kb_sources_to_recheck) L.push(`- ${s.title}`);
    L.push('');
  }

  if (!plan.applied) L.push('Call again with `confirmed: true` to write the metafields.');
  else if (plan.synced === false) L.push(`Metafields written. Supabase sync failed (${plan.sync_error}) — the daily sync will reconcile.`);
  else if (plan.metafields_written) L.push('Metafields written and synced.');
  return L.join('\n');
}

const tools = [
  {
    name: 'register_colourway',
    description: [
      'Bring every system that describes a product into line with a newly added colourway.',
      'Use AFTER the variants exist in Shopify — this does not create variants or decide manufacturing quantities.',
      'Recomputes the custom.adult_colors / custom.kid_colors metafields from the variants that actually exist (the metafield is a hand-maintained restatement of them and drifts on every colour launch), reports whether the colour can actually ship yet, and surfaces the operator facts and knowledge-base articles that may now contradict it.',
      'Two-phase: call without confirmed for a preview, then with confirmed=true to write the metafields. Only the metafields are ever written; facts and KB articles are reported for founder review, never changed.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product name or handle (e.g. "Sassy").' },
        colour: { type: 'string', description: 'The new colour exactly as it appears on the variants (e.g. "Sandstone").' },
        confirmed: { type: 'boolean', description: 'true to apply the metafield update.' },
      },
      required: ['product', 'colour'],
    },
    handler: async ({ product, colour, confirmed }) => {
      const plan = await planColourway({ product, colour, confirmed: confirmed === true });
      return { content: [{ type: 'text', text: render(plan) }] };
    },
  },
];

module.exports = tools;
Object.assign(module.exports, { deriveColorLists, splitVariantTitle, planColourway, render, sameList });
