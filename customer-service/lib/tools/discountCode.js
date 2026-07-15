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
 * Percent codes live in one shared "bucket" discount per level ("Thank You
 * 10", "Thank You 15", ...) — each issued code is appended to the existing
 * discount rather than creating a new one, so the admin discounts list stays
 * at one entry per level no matter how many codes are issued. The bucket is
 * created on first use for a given percent. Shopify's usageLimit on a
 * multi-code discount applies PER CODE (verified against the store's
 * Klaviyo-managed "Welcome 10": usageLimit 1, 205 redemptions across 7,890
 * codes), so usageLimit: 1 keeps every code single-use.
 *
 * "Thank You" (not "Welcome") so CS comp codes can never be confused with
 * the Klaviyo newsletter/SMS signup discounts titled "Welcome 10/15".
 *
 * Free-product comps stay one-discount-per-code since they're product-specific.
 *
 * Discount config:
 *   - Limit 1 use per code
 *   - Combines with product/order/shipping discounts
 *   - No minimum purchase
 *   - All customers, all sales channels
 *   - Active from now, no end date
 *   - Code format: 10 random hex chars uppercase (e.g. A1B2C3D4E5).
 *     Codes are unique store-wide (Shopify enforces this across all
 *     discounts); collisions are handled by retrying with a fresh code.
 */

const {
  createDiscountCode,
  findDiscountNodeByTitle,
  addCodeToPriceRule,
  randomDiscountCode,
  getAdminUrl,
} = require('../shopify');
const { searchProducts } = require('../productCache');

// The "Discounts" collection — the 19 products eligible for percent-off codes.
const DISCOUNTS_COLLECTION_GID = 'gid://shopify/Collection/515636363542';

function bucketTitle(percentOff) {
  return `Thank You ${percentOff}`;
}

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
      title: bucketTitle(percentOff),
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

function isCollisionError(err) {
  const msg = (err && err.message) || '';
  return /already.*been.*taken|already.*exists|TAKEN/i.test(msg);
}

/**
 * Run an attempt function with a fresh random code, retrying on code
 * collision. Shopify rejects duplicate codes store-wide; randomDiscountCode
 * has ~1 trillion possibilities so collisions are extremely rare, but we
 * retry up to 3 times with a fresh code as a belt-and-suspenders guarantee.
 */
async function withCollisionRetry(attempt, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const code = randomDiscountCode();
    try {
      const result = await attempt(code);
      return { ...result, code };
    } catch (err) {
      lastErr = err;
      if (!isCollisionError(err)) throw err;
      // else: retry with a new code
    }
  }
  throw lastErr;
}

/**
 * Issue a percent-off code: append to the existing "Thank You N" bucket
 * discount, or create the bucket (with this first code) if it doesn't exist.
 * Two first issues at a new level within a short window could race and
 * create two buckets — the title search index lags creation by a few
 * seconds. Harmless (both work; one bucket just accumulates from then on)
 * and effectively impossible at CS volumes now that the standard levels'
 * buckets exist.
 */
async function issuePercentCode(percentOff) {
  const bucket = await findDiscountNodeByTitle(bucketTitle(percentOff));
  if (bucket) {
    return withCollisionRetry(async (code) => {
      await addCodeToPriceRule(bucket.numericId, code);
      return { discountGid: bucket.id };
    });
  }
  return withCollisionRetry(async (code) => {
    const node = await createDiscountCode(buildPercentInput({ percentOff, code }));
    return { discountGid: node.id };
  });
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

function createdResponse({ code, discountGid, summary }) {
  const adminUrl = getAdminUrl(discountGid);
  const lines = [
    '**Discount Code Created**',
    '',
    `**Code:** \`${code}\``,
    `**Discount:** ${summary}`,
    `**Limit:** 1 use total`,
    '',
    adminUrl,
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

const tools = [
  {
    name: 'create_discount_code',
    description: 'Create a Shopify discount code. Two modes: (1) percent: % off applied to the "Discounts" collection — the standard response when a customer asks for a discount or never received their welcome code. Default 10%. Each code is added to the shared "Thank You N" discount for that percent level. (2) free_product: fixed-amount discount equal to the highest variant price of a named product, scoped to that product (makes it free for one use). Codes are limit-1-use, combine with product/order/shipping discounts, no minimum, all customers, active immediately. Two-phase confirmation required when percent_off > 10 OR mode=free_product. Returns the generated code string and an admin link.',
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
        try {
          if (data.mode === 'percent') {
            const result = await issuePercentCode(data.percent_off);
            return createdResponse({
              code: result.code,
              discountGid: result.discountGid,
              summary: `${data.percent_off}% off the Discounts collection`,
            });
          }
          const result = await withCollisionRetry(async (code) => {
            const node = await createDiscountCode(buildFreeProductInput({
              amount: data.amount,
              productGid: data.product_id,
              productTitle: data.product_title,
              code,
            }));
            return { discountGid: node.id };
          });
          return createdResponse({
            code: result.code,
            discountGid: result.discountGid,
            summary: `$${data.amount.toFixed(2)} off ${data.product_title} (one free for the customer)`,
          });
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to create discount: ${err.message}` }], isError: true };
        }
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
          try {
            const result = await issuePercentCode(percentOff);
            return createdResponse({
              code: result.code,
              discountGid: result.discountGid,
              summary: `${percentOff}% off the Discounts collection`,
            });
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to create discount: ${err.message}` }], isError: true };
          }
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
