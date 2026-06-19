/**
 * discounts.js — manage the automatic discounts RUBIES hand-runs: volume discounts
 * and sales. Ports rubies-utilities/scripts/core/manage-discounts.js + the Google
 * Sheet into code, backed by the `managed_discounts` Supabase registry.
 *
 * THE COMBINATION INVARIANTS (the fragile part Jamie spent forever tuning — encoded
 * here once so nobody re-derives them):
 *
 *   - Volume discounts are PRODUCT-LEVEL (target specific products by SKU prefix),
 *     keyed on quantity tiers.
 *   - Sales are COLLECTION-LEVEL (target the "discounts" collection), keyed on
 *     subtotal tiers (or a single flat tier).
 *   - BOTH are Shopify "product discounts", so Shopify applies only the SINGLE
 *     HIGHEST one per item — volume and sale never stack into a bigger number; the
 *     customer just gets the better of the two on each product. This is intentional.
 *   - Every managed discount sets combinesWith = {order, product, shipping: all true}
 *     so the Smile loyalty free-earrings reward (an order/product discount) and the
 *     free-gift twin (not discount-engine based at all) keep working alongside.
 *
 * Tiered discounts need one DiscountAutomaticNode PER TIER in Shopify; we store all
 * the tier node ids on one registry row. Per-tier node title is "<pct>% <name>".
 *
 * Sales additionally write store metafields the theme reads (sale banner / modal /
 * tag copy + dates). Volume discounts write a per-product metafield for PDP display.
 *
 * Dates are interpreted in Eastern Time. A sale's last day is inclusive: a sale
 * ending "2026-06-30" stays live until 3am ET on 2026-07-01 (matches the prior script).
 */

require('dotenv').config();
const { shopifyGraphQL } = require('../customer-service/lib/shopify');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { createTwin, enableOffer, disableOffer, getStatus } = require('./freeOffer');

const REGISTRY_TABLE = 'managed_discounts';
const SALE_COLLECTION_HANDLE = 'discounts';
const COMBINES_WITH = { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true };
const VOLUME_METAFIELD_KEY = 'volume_discount_text';
const SALE_METAFIELD_KEYS = [
  'sale_text', 'sale_tag_text', 'sale_heading_modal', 'sale_body_modal',
  'sale_announcement_text', 'sale_start_date', 'sale_end_date',
];

// ---------------------------------------------------------------------------
// Tier parsing + dates
// ---------------------------------------------------------------------------

/**
 * Parse "3+@10%,5+@15%" or "$100+@15%,$200+@20%" or "10%" → [{threshold, percentage}].
 * threshold is the quantity (volume) or subtotal (sale) floor; a bare "10%" → threshold 0.
 */
function parseTiers(input) {
  if (input == null) return null;
  const str = String(input).trim();
  if (!str) return null;
  const tiers = [];
  for (const part of str.split(',')) {
    const p = part.trim();
    const tier = p.match(/\$?(\d+(?:\.\d+)?)\+@(\d+(?:\.\d+)?)%/); // "3+@10%" / "$100+@15%"
    const bare = p.match(/^(\d+(?:\.\d+)?)%$/);                    // bare "10%" → threshold 0
    if (tier) tiers.push({ threshold: parseFloat(tier[1]), percentage: parseFloat(tier[2]) });
    else if (bare) tiers.push({ threshold: 0, percentage: parseFloat(bare[1]) });
  }
  if (tiers.length === 0) return null;
  return tiers.sort((a, b) => a.threshold - b.threshold);
}

/** Offset (ms) of America/New_York at a given instant. */
function etOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

/** Wall-clock Y-M-D + hour/min in Eastern Time → UTC ISO string (DST-aware). */
function etToUtcISO(year, month, day, hour = 0, minute = 0) {
  let ts = Date.UTC(year, month - 1, day, hour, minute);
  ts -= etOffsetMs(new Date(ts));
  // Re-check once in case the guess landed on the other side of a DST boundary.
  const off2 = etOffsetMs(new Date(ts));
  const ts2 = Date.UTC(year, month - 1, day, hour, minute) - off2;
  return new Date(ts2).toISOString();
}

/** "2026-06-30" → { startsAt, endsAt } ISO. Start = midnight ET; end = 3am ET the day AFTER (inclusive last day). */
function resolveDates(startDate, endDate) {
  let startsAt = null;
  let endsAt = null;
  if (startDate) {
    const [y, m, d] = startDate.split('-').map(Number);
    startsAt = etToUtcISO(y, m, d, 0, 0);
  }
  if (endDate) {
    const [y, m, d] = endDate.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)); // day after, calendar-safe rollover
    endsAt = etToUtcISO(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 3, 0);
  }
  return { startsAt, endsAt };
}

// ---------------------------------------------------------------------------
// Shopify helpers
// ---------------------------------------------------------------------------

async function getShopId() {
  const data = await shopifyGraphQL('{ shop { id } }');
  return data.shop.id;
}

async function getCollectionIdByHandle(handle) {
  const data = await shopifyGraphQL(
    `query($q: String!) { collections(first: 1, query: $q) { nodes { id handle } } }`,
    { q: `handle:${handle}` }
  );
  const node = data.collections.nodes.find((n) => n.handle === handle) || data.collections.nodes[0];
  return node ? node.id : null;
}

/** All product gids that have at least one variant whose SKU starts with one of the prefixes. */
async function getProductGidsBySkuPrefixes(prefixes) {
  const wanted = prefixes.map((p) => p.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const found = new Set();
  let cursor = null;
  do {
    const data = await shopifyGraphQL(`
      query($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id variants(first: 100) { nodes { sku } } }
        }
      }
    `, { cursor });
    for (const product of data.products.nodes) {
      const hit = product.variants.nodes.some((v) => v.sku && wanted.some((w) => v.sku.startsWith(w)));
      if (hit) found.add(product.id);
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return [...found];
}

const NODE_ID = (numeric) => `gid://shopify/DiscountAutomaticNode/${numeric}`;
const stripNodeId = (gid) => gid.replace('gid://shopify/DiscountAutomaticNode/', '');

/** Create one DiscountAutomaticBasic node. Returns the numeric node id. */
async function createBasicDiscountNode({ title, percentage, minimum, items, startsAt, endsAt }) {
  const data = await shopifyGraphQL(`
    mutation($d: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicCreate(automaticBasicDiscount: $d) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }
  `, {
    d: {
      title,
      startsAt: startsAt || new Date().toISOString(),
      ...(endsAt && { endsAt }),
      minimumRequirement: minimum,
      customerGets: { value: { percentage: percentage / 100 }, items },
      combinesWith: COMBINES_WITH,
    },
  });
  return stripNodeId(data.discountAutomaticBasicCreate.automaticDiscountNode.id);
}

async function updateNodeEndsAt(numericId, endsAt) {
  await shopifyGraphQL(`
    mutation($id: ID!, $d: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }
  `, { id: NODE_ID(numericId), d: { endsAt } });
}

async function deleteNode(numericId) {
  // Tolerate already-deleted nodes so remove/end stay re-runnable after a partial failure.
  try {
    await shopifyGraphQL(`
      mutation($id: ID!) {
        discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } }
      }
    `, { id: NODE_ID(numericId) });
  } catch (err) {
    if (/not found|does not exist|doesn't exist/i.test(err.message)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Metafields (theme contract)
// ---------------------------------------------------------------------------

async function setProductMetafields(productGids, key, value, type = 'single_line_text_field') {
  if (productGids.length === 0) return;
  await shopifyGraphQL(`
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
    }
  `, { metafields: productGids.map((id) => ({ ownerId: id, namespace: 'custom', key, type, value })) });
}

async function removeProductMetafields(productGids, key) {
  for (const gid of productGids) {
    const data = await shopifyGraphQL(
      `query($id: ID!) { product(id: $id) { metafield(namespace: "custom", key: "${key}") { id } } }`,
      { id: gid }
    );
    const mf = data.product && data.product.metafield;
    if (mf) {
      await shopifyGraphQL(`
        mutation($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } } }
      `, { metafields: [{ ownerId: gid, namespace: 'custom', key }] });
    }
  }
}

// ---- Sale store-metafield copy construction (ported from manage-discounts.js) ----

function formatDateReadable(ymd) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = ymd.split('-').map(Number);
  return `${months[m - 1]} ${d}, ${y}`;
}

// ---- Free-gift copy clauses (woven into sale text when a gift is attached) ----
// Threshold always reads "$<n> USD" so customers aren't left guessing the currency
// (RUBIES sells in many geos and converting is a pain — Jamie, 2026-06-19).

/** Full-sentence gift clause for sale_text / modal, e.g. "free Pride merch on orders $125 USD+". */
function giftSentenceClause(giftText, minimum) {
  const text = giftText && String(giftText).trim();
  if (!text) return null;
  const min = Number(minimum) || 0;
  return min > 0 ? `${text} on orders $${min} USD+` : `${text} with every order`;
}

/** Compact gift clause for the announcement bar, e.g. "free Pride merch on $125 USD+". */
function giftShortClause(giftText, minimum) {
  const text = giftText && String(giftText).trim();
  if (!text) return null;
  const min = Number(minimum) || 0;
  return min > 0 ? `${text} on $${min} USD+` : text;
}

/**
 * Plain sale text from tiers, e.g. "Spend $100+, save 15%! ... Valid now until ...".
 * When `gift` (a full-sentence clause from giftSentenceClause) is passed, it's woven in:
 * inline it joins the last discount sentence with a comma ("...cart, plus <gift>!"); with
 * line breaks it sits on its own line ("Plus <gift>.").
 */
function constructSaleText(tiers, endDate, withLineBreaks = false, gift = null) {
  if (!tiers || tiers.length === 0) return '';
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const next = sorted[i + 1];
    if (sorted.length === 1) {
      parts.push(t.threshold === 0 ? `${t.percentage}% off your entire cart!` : `Spend $${t.threshold}+, save ${t.percentage}%!`);
    } else if (i === sorted.length - 1) {
      parts.push(`Spend $${t.threshold}+, save ${t.percentage}%!`);
    } else if (i === 0) {
      parts.push(`Spend up to $${next.threshold}, save ${t.percentage}%.`);
    } else {
      parts.push(`Spend between $${t.threshold}-$${next.threshold}, save ${t.percentage}%.`);
    }
  }
  if (gift) {
    if (withLineBreaks) parts.push(`Plus ${gift}.`);
    else parts[parts.length - 1] = parts[parts.length - 1].replace(/!$/, `, plus ${gift}!`);
  }
  if (endDate) parts.push(`Valid through ${formatDateReadable(endDate)} (Eastern Time).`);
  parts.push('Discount applied automatically in the cart, no code needed.');
  return parts.join(withLineBreaks ? '\n' : ' ');
}

function convertToRichText(plainText) {
  if (!plainText) return JSON.stringify({});
  const lines = plainText.split('\n').filter((l) => l.trim());
  return JSON.stringify({
    type: 'root',
    children: lines.map((line) => {
      const trimmed = line.trim();
      const children = [];
      const re = /(\d+%|\$\d+ USD)/g; // bold the percentage and the "$N USD" gift threshold
      let last = 0; let m;
      while ((m = re.exec(trimmed)) !== null) {
        if (m.index > last) children.push({ type: 'text', value: trimmed.slice(last, m.index) });
        children.push({ type: 'text', value: m[1], bold: true });
        last = m.index + m[0].length;
      }
      if (last < trimmed.length) children.push({ type: 'text', value: trimmed.slice(last) });
      if (children.length === 0) children.push({ type: 'text', value: trimmed });
      return { type: 'paragraph', children };
    }),
  });
}

async function setSaleMetafields({ name, tiers, startDate, endDate, freeGiftText, freeGiftMinimum }) {
  const shopId = await getShopId();
  const highest = Math.max(...tiers.map((t) => t.percentage));
  const flat = tiers.length === 1 && tiers[0].threshold === 0;
  // Gift clauses (null when no gift) — woven into every customer-facing surface except the modal heading.
  const longClause = giftSentenceClause(freeGiftText, freeGiftMinimum);
  const shortClause = giftShortClause(freeGiftText, freeGiftMinimum);
  const tagBase = flat ? `${highest}% off` : `Up to ${highest}% off`;
  const annBase = flat ? `${name} - ${highest}% off Sitewide` : `${name} - Up to ${highest}% off Sitewide`;
  const mf = [
    { key: 'sale_text', type: 'single_line_text_field', value: constructSaleText(tiers, endDate, false, longClause) },
    { key: 'sale_tag_text', type: 'single_line_text_field', value: longClause ? `${tagBase} + ${String(freeGiftText).trim()}` : `${tagBase} ${name}` },
    { key: 'sale_heading_modal', type: 'single_line_text_field', value: `${name} Offer!` },
    { key: 'sale_body_modal', type: 'rich_text_field', value: convertToRichText(constructSaleText(tiers, endDate, true, longClause)) },
    { key: 'sale_announcement_text', type: 'single_line_text_field', value: shortClause ? `${annBase} + ${shortClause}` : annBase },
  ];
  if (startDate) mf.push({ key: 'sale_start_date', type: 'date', value: startDate });
  if (endDate) mf.push({ key: 'sale_end_date', type: 'date', value: endDate });
  await shopifyGraphQL(`
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message } }
    }
  `, { metafields: mf.map((m) => ({ ownerId: shopId, namespace: 'custom', ...m })) });
}

async function clearSaleMetafields() {
  const shopId = await getShopId();
  const data = await shopifyGraphQL('{ shop { metafields(first: 50, namespace: "custom") { nodes { key } } } }');
  const toDelete = data.shop.metafields.nodes
    .filter((m) => SALE_METAFIELD_KEYS.includes(m.key))
    .map((m) => ({ ownerId: shopId, namespace: 'custom', key: m.key }));
  if (toDelete.length > 0) {
    await shopifyGraphQL(`
      mutation($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
      }
    `, { metafields: toDelete });
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

async function getRegistryRow(name) {
  const { data, error } = await getSupabaseClient().from(REGISTRY_TABLE).select('*').eq('name', name).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertRegistryRow(row) {
  const { error } = await getSupabaseClient()
    .from(REGISTRY_TABLE)
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'name' });
  if (error) throw error;
}

async function listRegistry() {
  const { data, error } = await getSupabaseClient().from(REGISTRY_TABLE).select('*').order('kind').order('name');
  if (error) throw error;
  return data || [];
}

// ---------------------------------------------------------------------------
// Volume discounts
// ---------------------------------------------------------------------------

function volumeMetafieldText(tiers) {
  return [...tiers].sort((a, b) => a.threshold - b.threshold)
    .map((t) => `<b>${t.threshold}+</b> ${t.percentage}% off`).join(', ');
}

async function addVolumeDiscount({ name, skuPrefixes, tiers, startDate, endDate }, log = () => {}) {
  const parsed = Array.isArray(tiers) ? tiers : parseTiers(tiers);
  if (!parsed) throw new Error(`Could not parse tiers: ${tiers}`);
  const prefixes = Array.isArray(skuPrefixes) ? skuPrefixes : String(skuPrefixes).split(',').map((s) => s.trim());
  const existing = await getRegistryRow(name);
  if (existing) throw new Error(`"${name}" already exists — use update to change it, or remove first.`);

  const productGids = await getProductGidsBySkuPrefixes(prefixes);
  if (productGids.length === 0) throw new Error(`No products found for SKU prefix(es): ${prefixes.join(', ')}`);
  log(`Matched ${productGids.length} product(s) for ${prefixes.join(', ')}`);

  const { startsAt, endsAt } = resolveDates(startDate, endDate);
  const items = { products: { productsToAdd: productGids } };
  const nodeIds = [];
  for (const t of parsed) {
    const id = await createBasicDiscountNode({
      title: `${t.percentage}% ${name}`,
      percentage: t.percentage,
      minimum: { quantity: { greaterThanOrEqualToQuantity: String(t.threshold) } },
      items, startsAt, endsAt,
    });
    nodeIds.push(id);
    log(`✓ ${t.percentage}% for ${t.threshold}+ items → node ${id}`);
  }
  await setProductMetafields(productGids, VOLUME_METAFIELD_KEY, volumeMetafieldText(parsed));
  await upsertRegistryRow({
    kind: 'volume', name, sku_prefixes: prefixes, collection_handle: null,
    tiers: parsed, shopify_node_ids: nodeIds, status: 'active',
    starts_at: startsAt, ends_at: endsAt,
  });
  log(`✓ Volume discount "${name}" created (${parsed.length} tier(s)) + PDP metafield set.`);
}

async function removeVolumeDiscount(name, log = () => {}) {
  const row = await getRegistryRow(name);
  if (!row || row.kind !== 'volume') throw new Error(`No managed volume discount named "${name}".`);
  for (const id of row.shopify_node_ids) { await deleteNode(id); log(`✓ Deleted node ${id}`); }
  const productGids = await getProductGidsBySkuPrefixes(row.sku_prefixes);
  await removeProductMetafields(productGids, VOLUME_METAFIELD_KEY);
  const { error } = await getSupabaseClient().from(REGISTRY_TABLE).delete().eq('name', name);
  if (error) throw error;
  log(`✓ Removed volume discount "${name}".`);
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

async function startSale({ name, tiers, collectionHandle, startDate, endDate, freeGiftHandle, freeGiftMinimum, freeGiftText }, log = () => {}) {
  const parsed = Array.isArray(tiers) ? tiers : parseTiers(tiers);
  if (!parsed) throw new Error(`Could not parse tiers: ${tiers}`);
  const existing = await getRegistryRow(name);
  if (existing && existing.status === 'active') throw new Error(`Sale "${name}" is already active — use extend_sale or end_sale.`);

  const handle = (collectionHandle || SALE_COLLECTION_HANDLE).trim();
  const collectionId = await getCollectionIdByHandle(handle);
  if (!collectionId) throw new Error(`Collection not found for handle: ${handle}`);

  const { startsAt, endsAt } = resolveDates(startDate, endDate);
  const items = { collections: { add: [collectionId] } };
  const nodeIds = [];
  for (const t of parsed) {
    const minSubtotal = t.threshold === 0 ? '0.01' : String(t.threshold); // Shopify requires > 0
    const id = await createBasicDiscountNode({
      title: `${t.percentage}% ${name}`,
      percentage: t.percentage,
      minimum: { subtotal: { greaterThanOrEqualToSubtotal: minSubtotal } },
      items, startsAt, endsAt,
    });
    nodeIds.push(id);
    log(`✓ ${t.percentage}% for $${t.threshold}+ spend → node ${id}`);
  }

  // Gift copy is only woven in when a gift is actually attached to this sale.
  const giftText = freeGiftHandle ? (freeGiftText || null) : null;
  await setSaleMetafields({ name, tiers: parsed, startDate, endDate, freeGiftText: giftText, freeGiftMinimum });
  log('✓ Sale store metafields set (theme banner / modal / tag).');

  if (freeGiftHandle) {
    if (freeGiftMinimum == null) throw new Error('freeGiftMinimum is required when attaching a free gift (pass 0 for every order).');
    await createTwin(freeGiftHandle, log);
    await enableOffer({ minimum: String(freeGiftMinimum), start: startDate, end: endDate }, log);
    log(`✓ Free gift attached (${freeGiftHandle}, min $${freeGiftMinimum}${giftText ? `, "${giftText}"` : ''}).`);
  }

  await upsertRegistryRow({
    kind: 'sale', name, sku_prefixes: [], collection_handle: handle,
    tiers: parsed, shopify_node_ids: nodeIds, free_gift_handle: freeGiftHandle || null,
    free_gift_text: giftText, free_gift_minimum: freeGiftHandle ? (freeGiftMinimum ?? null) : null,
    status: 'active', starts_at: startsAt, ends_at: endsAt,
  });
  log(`✓ Sale "${name}" started: ${startDate || 'now'} → ${endDate || 'no end'}.`);
}

async function extendSale(name, newEndDate, log = () => {}) {
  const row = await getRegistryRow(name);
  if (!row || row.kind !== 'sale') throw new Error(`No managed sale named "${name}".`);
  const { endsAt } = resolveDates(null, newEndDate);
  for (const id of row.shopify_node_ids) { await updateNodeEndsAt(id, endsAt); log(`✓ Node ${id} → ends ${newEndDate}`); }
  // Resolve the gift minimum whenever we have gift copy OR a tool-managed gift handle
  // (registry first, fall back to the live offer metafield) — don't reset it to 0.
  let giftMin = row.free_gift_minimum;
  if (giftMin == null && (row.free_gift_handle || row.free_gift_text)) {
    const { metafields } = await getStatus();
    giftMin = metafields.free_gift_offer_minimum != null ? metafields.free_gift_offer_minimum : 0;
  }
  // Only re-extend the actual gift OFFER window when the tool manages the gift (has a handle).
  if (row.free_gift_handle) {
    const giftStart = row.starts_at ? row.starts_at.slice(0, 10) : newEndDate;
    await enableOffer({ minimum: String(giftMin), start: giftStart, end: newEndDate }, log);
  }
  // Re-render copy from the stored gift TEXT (independent of handle) so the gift mention
  // survives the extend even when the gift was set up out-of-band.
  await setSaleMetafields({
    name, tiers: row.tiers, startDate: row.starts_at ? row.starts_at.slice(0, 10) : null, endDate: newEndDate,
    freeGiftText: row.free_gift_text, freeGiftMinimum: giftMin,
  });
  await upsertRegistryRow({ ...row, status: 'active', ends_at: endsAt });
  log(`✓ Sale "${name}" extended to ${newEndDate}.`);
}

/** Current live sale dates from the store metafields (authoritative YYYY-MM-DD, no ET reconstruction). */
async function getLiveSaleDates() {
  const data = await shopifyGraphQL('{ shop { metafields(first: 50, namespace: "custom") { nodes { key value } } } }');
  const m = Object.fromEntries(data.shop.metafields.nodes.map((n) => [n.key, n.value]));
  return {
    startDate: m.sale_start_date || null,
    endDate: m.sale_end_date || null,
    giftMinimum: m.free_gift_offer_minimum != null ? Number(m.free_gift_offer_minimum) : null,
  };
}

/**
 * Re-render the live sale's copy to include (or change) a free-gift description, without
 * tearing down or recreating the discount. Used when a gift was attached out-of-band and the
 * sale copy doesn't mention it yet, or to tweak the gift wording mid-sale.
 * Minimum: explicit arg → registry → live free_gift_offer_minimum → 0.
 */
async function updateSaleGift(name, { freeGiftText, freeGiftMinimum } = {}, log = () => {}) {
  const row = await getRegistryRow(name);
  if (!row || row.kind !== 'sale') throw new Error(`No managed sale named "${name}".`);
  if (row.status !== 'active') throw new Error(`Sale "${name}" is not active — nothing live to re-render.`);
  const text = freeGiftText != null ? String(freeGiftText).trim() : (row.free_gift_text || null);
  if (!text) throw new Error('No free_gift_text provided (and none stored). Pass the gift description to weave in.');

  const live = await getLiveSaleDates();
  const min = freeGiftMinimum != null ? Number(freeGiftMinimum)
    : (row.free_gift_minimum != null ? Number(row.free_gift_minimum)
      : (live.giftMinimum != null ? live.giftMinimum : 0));
  const startDate = live.startDate || (row.starts_at ? row.starts_at.slice(0, 10) : null);
  const endDate = live.endDate;

  await setSaleMetafields({ name, tiers: row.tiers, startDate, endDate, freeGiftText: text, freeGiftMinimum: min });
  await upsertRegistryRow({
    ...row,
    free_gift_handle: row.free_gift_handle || null,
    free_gift_text: text, free_gift_minimum: min,
  });
  log(`✓ Re-rendered "${name}" sale copy with free gift "${text}"${min > 0 ? ` ($${min} USD+)` : ' (every order)'}.`);
}

async function endSale(name, log = () => {}) {
  const row = await getRegistryRow(name);
  if (!row || row.kind !== 'sale') throw new Error(`No managed sale named "${name}".`);
  for (const id of row.shopify_node_ids) { await deleteNode(id); log(`✓ Deleted node ${id}`); }
  await clearSaleMetafields();
  log('✓ Cleared sale store metafields.');
  if (row.free_gift_handle) { await disableOffer(log); log('✓ Disabled attached free gift.'); }
  await upsertRegistryRow({ ...row, status: 'ended', ends_at: new Date().toISOString() });
  log(`✓ Sale "${name}" ended.`);
}

// ---------------------------------------------------------------------------
// Audit (fast: automatic discounts vs registry; NOT the 16k-code scan)
// ---------------------------------------------------------------------------

async function auditAutomatic() {
  const data = await shopifyGraphQL(`
    query {
      automaticDiscountNodes(first: 100) {
        nodes {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title status startsAt endsAt
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
            }
            ... on DiscountAutomaticBxgy { title status endsAt combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          }
        }
      }
    }
  `);
  const now = new Date();
  const live = data.automaticDiscountNodes.nodes.map((n) => ({
    id: stripNodeId(n.id),
    title: n.automaticDiscount.title,
    status: n.automaticDiscount.status,
    ends: n.automaticDiscount.endsAt,
    ended: n.automaticDiscount.endsAt ? new Date(n.automaticDiscount.endsAt) < now : false,
    combo: n.automaticDiscount.combinesWith,
  }));
  const registry = await listRegistry();
  const registryNodeIds = new Set(registry.flatMap((r) => r.shopify_node_ids));

  const flags = [];
  // Live active automatic discount not tracked in the registry.
  for (const d of live) {
    if (d.status === 'ACTIVE' && !d.ended && !registryNodeIds.has(d.id)) {
      flags.push(`ORPHAN (active, not in registry): "${d.title}" id=${d.id}`);
    }
    if (d.status === 'ACTIVE' && !d.ended && d.combo && !(d.combo.orderDiscounts && d.combo.productDiscounts && d.combo.shippingDiscounts)) {
      flags.push(`combinesWith DRIFT: "${d.title}" — not all-true id=${d.id}`);
    }
    if (d.ended && d.status === 'ACTIVE') flags.push(`END-PASSED but ACTIVE: "${d.title}" ends=${d.ends} id=${d.id}`);
  }
  // Registry rows whose Shopify nodes have vanished.
  const liveIds = new Set(live.map((d) => d.id));
  for (const r of registry) {
    if (r.status === 'active') {
      const missing = r.shopify_node_ids.filter((id) => !liveIds.has(id));
      if (missing.length) flags.push(`MISSING NODES for "${r.name}": ${missing.join(', ')} (registry says active)`);
    }
  }
  return { live, registry, flags };
}

module.exports = {
  // engine ops
  addVolumeDiscount, removeVolumeDiscount,
  startSale, extendSale, endSale, updateSaleGift,
  listRegistry, auditAutomatic, getRegistryRow,
  // pure helpers (tested)
  parseTiers, resolveDates, etToUtcISO, constructSaleText, convertToRichText,
  volumeMetafieldText, giftSentenceClause, giftShortClause,
  // constants
  SALE_COLLECTION_HANDLE, COMBINES_WITH, SALE_METAFIELD_KEYS, VOLUME_METAFIELD_KEY,
};
