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
 * Partner / campaign batches (e.g. ten single-use 20% codes for an LGBTQ+
 * org to hand out): pass `title` to issue under a dedicated discount named
 * for the partner instead of the shared bucket, and `count` to issue several
 * codes in one call, `uses` for a per-code limit above 1 (one code the whole
 * org shares, ten uses), and `prefix` for codes people can recognise
 * (LEJAG-3F9A2C). `uses` > 1 needs a dedicated title, because a discount's
 * usageLimit applies to every code on it and the shared buckets are limit-1.
 * Otherwise the config is the bucket config; the only difference is which
 * discount holds the codes, so redemptions can be read per partner.
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
  findDiscountCodeByCode,
  findRedeemCode,
  deleteRedeemCodes,
  deactivateDiscountCode,
} = require('../shopify');
const { searchProducts } = require('../productCache');

// The "Discounts" collection — the 19 products eligible for percent-off codes.
const DISCOUNTS_COLLECTION_GID = 'gid://shopify/Collection/515636363542';

function bucketTitle(percentOff) {
  return `Thank You ${percentOff}`;
}

function buildBaseConfig({ title, code, startsAt, uses = 1 }) {
  return {
    title,
    code,
    customerSelection: { all: true },
    appliesOncePerCustomer: false,
    usageLimit: uses,
    combinesWith: {
      productDiscounts: true,
      orderDiscounts: true,
      shippingDiscounts: true,
    },
    startsAt,
  };
}

function buildPercentInput({ percentOff, code, title, uses }) {
  // Shopify expects percentage as a decimal: 0.10 for 10%.
  // appliesOnOneTimePurchase is omitted because the shop doesn't have
  // subscriptions enabled and Shopify rejects the field in that case.
  return {
    ...buildBaseConfig({
      title: title || bucketTitle(percentOff),
      code,
      uses,
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
/**
 * A prefix makes a code recognisable to the people handing it out
 * (LEJAG-3F9A2C). Letters/digits only, uppercased; the random tail is
 * shortened because the prefix carries the identity and a short code is
 * what a counsellor will type out. Store-wide uniqueness is still enforced
 * by Shopify and the collision retry.
 */
const PREFIXED_TAIL_LENGTH = 6;

function normalizePrefix(prefix) {
  const clean = String(prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean || undefined;
}

function generateCode(prefix) {
  const random = randomDiscountCode();
  return prefix ? `${prefix}-${random.slice(-PREFIXED_TAIL_LENGTH)}` : random;
}

async function withCollisionRetry(attempt, attempts = 3, prefix) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const code = generateCode(prefix);
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
 * Issue percent-off code(s): append to the existing discount with this title
 * ("Thank You N" by default, or a dedicated partner title), or create it with
 * the first code if it doesn't exist and append the rest. Two first issues at
 * a new level within a short window could race and create two buckets — the
 * title search index lags creation by a few seconds. Harmless (both work;
 * one bucket just accumulates from then on) and effectively impossible at CS
 * volumes now that the standard levels' buckets exist. For the same reason a
 * batch never re-searches after creating: the remaining codes go onto the
 * node the create returned.
 *
 * Returns { discountGid, codes, code } — `code` is the first (and for a
 * single issue the only) code, kept for existing callers.
 */
async function issuePercentCode(percentOff, { title, count = 1, uses = 1, prefix } = {}) {
  const discountTitle = title || bucketTitle(percentOff);
  const existing = await findDiscountNodeByTitle(discountTitle);
  let discountGid;
  let numericId;
  const codes = [];
  if (existing) {
    // A code appended to an existing discount inherits ITS per-code limit;
    // there is no per-code override, so a different `uses` cannot be honoured.
    if (existing.usageLimit !== undefined && existing.usageLimit !== uses) {
      const have = existing.usageLimit == null ? 'unlimited' : `${existing.usageLimit}`;
      throw new Error(`"${discountTitle}" already exists with a per-code limit of ${have}, so codes with ${uses} use(s) cannot be added to it. Use a different title (e.g. "${discountTitle} x${uses}") or omit uses.`);
    }
    discountGid = existing.id;
    numericId = existing.numericId;
  } else {
    const first = await withCollisionRetry(async (code) => {
      const node = await createDiscountCode(buildPercentInput({ percentOff, code, title: discountTitle, uses }));
      return { discountGid: node.id };
    }, 3, prefix);
    discountGid = first.discountGid;
    numericId = discountGid.split('/').pop();
    codes.push(first.code);
  }
  while (codes.length < count) {
    const added = await withCollisionRetry(async (code) => {
      await addCodeToPriceRule(numericId, code);
      return {};
    }, 3, prefix);
    codes.push(added.code);
  }
  return { discountGid, codes, code: codes[0] };
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

function createdResponse({ code, codes, discountGid, summary, uses = 1 }) {
  const adminUrl = getAdminUrl(discountGid);
  const all = codes && codes.length ? codes : [code];
  const lines = all.length === 1
    ? [
      '**Discount Code Created**',
      '',
      `**Code:** \`${all[0]}\``,
      `**Discount:** ${summary}`,
      `**Limit:** ${uses} use${uses === 1 ? '' : 's'} total`,
    ]
    : [
      `**${all.length} Discount Codes Created**`,
      '',
      `**Discount:** ${summary}`,
      `**Limit:** ${uses} use${uses === 1 ? '' : 's'} per code`,
      '',
      ...all.map(c => `- \`${c}\``),
    ];
  lines.push('', adminUrl);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// --- Revocation -------------------------------------------------------------

function fmtET(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

/**
 * Human-readable reasons a code might not be working, derived from the
 * discount's own state. This is the "why was my code invalid?" half of the
 * operator's job — the same lookup that powers revocation answers it, so the
 * preview always reports it.
 */
function diagnose(found) {
  const notes = [];
  if (found.status === 'EXPIRED') notes.push(`Expired${found.endsAt ? ` on ${fmtET(found.endsAt)}` : ''}.`);
  if (found.status === 'SCHEDULED') notes.push(`Not active yet — starts ${fmtET(found.startsAt) || 'later'}.`);
  if (found.usageLimit != null && found.codeUsageCount != null && found.codeUsageCount >= found.usageLimit) {
    notes.push(`Already redeemed ${found.codeUsageCount} time(s) against a limit of ${found.usageLimit} — the code is spent.`);
  }
  return notes;
}

function describeCode(found) {
  const lines = [
    `**Code:** \`${found.code}\``,
    `**Discount:** ${found.title || '(untitled)'}${found.summary ? ` — ${found.summary}` : ''}`,
    `**Status:** ${found.status}${found.endsAt ? ` · ends ${fmtET(found.endsAt)}` : ' · no end date'}`,
  ];
  if (found.codeUsageCount != null) {
    lines.push(`**This code's usage:** ${found.codeUsageCount}${found.usageLimit != null ? ` of ${found.usageLimit} allowed` : ''}`);
  }
  lines.push(found.codesCount === 1
    ? `**Codes on this discount:** 1 (this code IS the discount)`
    : `**Codes on this discount:** ${found.codesCount} (${found.codesCount - 1} belong to other customers)`);
  return lines;
}

function notFoundResponse(code) {
  return {
    content: [{
      type: 'text',
      text: [
        `**No discount code \`${code}\` exists in Shopify.**`,
        '',
        'Possible reasons:',
        '- Transcription slip — discount codes mix `0`/`O` and `1`/`I`/`l`. Check the customer\'s original email rather than a retyped version.',
        '- The code was already deleted or revoked.',
        '- It belongs to another system (a gift card, a Smile reward, or a partner platform), not a Shopify discount.',
        '',
        'The lookup is exact, so a near-miss returns nothing rather than guessing at a similar code.',
      ].join('\n'),
    }],
  };
}

// Backoff for confirming an async deletion: check immediately (Shopify usually
// completes a single-code delete before the mutation response lands), then back
// off to ~5s total before reporting it as still in flight.
const REMOVAL_BACKOFF_MS = [0, 300, 700, 1500, 2500];

/**
 * After the async bulk delete, confirm the code is actually gone rather than
 * trusting the Job handle — a Job id says the work was queued, not that the
 * customer can no longer redeem the code.
 */
async function waitForRemoval(discountGid, code) {
  for (const delay of REMOVAL_BACKOFF_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    const still = await findRedeemCode(discountGid, code);
    if (!still) return true;
  }
  return false;
}

const tools = [
  {
    name: 'create_discount_code',
    description: 'Create a Shopify discount code. Two modes: (1) percent: % off applied to the "Discounts" collection — the standard response when a customer asks for a discount or never received their welcome code. Default 10%. Each code is added to the shared "Thank You N" discount for that percent level, or to a dedicated discount when `title` is given (partner/campaign batches — e.g. ten 20% codes for an LGBTQ+ org, so their redemptions read separately from CS comps). `count` issues several distinct codes in one call; `uses` sets the per-code limit (one code the whole org shares = count 1, uses 10 — needs a `title`); `prefix` makes codes recognisable (LEJAG-3F9A2C). (2) free_product: fixed-amount discount equal to the highest variant price of a named product, scoped to that product (makes it free for one use). Codes are limit-1-use, combine with product/order/shipping discounts, no minimum, all customers, active immediately. Two-phase confirmation required when percent_off > 10, count > 1, uses > 1, OR mode=free_product. Returns the generated code string(s) and an admin link.',
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
        title: {
          type: 'string',
          description: 'percent mode only. Dedicated discount title to issue under instead of the shared "Thank You N" bucket, e.g. "Le JAG 20" for a partner batch. Created on first use, appended to after.',
        },
        count: {
          type: 'number',
          description: 'percent mode only. Number of distinct codes to issue (1-50, default 1).',
        },
        uses: {
          type: 'number',
          description: 'percent mode only. How many times EACH code can be redeemed (1-1000, default 1). Above 1 requires `title`, since a limit belongs to the discount and the shared buckets are single-use. Cannot change the limit of a title that already exists.',
        },
        prefix: {
          type: 'string',
          description: 'percent mode only. Recognisable prefix for the codes, e.g. "LEJAG" → LEJAG-3F9A2C. Letters and digits only; uppercased.',
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
            const result = await issuePercentCode(data.percent_off, {
              title: data.title, count: data.count, uses: data.uses || 1, prefix: data.prefix,
            });
            return createdResponse({
              codes: result.codes,
              discountGid: result.discountGid,
              summary: `${data.percent_off}% off the Discounts collection${data.title ? ` (${data.title})` : ''}`,
              uses: data.uses || 1,
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
        const count = typeof input.count === 'number' ? input.count : 1;
        if (!Number.isInteger(count) || count < 1 || count > 50) {
          return { content: [{ type: 'text', text: `count must be a whole number between 1 and 50 (got ${input.count}).` }], isError: true };
        }
        const title = (input.title || '').trim() || undefined;
        const uses = typeof input.uses === 'number' ? input.uses : 1;
        if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
          return { content: [{ type: 'text', text: `uses must be a whole number between 1 and 1000 (got ${input.uses}).` }], isError: true };
        }
        if (uses > 1 && !title) {
          return { content: [{ type: 'text', text: `uses > 1 needs a dedicated title: the shared "Thank You ${percentOff}" bucket is single-use per code and a limit belongs to the whole discount.` }], isError: true };
        }
        const prefix = normalizePrefix(input.prefix);
        if (input.prefix && !prefix) {
          return { content: [{ type: 'text', text: `prefix must contain at least one letter or digit (got "${input.prefix}").` }], isError: true };
        }
        const needsConfirm = percentOff > 10 || count > 1 || uses > 1;
        if (!needsConfirm) {
          // Short-circuit: a single 10% (or less) single-use code is auto-issued without confirmation.
          try {
            const result = await issuePercentCode(percentOff, { title, prefix });
            return createdResponse({
              code: result.code,
              discountGid: result.discountGid,
              summary: `${percentOff}% off the Discounts collection${title ? ` (${title})` : ''}`,
            });
          } catch (err) {
            return { content: [{ type: 'text', text: `Failed to create discount: ${err.message}` }], isError: true };
          }
        }
        // Phase 1 preview for percent > 10 or a batch
        const _discount_data = {
          mode: 'percent', percent_off: percentOff, count, uses,
          ...(title ? { title } : {}), ...(prefix ? { prefix } : {}),
        };
        const lines = [
          '**Discount Code Preview — Awaiting Confirmation**',
          '',
          `**Discount:** ${percentOff}% off the Discounts collection`,
          `**Issued under:** ${title || bucketTitle(percentOff)}${title ? ' (dedicated)' : ' (shared bucket)'}`,
          `**Codes:** ${count}${prefix ? ` (${prefix}-…)` : ''} · each limit ${uses} use${uses === 1 ? '' : 's'} · Combines with product/order/shipping discounts`,
          '',
          `Confirm to create the code${count > 1 ? 's' : ''}, or cancel to discard.`,
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
  {
    name: 'revoke_discount_code',
    description: 'Invalidate ONE specific discount code, or inspect a code to explain why it is not working. Call WITHOUT confirmed to look the code up: returns the parent discount, status, how many times that code has been used, how many other codes share the discount, and a diagnosis when the code is expired/scheduled/already-redeemed. Call WITH confirmed=true to revoke it. Revoking removes only the customer\'s own code — every other code on the same discount keeps working, which matters because one discount can own thousands of codes (bulk birthday/free-swimwear pools, the shared "Thank You N" comp buckets). When the discount owns exactly one code (a one-off free-product comp) the discount itself is deactivated instead, since there the code IS the discount. Use this after re-issuing a replacement code so the customer cannot redeem both, or when a code was sent in error. Does not refund anything — if the code was already redeemed, revoking will not undo that order.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The exact discount code string as the customer has it (e.g. "FREEAJS-1OSRJP2O"). Matched exactly — no fuzzy search.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set true to execute the revocation (phase 2). Omit for the lookup + preview (phase 1).',
        },
      },
      required: ['code'],
    },
    handler: async (input) => {
      const code = (input.code || '').trim();
      if (!code) {
        return { content: [{ type: 'text', text: 'code is required.' }], isError: true };
      }

      let found;
      try {
        found = await findDiscountCodeByCode(code);
      } catch (err) {
        return { content: [{ type: 'text', text: `Discount lookup failed: ${err.message}` }], isError: true };
      }
      if (!found) return notFoundResponse(code);

      const adminUrl = getAdminUrl(found.discountGid);
      const singleCode = found.codesCount === 1;
      const notes = diagnose(found);

      // --- Phase 1: lookup + preview ---
      if (!input.confirmed) {
        const lines = ['**Discount Code Lookup**', '', ...describeCode(found)];
        if (notes.length) {
          lines.push('', '**Why it may not be working:**', ...notes.map(n => `- ${n}`));
        }
        lines.push('', '**Revoking would:**');
        if (singleCode) {
          lines.push(`- Deactivate the discount "${found.title}" — this code is its only code. Reversible from admin.`);
        } else {
          lines.push(`- Delete only \`${found.code}\` from "${found.title}".`);
          lines.push(`- Leave the other ${found.codesCount - 1} code(s) on that discount working. This is NOT reversible.`);
        }
        if (found.codeUsageCount > 0) {
          lines.push(`- ⚠️ Not undo the ${found.codeUsageCount} order(s) already placed with this code — revoking only blocks future use.`);
        }
        lines.push('', adminUrl, '', '_To revoke, call revoke_discount_code again with confirmed=true._');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // --- Phase 2: confirmed revocation ---
      try {
        if (singleCode) {
          const result = await deactivateDiscountCode(found.discountGid);
          return {
            content: [{
              type: 'text',
              text: [
                '**Discount Code Revoked**',
                '',
                `**Code:** \`${found.code}\` — no longer redeemable.`,
                `**How:** deactivated the discount "${found.title}" (this code was its only code). Status is now ${result.status || 'inactive'}.`,
                found.codeUsageCount > 0
                  ? `**Note:** the code had already been used ${found.codeUsageCount} time(s). Those orders stand.`
                  : '**Note:** the code was never redeemed.',
                '',
                adminUrl,
              ].join('\n'),
            }],
          };
        }

        if (!found.redeemCodeId) {
          return {
            content: [{
              type: 'text',
              text: `Found the discount "${found.title}" but could not resolve \`${code}\` to its individual code row, so nothing was changed. Revoking without that id would risk affecting the other ${found.codesCount - 1} codes. Remove this one code from the discount in Shopify admin instead: ${adminUrl}`,
            }],
            isError: true,
          };
        }

        await deleteRedeemCodes(found.discountGid, [found.redeemCodeId]);
        const gone = await waitForRemoval(found.discountGid, found.code);

        const lines = [
          gone ? '**Discount Code Revoked**' : '**Revocation Submitted**',
          '',
          `**Code:** \`${found.code}\``,
          `**Removed from:** ${found.title}`,
          `**Untouched:** the other ${found.codesCount - 1} code(s) on that discount still work.`,
        ];
        if (found.codeUsageCount > 0) {
          lines.push(`**Note:** the code had already been used ${found.codeUsageCount} time(s). Those orders stand.`);
        }
        if (!gone) {
          lines.push('', '⚠️ Shopify processes code deletion asynchronously and it had not finished when checked. It normally lands within a few seconds — re-run this tool without confirmed to verify.');
        }
        lines.push('', adminUrl);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to revoke \`${code}\`: ${err.message}` }], isError: true };
      }
    },
  },
];

module.exports = tools;
