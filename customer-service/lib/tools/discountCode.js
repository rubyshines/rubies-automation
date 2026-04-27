/**
 * MCP tool for creating Shopify discount codes.
 *
 * Two modes:
 *   1. percent: % off applied to the "Discounts" collection. Used when a
 *      customer asks for a discount or never received their welcome code.
 *      Default 10%; values >10 require operator confirmation (two-phase).
 *   2. free_product: fixed amount equal to the highest variant price of a
 *      named product, scoped to that product (effectively makes it free for
 *      one use). Always two-phase since it's a high-value comp.
 *
 * Discount config:
 *   - Limit 1 use total
 *   - Combines with product/order/shipping discounts
 *   - No minimum purchase
 *   - All customers, all sales channels
 *   - Active from now, no end date
 *   - Code format: 10 random hex chars uppercase (e.g. A1B2C3D4E5).
 *     The Shopify discount's `title` carries the descriptive name for
 *     admin search ("Welcome 10", "Welcome 25", "Free Brooke", etc.);
 *     the code itself is opaque so it works for any discount type.
 *     Collisions are handled by retrying with a fresh code.
 */

const { createDiscountCode, randomDiscountCode, getAdminUrl } = require('../shopify');
const { searchProducts } = require('../productCache');

// The "Discounts" collection — the 19 products eligible for percent-off codes.
const DISCOUNTS_COLLECTION_GID = 'gid://shopify/Collection/515636363542';

function buildBaseConfig({ title, code, startsAt }) {
  return {
    title,
    code,
    customerSelection: { all: true },
    appliesOncePerCustomer: false,
    usageLimit: 1,
    combinesWith: {
      productDiscounts: true,
      orderDiscounts: true,
      shippingDiscounts: true,
    },
    startsAt,
  };
}

function buildPercentInput({ percentOff, code }) {
  // Shopify expects percentage as a decimal: 0.10 for 10%.
  // appliesOnOneTimePurchase is omitted because the shop doesn't have
  // subscriptions enabled and Shopify rejects the field in that case.
  return {
    ...buildBaseConfig({
      title: `Welcome ${percentOff}`,
      code,
      startsAt: new Date().toISOString(),
    }),
    customerGets: {
      value: { percentage: percentOff / 100 },
      items: { collections: { add: [DISCOUNTS_COLLECTION_GID] } },
    },
  };
}

function buildFreeProductInput({ amount, productGid, productTitle, code }) {
  return {
    ...buildBaseConfig({
      title: `Free ${productTitle}`,
      code,
      startsAt: new Date().toISOString(),
    }),
    customerGets: {
      value: {
        discountAmount: {
          amount: amount.toFixed(2),
          appliesOnEachItem: true,
        },
      },
      items: { products: { productsToAdd: [productGid] } },
    },
  };
}

/**
 * Create a discount code with retry on collision.
 * Shopify rejects duplicate codes with a userError; randomDiscountCode has
 * ~1 trillion possibilities so collisions are extremely rare, but we retry
 * up to 3 times with a fresh code as a belt-and-suspenders guarantee.
 * The mutationInput is rebuilt with the new code on each retry.
 */
async function createWithRetry(buildInput, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const code = randomDiscountCode();
    try {
      const node = await createDiscountCode(buildInput(code));
      return { node, code };
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      const isCollision = /already.*been.*taken|already.*exists|TAKEN/i.test(msg);
      if (!isCollision) throw err;
      // else: retry with a new code
    }
  }
  throw lastErr;
}

function findProductFromQuery(query) {
  const results = searchProducts(query);
  if (!results.length) return null;
  // searchProducts returns one row per variant, ranked by score. The top
  // product is the one whose first row appears first.
  const topProductId = results[0].productId;
  const variants = results.filter(r => r.productId === topProductId);
  const maxPrice = Math.max(...variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n)));
  return {
    productId: topProductId,
    productTitle: variants[0].productTitle,
    maxPrice,
    variantCount: variants.length,
  };
}

const tools = [
  {
    name: 'create_discount_code',
    description: 'Create a Shopify discount code. Two modes: (1) percent: % off applied to the "Discounts" collection — the standard response when a customer asks for a discount or never received their welcome code. Default 10%. (2) free_product: fixed-amount discount equal to the highest variant price of a named product, scoped to that product (makes it free for one use). Codes are limit-1-use, combine with product/order/shipping discounts, no minimum, all customers, active immediately. Two-phase confirmation required when percent_off > 10 OR mode=free_product. Returns the generated code string and an admin link.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['percent', 'free_product'],
          description: 'percent: % off the Discounts collection (default 10%). free_product: makes a single product free for one use.',
        },
        percent_off: {
          type: 'number',
          description: 'Percent off (1-100). Used when mode=percent. Default 10.',
        },
        product_query: {
          type: 'string',
          description: 'Product search query (e.g. "Brooke 2X"). Required when mode=free_product.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set true to execute (phase 2). Required when percent_off > 10 or mode=free_product.',
        },
        _discount_data: {
          type: 'object',
          description: 'Internal: phase-1 calculation passed back unchanged in phase 2.',
        },
      },
      required: ['mode'],
    },
    handler: async (input) => {
      const mode = input.mode;
      if (mode !== 'percent' && mode !== 'free_product') {
        return { content: [{ type: 'text', text: `Invalid mode "${mode}". Use "percent" or "free_product".` }], isError: true };
      }

      // --- Phase 2: confirmed execution ---
      if (input.confirmed && input._discount_data) {
        const data = input._discount_data;
        let buildInput;
        let summary;
        if (data.mode === 'percent') {
          buildInput = (code) => buildPercentInput({ percentOff: data.percent_off, code });
          summary = `${data.percent_off}% off the Discounts collection`;
        } else {
          buildInput = (code) => buildFreeProductInput({
            amount: data.amount,
            productGid: data.product_id,
            productTitle: data.product_title,
            code,
          });
          summary = `$${data.amount.toFixed(2)} off ${data.product_title} (one free for the customer)`;
        }

        let result;
        try {
          result = await createWithRetry(buildInput);
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to create discount: ${err.message}` }], isError: true };
        }
        const adminUrl = getAdminUrl(result.node.id);
        const lines = [
          '**Discount Code Created**',
          '',
          `**Code:** \`${result.code}\``,
          `**Discount:** ${summary}`,
          `**Limit:** 1 use total`,
          '',
          adminUrl,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // --- Phase 1 / immediate path ---
      if (mode === 'percent') {
        const percentOff = typeof input.percent_off === 'number' ? input.percent_off : 10;
        if (percentOff < 1 || percentOff > 100) {
          return { content: [{ type: 'text', text: `percent_off must be between 1 and 100 (got ${percentOff}).` }], isError: true };
        }
        const needsConfirm = percentOff > 10;
        if (!needsConfirm) {
          // Short-circuit: 10% (or less) is auto-issued without confirmation.
          let result;
          try {
            result = await createWithRetry((code) => buildPercentInput({ percentOff, code }));
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to create discount: ${err.message}` }], isError: true };
          }
          const adminUrl = getAdminUrl(result.node.id);
          const lines = [
            '**Discount Code Created**',
            '',
            `**Code:** \`${result.code}\``,
            `**Discount:** ${percentOff}% off the Discounts collection`,
            `**Limit:** 1 use total`,
            '',
            adminUrl,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        // Phase 1 preview for percent > 10
        const _discount_data = { mode: 'percent', percent_off: percentOff };
        const lines = [
          '**Discount Code Preview — Awaiting Confirmation**',
          '',
          `**Discount:** ${percentOff}% off the Discounts collection`,
          `**Limit:** 1 use total · Combines with product/order/shipping discounts`,
          '',
          `Confirm to create the code, or cancel to discard.`,
          '',
          `_To confirm, call create_discount_code again with confirmed=true and _discount_data=${JSON.stringify(_discount_data)}._`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // mode === 'free_product'
      const query = (input.product_query || '').trim();
      if (!query) {
        return { content: [{ type: 'text', text: 'product_query is required for free_product mode.' }], isError: true };
      }
      const found = findProductFromQuery(query);
      if (!found) {
        return { content: [{ type: 'text', text: `No product found matching "${query}".` }], isError: true };
      }
      const _discount_data = {
        mode: 'free_product',
        amount: found.maxPrice,
        product_id: found.productId,
        product_title: found.productTitle,
      };
      const lines = [
        '**Discount Code Preview — Awaiting Confirmation**',
        '',
        `**Product:** ${found.productTitle}`,
        `**Discount:** $${found.maxPrice.toFixed(2)} off (= highest variant price → product is effectively free)`,
        `**Limit:** 1 use total · Combines with product/order/shipping discounts`,
        '',
        `Confirm to create the code, or cancel to discard.`,
        '',
        `_To confirm, call create_discount_code again with confirmed=true and _discount_data=${JSON.stringify(_discount_data)}._`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
];

module.exports = tools;
