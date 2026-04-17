/**
 * Tool: set_product_prices — update retail prices in Shopify + sync to Supabase.
 *
 * Reuses the shared resolveLineItems module (same one used by exchange /
 * refund / wholesale / create-order tools) to resolve each input item to an
 * anchor variant via variant_id / sku / query. From the anchor, we expand to
 * the full product and filter by optional sizes/colors (omit = all variants).
 *
 * RUBIES products are priced the same across colors, so the usual call is
 * just { sku | query, price } and every variant of that product gets updated.
 *
 * The daily syncProducts.js job independently reconciles Supabase against
 * Shopify (source of truth) and will catch any drift.
 */

const crypto = require('crypto');
const { getProducts, loadFromSupabase } = require('../productCache');
const { updateVariantPrices } = require('../shopify');
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

async function syncPricesToSupabase(variantUpdates) {
  // variantUpdates: [{ variant, productTitle, newPrice }]
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const historyRows = [];
  let updated = 0;

  for (const u of variantUpdates) {
    const oldPrice = parseFloat(u.variant.price);
    if (oldPrice === u.newPrice) continue;

    const { error } = await supabase
      .from('product_variants')
      .update({ price: u.newPrice })
      .eq('shopify_variant_id', u.variant.id);
    if (error) throw new Error(`Supabase update failed for ${u.variant.id}: ${error.message}`);
    updated++;

    historyRows.push({
      variant_id: u.variant.id,
      sku: u.variant.sku || null,
      product_title: u.productTitle,
      variant_title: u.variant.title,
      price: u.newPrice,
      previous_price: oldPrice,
      changed_at: nowIso,
    });

    // Keep in-memory cache consistent
    u.variant.price = String(u.newPrice);
  }

  if (historyRows.length) {
    const { error } = await supabase.from('price_history').insert(historyRows);
    if (error) throw new Error(`price_history insert failed: ${error.message}`);
  }

  return { updated, logged: historyRows.length };
}

const tools = [
  {
    name: 'set_product_prices',
    description: 'Set the retail price of RUBIES products in Shopify and sync to Supabase. Two-phase flow: (1) call with items to preview + receive a confirmation_token, (2) call again with that token to commit. Scope rules: passing a precise SKU or variant_id targets ONLY that single variant. Passing a fuzzy query targets ALL variants of the resolved product (RUBIES products are typically one price across colors/sizes). Passing sizes or colors always expands the scope to the product filtered by those lists, regardless of how the anchor was identified. Uses the same lookup as exchange/refund/wholesale tools, including the segment-wise SKU fallback (e.g. "RUBY-BLK-4X" resolves to "RUBY-BLK-4XL" via size aliases).',
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
                description: 'New retail price (e.g. 29.99).',
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
            required: ['price'],
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
        const changedUpdates = allUpdates.filter(u => parseFloat(u.variant.price) !== u.newPrice);
        if (!changedUpdates.length) {
          pendingPriceChanges.delete(confirmation_token);
          return {
            content: [{ type: 'text', text: 'All targeted variants are already at the staged prices — nothing to commit.' }],
          };
        }

        const shopifyErrors = [];
        for (const { product, newPrice, variants } of productGroups.values()) {
          const variantPrices = [...variants.values()]
            .filter(v => parseFloat(v.price) !== newPrice)
            .map(v => ({ id: v.id, price: newPrice }));
          if (!variantPrices.length) continue;
          try {
            await updateVariantPrices(product.id, variantPrices);
          } catch (err) {
            shopifyErrors.push(`${product.title}: ${err.message}`);
          }
        }

        if (shopifyErrors.length === productGroups.size) {
          return {
            content: [{ type: 'text', text: `Shopify update failed for all products:\n${shopifyErrors.join('\n')}` }],
          };
        }

        const syncUpdates = allUpdates.filter(u =>
          !shopifyErrors.some(e => e.startsWith(u.productTitle + ':'))
        );

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

        pendingPriceChanges.delete(confirmation_token);

        // Natural-language commit summary, grouped per product
        const groupBlocks = [];
        for (const { product, newPrice, variants } of productGroups.values()) {
          if (shopifyErrors.some(e => e.startsWith(product.title + ':'))) continue;
          const variantArr = [...variants.values()];
          if (!variantArr.length) continue;
          const scope = describeScope(product, variantArr);
          const block = [
            `✅ **${product.title}** — ${variantArr.length} variant${variantArr.length === 1 ? '' : 's'} now ${formatPrice(newPrice)}`,
            `   Scope: ${scope}`,
          ];
          groupBlocks.push(block.join('\n'));
        }

        const errorBlock = [...shopifyErrors.map(e => `❌ Shopify error: ${e}`), ...warnings]
          .filter(Boolean).join('\n');

        const commitText =
          `**Prices updated** — ${syncResult.updated} variant${syncResult.updated === 1 ? '' : 's'} changed.\n` +
          `Supabase synced: ${syncResult.logged} price_history entr${syncResult.logged === 1 ? 'y' : 'ies'} logged.\n\n` +
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
      const productGroups = new Map(); // productId -> { product, newPrice, variants: [] }
      const previewLines = [];
      const errors = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item.price !== 'number' || !isFinite(item.price) || item.price < 0) {
          errors.push(`Item ${i + 1}: invalid price "${item.price}".`);
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

        const priceNum = Math.round(item.price * 100) / 100;

        // Merge into productGroups (a product referenced twice with different
        // filters/prices gets multiple entries — last write wins on overlap,
        // which mirrors Shopify's bulk update semantics).
        const key = `${product.id}::${priceNum}`;
        if (!productGroups.has(key)) {
          productGroups.set(key, { product, newPrice: priceNum, variants: new Map() });
        }
        const group = productGroups.get(key);
        for (const v of matched) {
          group.variants.set(v.id, v);
        }

        previewLines.push(
          `  ${product.title}: ${matched.length} variant(s) → $${priceNum.toFixed(2)}` +
          (item.sizes ? ` [sizes: ${item.sizes.join(',')}]` : '') +
          (item.colors ? ` [colors: ${item.colors.join(',')}]` : '')
        );
      }

      if (errors.length && !productGroups.size) {
        return { content: [{ type: 'text', text: `No updates applied.\n${errors.join('\n')}` }] };
      }

      // Build the flat update list for preview + history
      const allUpdates = [];
      for (const { product, newPrice, variants } of productGroups.values()) {
        for (const v of variants.values()) {
          allUpdates.push({
            variant: v,
            productTitle: product.title,
            newPrice,
          });
        }
      }

      const changedUpdates = allUpdates.filter(u => parseFloat(u.variant.price) !== u.newPrice);

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

      // Build natural-language preview, one block per product/price group.
      const groupBlocks = [];
      for (const { product, newPrice, variants } of productGroups.values()) {
        const variantArr = [...variants.values()];
        const changed = variantArr.filter(v => parseFloat(v.price) !== newPrice);
        if (!changed.length) continue;

        const scope = describeScope(product, changed);
        const oldPrices = [...new Set(changed.map(v => parseFloat(v.price)))];
        const priceLine = oldPrices.length === 1
          ? `${formatPrice(oldPrices[0])} → ${formatPrice(newPrice)}`
          : `${oldPrices.map(formatPrice).join(' / ')} → ${formatPrice(newPrice)}`;

        const block = [
          `**${product.title}** — ${changed.length} variant${changed.length === 1 ? '' : 's'}`,
          `Scope: ${scope}`,
          `Price: ${priceLine}`,
        ];

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
