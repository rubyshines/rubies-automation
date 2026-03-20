/**
 * Wholesale order tools: create_wholesale_order, parse_wholesale_input
 *
 * Discount logic:
 *   US or AU → 50% off per line item
 *   All others → 30% off per line item
 *   All wholesale → free shipping
 *
 * Currency: orders use customer's local currency, except:
 *   hello@sockdrawerheroes.com (AU) → always USD
 *
 * AU orders: auto-split to stay under $1,000 AUD each (de minimis threshold)
 */

const { createDraftOrder, deleteDraftOrder, completeDraftOrder, sendDraftOrderInvoice, searchCustomers, normalizeGid } = require('../shopify');
const { searchProducts, getVariantById } = require('../productCache');

function getStoreName() {
  const storeUrl = process.env.SHOPIFY_STORE_URL || '';
  return storeUrl.replace('.myshopify.com', '');
}

function getAdminUrl(gid) {
  const storeName = getStoreName();
  const numericId = gid.split('/').pop();
  if (gid.includes('/DraftOrder/')) {
    return `https://admin.shopify.com/store/${storeName}/draft_orders/${numericId}`;
  }
  return `https://admin.shopify.com/store/${storeName}/orders/${numericId}`;
}

const CURRENCY_OVERRIDES = {
  'hello@sockdrawerheroes.com': 'USD',
};

// ---------------------------------------------------------------------------
// CSV Matrix Parser — programmatically maps header columns to sizes
// ---------------------------------------------------------------------------

const KNOWN_SIZES = new Set([
  'XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', 'XL', 'XXL',
  '1X', '2X', '3X', '4X', '5X',
  '3XL', '4XL', '5XL',  // spreadsheet aliases for 3X, 4X, 5X
  '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
]);

function parseCSVMatrix(lines) {
  const results = [];
  const errors = [];
  const skippedRows = [];      // rows with a product/colour but zero quantities
  const unknownProducts = [];  // product names not found in catalog

  // Parse header row to find size column indices
  const headerCells = lines[0].split(',').map(c => c.trim());
  const sizeColumns = []; // { index, size }
  for (let i = 0; i < headerCells.length; i++) {
    const cell = headerCells[i].toUpperCase();
    if (KNOWN_SIZES.has(cell)) {
      sizeColumns.push({ index: i, size: headerCells[i] }); // preserve original case
    }
  }

  // Find product and colour column indices (typically 0 and 1)
  const productColIdx = 0;
  const colourColIdx = 1;

  let currentProduct = '';

  for (let row = 1; row < lines.length; row++) {
    const cells = lines[row].split(',').map(c => c.trim());

    // Update current product if column has a value
    if (cells[productColIdx] && cells[productColIdx].length > 0) {
      currentProduct = cells[productColIdx];
    }
    const colour = cells[colourColIdx] || '';

    if (!currentProduct || !colour) continue;

    // Extract quantities from size columns
    let rowHasQty = false;
    for (const { index, size } of sizeColumns) {
      const val = cells[index];
      if (!val || val.length === 0) continue;
      const qty = parseInt(val, 10);
      if (isNaN(qty) || qty <= 0) continue;

      rowHasQty = true;

      // Build search query: "ProductName Colour Size"
      const query = `${currentProduct} ${colour} ${size}`;
      const searchResults = searchProducts(query);

      if (searchResults.length === 0) {
        errors.push(`No match for: "${query}" (row ${row + 1}, size ${size})`);
        continue;
      }

      const best = searchResults[0];
      results.push({
        query,
        matchedProduct: best.productTitle,
        matchedVariant: best.variantTitle,
        variantId: best.variantId,
        sku: best.sku,
        price: best.price,
        quantity: qty,
      });
    }

    // Track rows with no quantities (product listed but nothing ordered)
    if (!rowHasQty) {
      skippedRows.push({ row: row + 1, product: currentProduct, colour });
    }

    // Check if product name is recognized (only check once per new product name)
    if (cells[productColIdx] && cells[productColIdx].length > 0) {
      const productCheck = searchProducts(currentProduct);
      if (productCheck.length === 0) {
        unknownProducts.push({ row: row + 1, product: currentProduct });
      }
    }
  }

  // Build warnings
  const warnings = [];
  if (unknownProducts.length > 0) {
    warnings.push(`⚠️ UNKNOWN PRODUCTS (not found in catalog): ${unknownProducts.map(u => `"${u.product}" (row ${u.row})`).join(', ')}`);
  }
  if (skippedRows.length > 0) {
    warnings.push(`ℹ️ Rows with zero quantities (skipped): ${skippedRows.map(s => `${s.product} / ${s.colour} (row ${s.row})`).join(', ')}`);
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ format: 'csv_matrix', resolved: results, warnings, errors }, null, 2),
    }],
  };
}

// ---------------------------------------------------------------------------
// Simple Text Parser — one item per line
// ---------------------------------------------------------------------------

function parseSimpleText(lines) {
  const results = [];
  const errors = [];

  for (const line of lines) {
    let quantity = 1;
    let query = line;

    // "... qty 3" or "... qty: 3" or "... quantity: 3" or "... qty. 3"
    const qtyMatch = line.match(/^(.+?)[,\s]+(?:qty|quantity)\.?\s*:?\s*(\d+)\s*$/i);
    if (qtyMatch) {
      query = qtyMatch[1].trim();
      quantity = parseInt(qtyMatch[2]);
    }
    // "2x ..." or "2 x ..."
    else {
      const xMatch = line.match(/^(\d+)\s*x\s+(.+)/i);
      if (xMatch) {
        quantity = parseInt(xMatch[1]);
        query = xMatch[2];
      } else {
        // "... x2" or "... x 2" (quantity at end with x)
        const endXMatch = line.match(/^(.+?)\s*x\s*(\d+)\s*$/i);
        if (endXMatch) {
          query = endXMatch[1].trim();
          quantity = parseInt(endXMatch[2]);
        } else {
          // "..., 2" (quantity at end after comma)
          const endMatch = line.match(/^(.+?),\s*(\d+)$/);
          if (endMatch) {
            query = endMatch[1];
            quantity = parseInt(endMatch[2]);
          } else {
            // "2, ..." (quantity at start before comma)
            const startMatch = line.match(/^(\d+),\s*(.+)$/);
            if (startMatch) {
              quantity = parseInt(startMatch[1]);
              query = startMatch[2];
            }
          }
        }
      }
    }

    const searchResults = searchProducts(query.trim());
    if (searchResults.length === 0) {
      errors.push(`No match for: "${line}"`);
      continue;
    }

    const best = searchResults[0];
    results.push({
      query: line,
      matchedProduct: best.productTitle,
      matchedVariant: best.variantTitle,
      variantId: best.variantId,
      sku: best.sku,
      price: best.price,
      quantity,
    });
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ format: 'simple_text', resolved: results, errors }, null, 2),
    }],
  };
}

const tools = [
  {
    name: 'parse_wholesale_input',
    description: [
      'Parse CSV matrix, text, or structured input into resolved product line items with variant IDs.',
      'Use this before create_wholesale_order when input comes from a spreadsheet or free-form text.',
      'IMPORTANT: For CSV matrix format (size columns as headers, quantities in cells), pass the RAW CSV including the header row.',
      'The tool auto-detects CSV matrix format by looking for size-related column headers (XXS, XS, S, M, L, XL, or numeric sizes like 4, 6, 8, 10).',
      'For CSV matrix: the first column is product name, second is colour. Empty product name = same product as row above.',
      'For simple text: one item per line, e.g. "AJ Black S x3" or "3x AJ Black S".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Raw CSV (with header row) or free-form text listing products and quantities.',
        },
      },
      required: ['input'],
    },
    handler: async ({ input }) => {
      const lines = input.split('\n').map(l => l.trim()).filter(Boolean);

      // --- Detect CSV matrix format ---
      // Check if first line looks like a header with size columns
      const KNOWN_SIZES = new Set([
        'XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', 'XL', 'XXL',
        '1X', '2X', '3X', '4X', '5X',
        '4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
      ]);

      const firstLineCells = lines[0].split(',').map(c => c.trim());
      const sizeColumnsInHeader = firstLineCells.filter(c => KNOWN_SIZES.has(c.toUpperCase()));
      const isCSVMatrix = sizeColumnsInHeader.length >= 3; // At least 3 size columns = matrix format

      if (isCSVMatrix) {
        return parseCSVMatrix(lines);
      }

      // --- Simple text format (one item per line) ---
      return parseSimpleText(lines);
    },
  },
  {
    name: 'create_wholesale_order',
    description: [
      'Create a wholesale draft order with appropriate discount (50% for US/AU, 30% for others) and free shipping.',
      'Two-phase flow:',
      'Phase 1 (confirmed omitted or false): creates draft order(s) in Shopify and returns a preview with clickable admin links, shipping address, and item breakdown. For AU orders, auto-splits if total exceeds $1,000 AUD.',
      'IMPORTANT: You MUST show the full Phase 1 preview output to the user and wait for their explicit confirmation before proceeding to Phase 2. Never skip the preview.',
      'Phase 2 (confirmed=true + draft_order_ids): sends a Shopify invoice email for each draft order. Only call Phase 2 after the user has reviewed and approved the preview.',
      'Tagged with "wholesale" and "cs-mcp".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (GID or numeric)',
        },
        customer_email: {
          type: 'string',
          description: 'Customer email (used for currency override check)',
        },
        country_code: {
          type: 'string',
          description: 'Two-letter country code (e.g. "US", "AU", "GB") for discount tier',
        },
        items: {
          type: 'array',
          description: 'Items with variant_id or query and quantity (required for phase 1)',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              query: { type: 'string' },
              quantity: { type: 'number' },
            },
          },
        },
        note: { type: 'string', description: 'Optional note for the draft order' },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to complete previously created draft order(s) and send invoices (phase 2). Requires draft_order_ids.',
        },
        draft_order_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Draft order GIDs from phase 1. Required when confirmed=true.',
        },
      },
      required: ['customer_id'],
    },
    handler: async ({ customer_id, customer_email, country_code, items, note, confirmed, draft_order_ids }) => {
      const customerGid = normalizeGid(customer_id, 'Customer');

      // --- Phase 2: Confirm drafts, complete them, and send invoices ---
      if (confirmed && draft_order_ids && draft_order_ids.length > 0) {
        const results = [];
        for (const draftId of draft_order_ids) {
          const draftGid = normalizeGid(draftId, 'DraftOrder');
          const draftAdminUrl = getAdminUrl(draftGid);

          // Send invoice (before completing, since completed drafts become orders)
          const invoiceResult = await sendDraftOrderInvoice(draftGid);

          results.push({
            draftName: invoiceResult.name,
            draftAdminUrl,
            invoiceUrl: invoiceResult.invoiceUrl,
          });
        }

        let resultText = `**Wholesale Order${results.length > 1 ? 's' : ''} — Invoices Sent**\n\n`;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (results.length > 1) resultText += `**Draft ${i + 1} of ${results.length}:**\n`;
          resultText += `**Draft Order:** ${r.draftName} — ${r.draftAdminUrl}\n`;
          resultText += `**Invoice sent** — Payment link: ${r.invoiceUrl}\n\n`;
        }

        return { content: [{ type: 'text', text: resultText }] };
      }

      // --- Phase 1: Create draft order(s) + show preview ---
      if (!country_code) {
        return { content: [{ type: 'text', text: 'Error: country_code is required to create a wholesale order.' }] };
      }
      if (!items || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items are required to create a wholesale order.' }] };
      }

      const cc = (country_code || '').toUpperCase();
      const discountPercent = (cc === 'US' || cc === 'AU') ? 50 : 30;

      // Resolve items
      const resolvedItems = await resolveItems(items);
      if (resolvedItems.error) {
        return { content: [{ type: 'text', text: resolvedItems.error }] };
      }

      // Check currency override
      const email = (customer_email || '').toLowerCase().trim();
      const currencyOverride = CURRENCY_OVERRIDES[email];

      // Look up customer details for address
      let customerName = customer_id;
      let addressBlock = 'No address on file';
      let shippingAddress = null;
      try {
        const numericId = customerGid.split('/').pop();
        const customers = await searchCustomers(`id:${numericId}`);
        if (customers.length > 0) {
          const c = customers[0];
          customerName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;
          if (c.defaultAddress) {
            const a = c.defaultAddress;
            addressBlock = [a.address1, `${a.city}, ${a.province} ${a.zip}`, a.country].filter(Boolean).join('\n');
            shippingAddress = {
              firstName: c.firstName || '',
              lastName: c.lastName || '',
              address1: a.address1,
              city: a.city,
              province: a.province,
              country: a.countryCodeV2 || a.country,
              zip: a.zip,
            };
          }
        }
      } catch (_) {
        // Non-critical — continue with basic customer ID
      }

      const defaultNote = `Wholesale order - ${discountPercent}% ${cc} discount via CS MCP server`;

      function buildDraftInput(itemList, orderNote) {
        const lineItems = itemList.map(r => ({
          variantId: r.variantId,
          quantity: r.quantity,
          appliedDiscount: {
            title: `Wholesale ${discountPercent}%`,
            value: discountPercent,
            valueType: 'PERCENTAGE',
          },
        }));
        const input = {
          customerId: customerGid,
          lineItems,
          note: orderNote,
          shippingLine: { title: 'Free Shipping', price: '0.00' },
          tags: ['wholesale', 'cs-mcp'],
        };
        if (shippingAddress) {
          input.shippingAddress = shippingAddress;
          input.billingAddress = shippingAddress;
        }
        if (currencyOverride) {
          input.presentmentCurrencyCode = currencyOverride;
        }
        return input;
      }

      // AU de minimis: probe with a single draft to get real AUD prices, then split if needed
      const isAU = cc === 'AU';
      const needsSplitCheck = isAU && !currencyOverride;
      const DE_MINIMIS_AUD = 1000;

      const createdOrders = [];

      if (needsSplitCheck) {
        // Phase A: Create a single probe draft order with all items
        const probeInput = buildDraftInput(resolvedItems, note || defaultNote);
        const probeDraft = await createDraftOrder(probeInput);

        const probeTotalAUD = parseFloat(
          (probeDraft.totalPriceSet && probeDraft.totalPriceSet.presentmentMoney)
            ? probeDraft.totalPriceSet.presentmentMoney.amount
            : probeDraft.totalPrice
        );

        if (probeTotalAUD <= DE_MINIMIS_AUD) {
          // Under threshold — keep the single order
          createdOrders.push({ draftOrder: probeDraft, splitItems: resolvedItems });
        } else {
          // Over threshold — extract real AUD prices per line item, delete probe, re-create splits
          const probeLineItems = probeDraft.lineItems.edges.map(e => e.node);

          // Map variant ID → real AUD discounted price from Shopify
          const audPriceMap = new Map();
          for (const li of probeLineItems) {
            if (li.variant && li.variant.id) {
              const discSet = li.discountedUnitPriceSet && li.discountedUnitPriceSet.presentmentMoney;
              if (discSet) {
                audPriceMap.set(li.variant.id, parseFloat(discSet.amount));
              }
            }
          }

          // Delete the probe draft
          await deleteDraftOrder(probeDraft.id);

          // Set real AUD prices on resolved items for splitting
          for (const item of resolvedItems) {
            const audPrice = audPriceMap.get(item.variantId);
            if (audPrice !== undefined) {
              item.lineTotal = audPrice * item.quantity;
            } else {
              // Fallback: estimate from USD price * probe ratio
              const price = parseFloat(item.price || 0);
              item.lineTotal = price * (1 - discountPercent / 100) * item.quantity;
            }
          }

          // Split using real AUD prices against real $1,000 AUD threshold
          const splits = splitForDeMinimis(resolvedItems, DE_MINIMIS_AUD);

          // Create the split draft orders
          for (let i = 0; i < splits.length; i++) {
            let orderNote = note || defaultNote;
            if (splits.length > 1) orderNote += ` | Split ${i + 1} of ${splits.length}`;
            const input = buildDraftInput(splits[i], orderNote);
            const draftOrder = await createDraftOrder(input);
            createdOrders.push({ draftOrder, splitItems: splits[i] });
          }
        }
      } else {
        // Non-AU or currency override — single order, no splitting
        const input = buildDraftInput(resolvedItems, note || defaultNote);
        const draftOrder = await createDraftOrder(input);
        createdOrders.push({ draftOrder, splitItems: resolvedItems });
      }

      // Use presentment currency from the Shopify response (not local calculations)
      const currency = createdOrders[0].draftOrder.presentmentCurrencyCode || 'USD';

      function getPresentmentTotal(draftOrder) {
        const pm = draftOrder.totalPriceSet && draftOrder.totalPriceSet.presentmentMoney;
        return pm ? parseFloat(pm.amount) : parseFloat(draftOrder.totalPrice);
      }

      // Build preview output (matches exchange order style)
      const draftOrderIds = [];
      const outputLines = [
        `**Wholesale Draft Order${createdOrders.length > 1 ? 's' : ''} Created — Awaiting Confirmation**`,
        '',
      ];

      // Draft order links at the top
      for (let i = 0; i < createdOrders.length; i++) {
        const { draftOrder } = createdOrders[i];
        const draftAdminUrl = getAdminUrl(draftOrder.id);
        draftOrderIds.push(draftOrder.id);
        const label = createdOrders.length > 1 ? `**Draft Order ${i + 1}:**` : '**Wholesale Draft Order:**';
        outputLines.push(`${label} ${draftOrder.name} — ${draftAdminUrl}`);
      }
      outputLines.push('');

      outputLines.push(`**Customer:** ${customerName}`);
      outputLines.push('**Ship to:**');
      outputLines.push(addressBlock);
      outputLines.push('');
      outputLines.push(`**Discount:** ${discountPercent}% (${cc}) | **Currency:** ${currency}${currencyOverride ? ` (override: ${currencyOverride})` : ''}`);
      outputLines.push('');

      // Items grouped by split — use line items from Shopify response
      for (let i = 0; i < createdOrders.length; i++) {
        const { draftOrder } = createdOrders[i];
        const draftAdminUrl = getAdminUrl(draftOrder.id);
        const splitTotal = getPresentmentTotal(draftOrder);

        if (createdOrders.length > 1) {
          outputLines.push(`--- ${draftOrder.name} (${draftAdminUrl}) ---`);
        }
        outputLines.push('**Items:**');
        const lineItems = draftOrder.lineItems.edges.map(e => e.node);
        for (const li of lineItems) {
          const discountedSet = li.discountedUnitPriceSet && li.discountedUnitPriceSet.presentmentMoney;
          const unitPrice = discountedSet ? parseFloat(discountedSet.amount) : parseFloat(li.originalUnitPrice);
          const lineTotal = unitPrice * li.quantity;
          const variantInfo = li.variant && li.variant.title && li.variant.title !== 'Default Title' ? ` - ${li.variant.title}` : '';
          outputLines.push(`  ${li.quantity}x ${li.title}${variantInfo} → ${currency} $${unitPrice.toFixed(2)} each = ${currency} $${lineTotal.toFixed(2)}`);
        }
        outputLines.push(`**Total:** ${currency} $${splitTotal.toFixed(2)}`);
        outputLines.push('');
      }

      // Summary table
      const totalUnits = resolvedItems.reduce((sum, r) => sum + r.quantity, 0);
      if (createdOrders.length > 1) {
        outputLines.push('**Order Summary:**');
        outputLines.push('| Draft | Order | Total |');
        outputLines.push('|-------|-------|-------|');
        let grandTotal = 0;
        for (let i = 0; i < createdOrders.length; i++) {
          const { draftOrder } = createdOrders[i];
          const draftAdminUrl = getAdminUrl(draftOrder.id);
          const splitTotal = getPresentmentTotal(draftOrder);
          grandTotal += splitTotal;
          outputLines.push(`| Split ${i + 1} | ${draftOrder.name} — ${draftAdminUrl} | ${currency} $${splitTotal.toFixed(2)} |`);
        }
        outputLines.push(`| **Total** | **${totalUnits} units** | **${currency} $${grandTotal.toFixed(2)}** |`);
        outputLines.push('');
        outputLines.push(`⚠️ AU de minimis: Order split into ${createdOrders.length} draft orders (each under $1,000 AUD)`);
      } else {
        const total = getPresentmentTotal(createdOrders[0].draftOrder);
        outputLines.push(`**Total:** ${currency} $${total.toFixed(2)} (${totalUnits} units)`);
      }
      outputLines.push('');
      outputLines.push(`**Shipping:** Free`);
      outputLines.push('');
      outputLines.push(`⏳ **ACTION REQUIRED:** Show this entire preview to the user and wait for their approval before proceeding.`);
      outputLines.push(`To confirm, call create_wholesale_order with confirmed=true and draft_order_ids=${JSON.stringify(draftOrderIds)}.`);

      return { content: [{ type: 'text', text: outputLines.join('\n') }] };
    },
  },
];

/**
 * Split items into the fewest possible orders, each under the threshold.
 * Optimizes for keeping same product/color/consecutive sizes together.
 *
 * Rules:
 * - Never split the same variant (product+color+size) across orders
 * - Keep same product+color together in one order when possible
 * - Keep same product across colors together when possible
 * - Sort by product → color → size within each order for clean display
 *
 * Algorithm:
 * 1. Group items by product, then by product+color
 * 2. Calculate minimum bins needed: ceil(total / threshold)
 * 3. Best-fit decreasing bin-pack at the product+color group level
 *    (place each group in the bin with the least remaining space that still fits)
 * 4. If a product+color group is too large, split by individual items into
 *    bins that already contain the same product (to keep the product together)
 * 5. Sort items within each bin: product → color → size (size-aware numeric sort)
 */
function splitForDeMinimis(items, threshold) {
  const total = items.reduce((sum, r) => sum + r.lineTotal, 0);
  if (total <= threshold) return [items];

  // Size ordering for display (numeric first, then letter sizes)
  const SIZE_ORDER = ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16',
    'XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X', '5X'];

  function sizeRank(variantTitle) {
    const size = (variantTitle || '').split('/').pop().trim();
    const idx = SIZE_ORDER.indexOf(size);
    return idx >= 0 ? idx : 999;
  }

  function sortItems(itemList) {
    return itemList.sort((a, b) => {
      const pA = a.productTitle || '';
      const pB = b.productTitle || '';
      if (pA !== pB) return pA.localeCompare(pB);
      const cA = (a.variantTitle || '').split('/')[0].trim();
      const cB = (b.variantTitle || '').split('/')[0].trim();
      if (cA !== cB) return cA.localeCompare(cB);
      return sizeRank(a.variantTitle) - sizeRank(b.variantTitle);
    });
  }

  // Group items by product + color
  const groupMap = new Map();
  for (const item of items) {
    const product = item.productTitle || '';
    const variant = item.variantTitle || '';
    const color = variant.split('/')[0].trim();
    const key = `${product}|||${color}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { product, color, key, items: [], total: 0 });
    }
    const group = groupMap.get(key);
    group.items.push(item);
    group.total += item.lineTotal;
  }

  // Sort groups by total descending (largest placed first for better balance)
  const groups = [...groupMap.values()].sort((a, b) => b.total - a.total);

  // Calculate minimum bins needed and target per bin
  const minBins = Math.ceil(total / threshold);
  const bins = Array.from({ length: minBins }, () => ({ items: [], total: 0 }));

  // Least-loaded strategy: place each group in the emptiest bin that can hold it.
  // This balances totals evenly across bins while respecting the threshold cap.
  function findLeastLoadedBin(amount) {
    let bestIdx = -1;
    let lowestTotal = Infinity;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i].total + amount <= threshold && bins[i].total < lowestTotal) {
        bestIdx = i;
        lowestTotal = bins[i].total;
      }
    }
    return bestIdx;
  }

  for (const group of groups) {
    if (group.total <= threshold) {
      let bestIdx = findLeastLoadedBin(group.total);

      if (bestIdx === -1) {
        // No bin has room — open a new one
        bins.push({ items: [], total: 0 });
        bestIdx = bins.length - 1;
      }

      bins[bestIdx].items.push(...group.items);
      bins[bestIdx].total += group.total;
    } else {
      // Group exceeds threshold — split individual items
      // Prefer bins that already contain the same product, then least-loaded
      const sortedItems = [...group.items].sort((a, b) => b.lineTotal - a.lineTotal);
      for (const item of sortedItems) {
        // First pass: least-loaded bin with same product
        let bestIdx = -1;
        let lowestTotal = Infinity;
        for (let i = 0; i < bins.length; i++) {
          if (bins[i].total + item.lineTotal <= threshold && bins[i].total < lowestTotal) {
            if (bins[i].items.some(bi => bi.productTitle === item.productTitle) || bins[i].items.length === 0) {
              bestIdx = i;
              lowestTotal = bins[i].total;
            }
          }
        }

        // Second pass: any least-loaded bin with room
        if (bestIdx === -1) {
          bestIdx = findLeastLoadedBin(item.lineTotal);
        }

        if (bestIdx === -1) {
          bins.push({ items: [item], total: item.lineTotal });
        } else {
          bins[bestIdx].items.push(item);
          bins[bestIdx].total += item.lineTotal;
        }
      }
    }
  }

  // Sort items within each bin: product → color → size
  for (const bin of bins) {
    sortItems(bin.items);
  }

  return bins.map(b => b.items).filter(b => b.length > 0);
}

async function resolveItems(items) {
  const resolved = [];

  for (const item of items) {
    const quantity = item.quantity || 1;

    if (item.variant_id) {
      const variantGid = normalizeGid(item.variant_id, 'ProductVariant');
      const cached = getVariantById(variantGid);
      resolved.push({
        variantId: variantGid,
        productTitle: cached ? cached.productTitle : '(by ID)',
        variantTitle: cached ? cached.variantTitle : item.variant_id,
        sku: cached ? cached.sku : null,
        price: cached ? cached.price : (item.price || '0'),
        quantity,
      });
    } else if (item.query) {
      const results = searchProducts(item.query);
      if (results.length === 0) {
        return { error: `No products found matching "${item.query}". Try a different search.` };
      }
      const best = results[0];
      resolved.push({
        variantId: best.variantId,
        productTitle: best.productTitle,
        variantTitle: best.variantTitle,
        sku: best.sku,
        price: best.price,
        quantity,
      });
    } else {
      return { error: 'Each item must have either variant_id or query' };
    }
  }

  return resolved;
}

module.exports = tools;
