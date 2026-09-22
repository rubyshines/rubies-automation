/**
 * Tool: set_product_prices — update retail prices and compare-at prices in
 * Shopify, and sync retail prices to Supabase.
 *
 * Reuses the shared resolveLineItems module (same one used by exchange /
 * refund / wholesale / create-order tools) to resolve each input item to an
 * anchor variant via variant_id / sku / query. From the anchor, we expand to
 * the full product and filter by optional sizes/colors (omit = all variants).
 *
 * RUBIES products are priced the same across colors, so the usual call is
 * just { sku | query, price } and every variant of that product gets updated.
 *
 * Each item may set the retail `price`, the `compare_at_price` (the
 * struck-through "was" price the theme uses for its "You save" line), or
 * `clear_compare_at`. The Supabase mirror carries retail price only, so the
 * current compare-at is read live from Shopify at preview time, never from
 * the cache. A compare-at below the resulting price is refused: Shopify
 * allows it, but it is exactly the state that makes the cart understate
 * every discount.
 *
 * The daily syncProducts.js job independently reconciles Supabase against
 * Shopify (source of truth) and will catch any retail-price drift.
 */

const crypto = require('crypto');
const { getProducts, loadFromSupabase } = require('../productCache');
const { updateVariantPrices, fetchVariantPricing } = require('../shopify');
const { getVariantSize, getVariantColor, normalizeSizeLower } = require('../sizeUtils');
const { resolveLineItems } = require('../resolveLineItems');
const { getSupabaseClient } = require('../../../shared/supabaseClient');

// Server-side staging store for two-phase confirm flow
// (same pattern as editOrder's pendingEdits)
const pendingPriceChanges = new Map();

function normalizeColor(c) {
  return String(c || '').toLowerCase().trim();
}

function titleCase(s) {
  if (!s) return '';
  return String(s).split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function formatPrice(p) {
  return `$${Number(p).toFixed(2)}`;
}

function formatCompareAt(p) {
  return p === null || p === undefined ? 'none' : formatPrice(p);
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function isMoney(n) {
  return typeof n === 'number' && isFinite(n) && n >= 0;
}

/**
 * Describe the scope of a variant group in natural language.
 * Compares the matched group to the full product catalog to figure out
 * whether this is "all variants", "all size L", "black variants", etc.
 */
function describeScope(product, groupVariants) {
  const all = product.variants;
  const groupArr = [...groupVariants];

  if (groupArr.length === 1) {
    const v = groupArr[0];
    const size = getVariantSize(v);
    const color = getVariantColor(v);
    const parts = [];
    if (size) parts.push(`size ${size.toUpperCase()}`);
    if (color) parts.push(titleCase(color));
    return parts.length ? parts.join(' ') : v.title;
  }

  if (groupArr.length === all.length) {
    return 'all variants';
  }

  const groupSizes = new Set(groupArr.map(v => getVariantSize(v)).filter(Boolean));
  const groupColors = new Set(groupArr.map(v => getVariantColor(v)).filter(Boolean));
  const allSizes = new Set(all.map(v => getVariantSize(v)).filter(Boolean));
  const allColors = new Set(all.map(v => getVariantColor(v)).filter(Boolean));

  // Describe size coverage
  let sizePart;
  if (groupSizes.size === allSizes.size) {
    sizePart = 'all sizes';
  } else if (groupSizes.size === 1) {
    sizePart = `size ${[...groupSizes][0].toUpperCase()}`;
  } else {
    sizePart = `sizes ${[...groupSizes].map(s => s.toUpperCase()).join(', ')}`;
  }

  // Describe color coverage
  let colorPart;
  if (groupColors.size === allColors.size) {
    colorPart = 'all colors';
  } else if (groupColors.size === 1) {
    colorPart = titleCase([...groupColors][0]);
  } else {
    colorPart = [...groupColors].map(titleCase).join(', ');
  }

  return `${sizePart} · ${colorPart}`;
}

function formatVariantLine(v) {
  const size = getVariantSize(v);
  const color = getVariantColor(v);
  const desc = [color ? titleCase(color) : null, size ? size.toUpperCase() : null].filter(Boolean).join(' / ');
  return `${v.sku || v.id}${desc ? ` — ${desc}` : ''}`;
}

function findProductByVariantId(variantId) {
  for (const product of getProducts()) {
    if (product.variants.some(v => v.id === variantId)) return product;
  }
  return null;
}

/**
 * Filter a product's variants by optional sizes/colors.
 * Empty/missing filters = include all.
 */
function filterVariants(product, sizes, colors) {
  const sizeSet = (sizes && sizes.length)
    ? new Set(sizes.map(s => normalizeSizeLower(s)))
    : null;
  const colorSet = (colors && colors.length)
    ? new Set(colors.map(normalizeColor))
    : null;

  const matched = [];
  for (const v of product.variants) {
    if (sizeSet) {
      const vSize = getVariantSize(v);
      if (!vSize || !sizeSet.has(vSize)) continue;
    }
    if (colorSet) {
      const vColor = getVariantColor(v);
      if (!vColor || !colorSet.has(vColor)) continue;
    }
    matched.push(v);
  }
  return matched;
}

/**
 * Read one item's requested operations.
 * Returns { error } or { price?: number, compareAt?: number|null }
 *   compareAt === null  → clear the compare-at
 *   compareAt undefined → leave the compare-at alone
 */
function parseItemOps(item, i) {
  const hasPrice = item.price !== undefined && item.price !== null;
  const hasCompareAt = item.compare_at_price !== undefined && item.compare_at_price !== null;
  const clear = item.clear_compare_at === true;

  if (!hasPrice && !hasCompareAt && !clear) {
    return { error: `Item ${i + 1}: must provide at least one of price, compare_at_price, clear_compare_at.` };
  }
  if (hasCompareAt && clear) {
    return { error: `Item ${i + 1}: compare_at_price and clear_compare_at cannot both be set.` };
  }
  if (hasPrice && !isMoney(item.price)) {
    return { error: `Item ${i + 1}: invalid price "${item.price}".` };
  }
  if (hasCompareAt && !isMoney(item.compare_at_price)) {
    return { error: `Item ${i + 1}: invalid compare_at_price "${item.compare_at_price}".` };
  }

  const ops = {};
  if (hasPrice) ops.price = roundMoney(item.price);
  if (hasCompareAt) ops.compareAt = roundMoney(item.compare_at_price);
  if (clear) ops.compareAt = null;
  return ops;
}

function currentCompareAt(variant) {
  if (variant.compareAtPrice === null || variant.compareAtPrice === undefined || variant.compareAtPrice === '') return null;
  return parseFloat(variant.compareAtPrice);
}

/**
 * What a group's operations do to one variant, given its current values.
 */
function planChange(variant, group) {
  const curPrice = parseFloat(variant.price);
  const curCompareAt = currentCompareAt(variant);
  const newPrice = group.newPrice !== undefined ? group.newPrice : curPrice;
  const newCompareAt = group.newCompareAt !== undefined ? group.newCompareAt : curCompareAt;
  const priceChanged = group.newPrice !== undefined && newPrice !== curPrice;
  const compareAtChanged = group.newCompareAt !== undefined && newCompareAt !== curCompareAt;
  return {
    curPrice, curCompareAt, newPrice, newCompareAt,
    priceChanged, compareAtChanged,
    changed: priceChanged || compareAtChanged,
  };
}

/**
 * Overlay live Shopify price + compare-at onto the cached variants of a
 * product. The cache mirrors Supabase, which has no compare-at column.
 * Returns an error string, or null on success.
 */
async function overlayLivePricing(product) {
  let live;
  try {
    live = await fetchVariantPricing(product.id);
  } catch (err) {
    return `could not read live prices for "${product.title}" from Shopify: ${err.message}`;
  }
  if (!live) return `"${product.title}" (${product.id}) was not found in Shopify.`;
  const byId = new Map(live.variants.map(v => [v.id, v]));
  for (const v of product.variants) {
    const l = byId.get(v.id);
    if (!l) continue;
    v.price = String(l.price);
    v.compareAtPrice = l.compareAtPrice === null || l.compareAtPrice === undefined ? null : String(l.compareAtPrice);
  }
  return null;
}

async function syncPricesToSupabase(variantUpdates) {
  // variantUpdates: [{ variant, productTitle, group }] — only retail-price
  // changes reach Supabase; the mirror has no compare-at column.
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const historyRows = [];
  let updated = 0;

  for (const u of variantUpdates) {
    const plan = planChange(u.variant, u.group);
    if (!plan.priceChanged) continue;

    const { error } = await supabase
      .from('product_variants')
      .update({ price: plan.newPrice })
      .eq('shopify_variant_id', u.variant.id);
    if (error) throw new Error(`Supabase update failed for ${u.variant.id}: ${error.message}`);
    updated++;

    historyRows.push({
      variant_id: u.variant.id,
      sku: u.variant.sku || null,
      product_title: u.productTitle,
      variant_title: u.variant.title,
      price: plan.newPrice,
      previous_price: plan.curPrice,
      changed_at: nowIso,
    });
  }

  if (historyRows.length) {
    const { error } = await supabase.from('price_history').insert(historyRows);
    if (error) throw new Error(`price_history insert failed: ${error.message}`);
  }

  return { updated, logged: historyRows.length };
}

/** Keep the in-memory cache consistent after a committed change. */
function applyToCache(variant, group) {
  const plan = planChange(variant, group);
  if (plan.priceChanged) variant.price = String(plan.newPrice);
  if (plan.compareAtChanged) variant.compareAtPrice = plan.newCompareAt === null ? null : String(plan.newCompareAt);
}

function describeOps(group) {
  const parts = [];
  if (group.newPrice !== undefined) parts.push(`price ${formatPrice(group.newPrice)}`);
  if (group.newCompareAt === null) parts.push('compare-at cleared');
  else if (group.newCompareAt !== undefined) parts.push(`compare-at ${formatPrice(group.newCompareAt)}`);
  return parts.join(', ');
}

const tools = [
  {
    name: 'set_product_prices',
    description: 'Set the retail price and/or the compare-at ("was") price of RUBIES products in Shopify; retail prices also sync to Supabase. Each item takes price, compare_at_price, or clear_compare_at (at least one). Two-phase flow: (1) call with items to preview + receive a confirmation_token, (2) call again with that token to commit. The current compare-at is read live from Shopify for the preview. A compare-at below the resulting price is refused (it makes the cart understate every discount); equal is fine (no strike-through shown) and above is a real sale. Scope rules: passing a precise SKU or variant_id targets ONLY that single variant. Passing a fuzzy query targets ALL variants of the resolved product (RUBIES products are typically one price across colors/sizes). Passing sizes or colors always expands the scope to the product filtered by those lists, regardless of how the anchor was identified. Uses the same lookup as exchange/refund/wholesale tools, including the segment-wise SKU fallback (e.g. "RUBY-BLK-4X" resolves to "RUBY-BLK-4XL" via size aliases).',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'List of price updates. Required on the preview call. Ignored when confirmation_token is provided.',
          items: {
            type: 'object',
            properties: {
              variant_id: {
                type: 'string',
                description: 'Shopify variant GID or numeric id. By default targets ONLY that single variant. Pass sizes/colors to expand to other variants of the same product.',
              },
              sku: {
                type: 'string',
                description: 'Specific variant SKU (e.g. "RUBY-BLK-4XL"). By default targets ONLY that single variant. Pass sizes/colors to expand to other variants of the same product.',
              },
              query: {
                type: 'string',
                description: 'Fuzzy product search (e.g. "ava tucking bikini"). Targets ALL variants of the resolved product (use sizes/colors to narrow). Use query — not sku — when you want to update a whole product.',
              },
              price: {
                type: 'number',
                description: 'New retail price (e.g. 29.99). Omit to leave the retail price alone.',
              },
              compare_at_price: {
                type: 'number',
                description: 'New compare-at ("was") price. Must be at least the resulting retail price. Omit to leave it alone. Cannot be combined with clear_compare_at.',
              },
              clear_compare_at: {
                type: 'boolean',
                description: 'true removes the compare-at price entirely. Cannot be combined with compare_at_price.',
              },
              sizes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional size filter (e.g. ["S","M","L"]). Omit to apply to all sizes.',
              },
              colors: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional color filter (e.g. ["black","navy"]). Omit to apply to all colors (usual case).',
              },
            },
          },
        },
        confirmation_token: {
          type: 'string',
          description: 'Token returned from a previous preview call. When provided, commits the staged change to Shopify + Supabase. Omit on the first call to preview.',
        },
      },
    },
    handler: async ({ items, confirmation_token }) => {
      // ----- Phase 2: commit a staged change -----
      if (confirmation_token) {
        const staged = pendingPriceChanges.get(confirmation_token);
        if (!staged) {
          return {
            content: [{
              type: 'text',
              text: `Unknown or expired confirmation_token "${confirmation_token}". Re-run the preview to get a fresh token.`,
            }],
          };
        }

        const { productGroups, allUpdates, warnings } = staged;

        // Re-filter to only those still needing change (cache may have shifted)
        const changedUpdates = allUpdates.filter(u => planChange(u.variant, u.group).changed);
        if (!changedUpdates.length) {
          pendingPriceChanges.delete(confirmation_token);
          return {
            content: [{ type: 'text', text: 'All targeted variants are already at the staged prices — nothing to commit.' }],
          };
        }

        const shopifyErrors = [];
        const committedGroups = [];
        for (const group of productGroups.values()) {
          const { product, variants } = group;
          const payload = [];
          for (const v of variants.values()) {
            const plan = planChange(v, group);
            if (!plan.changed) continue;
            const entry = { id: v.id };
            if (plan.priceChanged) entry.price = plan.newPrice;
            if (plan.compareAtChanged) entry.compareAtPrice = plan.newCompareAt;
            payload.push(entry);
          }
          if (!payload.length) continue;
          try {
            await updateVariantPrices(product.id, payload);
            committedGroups.push({ group, count: payload.length });
          } catch (err) {
            shopifyErrors.push(`${product.title}: ${err.message}`);
          }
        }

        if (!committedGroups.length) {
          return {
            content: [{ type: 'text', text: `Shopify update failed for all products:\n${shopifyErrors.join('\n')}` }],
          };
        }

        const committedGroupSet = new Set(committedGroups.map(c => c.group));
        const syncUpdates = allUpdates.filter(u => committedGroupSet.has(u.group));

        let syncResult;
        try {
          syncResult = await syncPricesToSupabase(syncUpdates);
        } catch (err) {
          pendingPriceChanges.delete(confirmation_token);
          return {
            content: [{
              type: 'text',
              text: `Shopify updated OK but Supabase sync failed: ${err.message}\nThe next daily syncProducts run will reconcile.`,
            }],
          };
        }

        // Count what changed, then bring the cache in line
        let priceCount = 0;
        let compareAtCount = 0;
        for (const u of syncUpdates) {
          const plan = planChange(u.variant, u.group);
          if (plan.priceChanged) priceCount++;
          if (plan.compareAtChanged) compareAtCount++;
        }
        for (const u of syncUpdates) applyToCache(u.variant, u.group);

        pendingPriceChanges.delete(confirmation_token);

        // Natural-language commit summary, grouped per product
        const groupBlocks = [];
        for (const { group, count } of committedGroups) {
          const { product, variants } = group;
          const scope = describeScope(product, [...variants.values()]);
          groupBlocks.push([
            `✅ **${product.title}** — ${count} variant${count === 1 ? '' : 's'}: ${describeOps(group)}`,
            `   Scope: ${scope}`,
          ].join('\n'));
        }

        const errorBlock = [...shopifyErrors.map(e => `❌ Shopify error: ${e}`), ...warnings]
          .filter(Boolean).join('\n');

        const totalChanged = committedGroups.reduce((n, c) => n + c.count, 0);
        const commitText =
          `**Prices updated** — ${totalChanged} variant${totalChanged === 1 ? '' : 's'} changed ` +
          `(${priceCount} price, ${compareAtCount} compare-at).\n` +
          `Supabase synced: ${syncResult.updated} price${syncResult.updated === 1 ? '' : 's'}, ` +
          `${syncResult.logged} price_history entr${syncResult.logged === 1 ? 'y' : 'ies'} logged.\n\n` +
          groupBlocks.join('\n\n') +
          (errorBlock ? `\n\n${errorBlock}` : '');

        console.error('\n[set_product_prices] COMMITTED\n' + commitText + '\n');

        return {
          content: [{ type: 'text', text: commitText }],
        };
      }

      // ----- Phase 1: preview + stage -----
      if (!Array.isArray(items) || !items.length) {
        return { content: [{ type: 'text', text: 'items must be a non-empty array on the preview call.' }] };
      }

      // Ensure cache is loaded
      if (!getProducts().length) {
        await loadFromSupabase();
      }

      // Resolve each item to an anchor variant, then expand to its product.
      // We collect per-product update groups so productVariantsBulkUpdate can
      // be called once per Shopify product.
      const productGroups = new Map(); // key -> { product, newPrice?, newCompareAt?, variants: Map }
      const liveLoaded = new Set();    // product ids whose live pricing has been overlaid
      const errors = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const ops = parseItemOps(item, i);
        if (ops.error) {
          errors.push(ops.error);
          continue;
        }
        if (!item.variant_id && !item.sku && !item.query) {
          errors.push(`Item ${i + 1}: must provide variant_id, sku, or query.`);
          continue;
        }

        // Reuse the shared resolver. It expects an items array; we pass one.
        const resolved = await resolveLineItems([{
          variant_id: item.variant_id,
          sku: item.sku,
          query: item.query,
        }]);
        if (resolved.error) {
          errors.push(`Item ${i + 1}: ${resolved.error}`);
          continue;
        }

        const anchor = resolved[0];
        const product = findProductByVariantId(anchor.variantId);
        if (!product) {
          errors.push(`Item ${i + 1}: resolved variant ${anchor.variantId} but could not find its product in cache. Try reload_products.`);
          continue;
        }

        // Scope rule:
        //   - precise anchor (sku / variant_id) + no sizes/colors filter → single variant
        //   - fuzzy anchor (query) → full product, optionally filtered by sizes/colors
        //   - any anchor + sizes/colors provided → expand to product + filter
        const hasFilter = (item.sizes && item.sizes.length) || (item.colors && item.colors.length);
        const preciseAnchor = Boolean(item.sku || item.variant_id);

        let matched;
        if (preciseAnchor && !hasFilter) {
          const anchorVariant = product.variants.find(v => v.id === anchor.variantId);
          matched = anchorVariant ? [anchorVariant] : [];
        } else {
          matched = filterVariants(product, item.sizes, item.colors);
        }

        if (!matched.length) {
          const availSizes = [...new Set(product.variants.map(v => getVariantSize(v)).filter(Boolean))];
          const availColors = [...new Set(product.variants.map(v => getVariantColor(v)).filter(Boolean))];
          errors.push(
            `Item ${i + 1}: no variants on "${product.title}" matched.\n` +
            `  Available sizes: ${availSizes.join(', ') || '(none)'}\n` +
            `  Available colors: ${availColors.join(', ') || '(none)'}`
          );
          continue;
        }

        // Current price + compare-at come from Shopify, once per product.
        if (!liveLoaded.has(product.id)) {
          const liveErr = await overlayLivePricing(product);
          if (liveErr) {
            errors.push(`Item ${i + 1}: ${liveErr}`);
            continue;
          }
          liveLoaded.add(product.id);
        }

        const groupShape = { newPrice: ops.price, newCompareAt: ops.compareAt };

        // Refuse any variant that would end up with compare-at below price.
        const offending = matched.filter(v => {
          const plan = planChange(v, groupShape);
          return plan.newCompareAt !== null && plan.newCompareAt < plan.newPrice;
        });
        if (offending.length) {
          const sample = planChange(offending[0], groupShape);
          const fix = ops.compareAt === undefined
            ? `Add compare_at_price (at least ${formatPrice(sample.newPrice)}) or clear_compare_at: true to this item.`
            : `Set compare_at_price to at least ${formatPrice(sample.newPrice)}, or pass clear_compare_at: true.`;
          errors.push(
            `Item ${i + 1}: refused — compare-at ${formatPrice(sample.newCompareAt)} would sit below the price ` +
            `${formatPrice(sample.newPrice)} on ${offending.length} variant${offending.length === 1 ? '' : 's'} of ` +
            `"${product.title}" (e.g. ${formatVariantLine(offending[0])}). Shopify shows no strike-through for that, ` +
            `and the cart's "You save" line understates every discount on it. ${fix}`
          );
          continue;
        }

        // Merge into productGroups (a product referenced twice with different
        // filters/prices gets multiple entries — last write wins on overlap,
        // which mirrors Shopify's bulk update semantics).
        const key = `${product.id}::${ops.price ?? '-'}::${ops.compareAt === undefined ? '-' : (ops.compareAt === null ? 'clear' : ops.compareAt)}`;
        if (!productGroups.has(key)) {
          productGroups.set(key, { product, ...groupShape, variants: new Map() });
        }
        const group = productGroups.get(key);
        for (const v of matched) {
          group.variants.set(v.id, v);
        }
      }

      if (errors.length && !productGroups.size) {
        return { content: [{ type: 'text', text: `No updates applied.\n${errors.join('\n')}` }] };
      }

      // Build the flat update list for preview + history
      const allUpdates = [];
      for (const group of productGroups.values()) {
        for (const v of group.variants.values()) {
          allUpdates.push({ variant: v, productTitle: group.product.title, group });
        }
      }

      const changedUpdates = allUpdates.filter(u => planChange(u.variant, u.group).changed);

      if (!changedUpdates.length) {
        const errorBlock = errors.length ? `\n\nWarnings:\n${errors.join('\n')}` : '';
        return {
          content: [{
            type: 'text',
            text: `All targeted variants already at the requested prices — nothing to change.${errorBlock}`,
          }],
        };
      }

      // Stage the change and return a confirmation token
      const token = crypto.randomBytes(6).toString('hex');
      pendingPriceChanges.set(token, { productGroups, allUpdates, warnings: errors });

      // Build natural-language preview, one block per product/operation group.
      const groupBlocks = [];
      for (const group of productGroups.values()) {
        const { product, variants } = group;
        const plans = [...variants.values()].map(v => ({ v, plan: planChange(v, group) })).filter(x => x.plan.changed);
        if (!plans.length) continue;

        const changed = plans.map(x => x.v);
        const scope = describeScope(product, changed);
        const block = [
          `**${product.title}** — ${changed.length} variant${changed.length === 1 ? '' : 's'}`,
          `Scope: ${scope}`,
        ];

        const priceMoves = plans.filter(x => x.plan.priceChanged);
        if (priceMoves.length) {
          const from = [...new Set(priceMoves.map(x => x.plan.curPrice))].map(formatPrice).join(' / ');
          block.push(`Price: ${from} → ${formatPrice(group.newPrice)}`);
        }
        const compareMoves = plans.filter(x => x.plan.compareAtChanged);
        if (compareMoves.length) {
          const from = [...new Set(compareMoves.map(x => x.plan.curCompareAt))].map(formatCompareAt).join(' / ');
          const to = group.newCompareAt === null ? 'cleared' : formatPrice(group.newCompareAt);
          block.push(`Compare-at: ${from} → ${to}`);
        }

        // Show individual variant lines (truncate if > 5)
        const MAX_SHOWN = 5;
        const shown = changed.slice(0, MAX_SHOWN).map(v => `  • ${formatVariantLine(v)}`);
        block.push(...shown);
        if (changed.length > MAX_SHOWN) {
          block.push(`  …and ${changed.length - MAX_SHOWN} more`);
        }
        groupBlocks.push(block.join('\n'));
      }

      const totalVariants = changedUpdates.length;
      const header = `**About to update prices — Awaiting Confirmation**\n` +
        `Updating ${totalVariants} variant${totalVariants === 1 ? '' : 's'} across ${groupBlocks.length} product${groupBlocks.length === 1 ? '' : 's'}.`;

      const errorBlock = errors.length ? `\n\n⚠️ Warnings:\n${errors.join('\n')}` : '';

      const previewText =
        header + '\n\n' +
        groupBlocks.join('\n\n') +
        errorBlock +
        `\n\nTo commit, call set_product_prices again with confirmation_token="${token}".`;

      // Echo full preview to stderr so it appears in the MCP server log even
      // when the MCP UI truncates the tool response panel.
      console.error('\n[set_product_prices] PREVIEW\n' + previewText + '\n');

      return {
        content: [{ type: 'text', text: previewText }],
      };
    },
  },
];

module.exports = tools;
module.exports.filterVariants = filterVariants;
module.exports.findProductByVariantId = findProductByVariantId;
module.exports.parseItemOps = parseItemOps;
module.exports.planChange = planChange;
