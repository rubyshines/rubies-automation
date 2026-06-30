/**
 * Edit order tool: edit_order
 * Edits unfulfilled Shopify orders by swapping, removing, or adding line items,
 * preserving discounts, and handling price differences (invoice or refund).
 * Two-phase flow: Phase 1 stages edit + shows preview, Phase 2 commits.
 * Requires order to be unfulfilled and NOT in-progress at Warehance.
 */

const {
  getOrderForEdit,
  orderEditBegin,
  orderEditSetQuantity,
  orderEditAddVariant,
  orderEditAddLineItemDiscount,
  orderEditCommit,
  sendOrderInvoice,
  calculateRefund,
  createRefund,
  getAdminUrl,
  normalizeGid,
  shopifyGraphQL,
  updateOrderShippingAddress,
} = require('../shopify');
const { searchProducts } = require('../productCache');
const { fetchOrderByNumber, setWarehouseHold, releaseWarehouseHold, warehanceOrderUrl, fetchShippingMethods, updateShippingMethod } = require('../../../reports/lib/warehanceClient');
const { getShippingZone } = require('./shippingLookup');
const { writeAuditEntry } = require('./adminTools');
const { toCountryCode } = require('../addressUtils');

/**
 * Given a list of Warehance shipping methods and a destination zone + speed,
 * return the best-matching method. Zone is one of: us, canada, ddp, ddu.
 * Falls back to the first candidate if no speed-specific match is found.
 */
function matchWarehanceShippingMethod(methods, zone, isExpedited) {
  const nm = m => (m.name || m.title || '').toLowerCase();
  const candidates = methods.filter(m => {
    const n = nm(m);
    if (zone === 'us')     return !n.includes('canada') && !n.includes('international') && !n.includes('passport');
    if (zone === 'canada') return n.includes('canada');
    if (zone === 'ddp')    return n.includes('passport') || n.includes('ddp') || (n.includes('duties') && n.includes('international'));
    if (zone === 'ddu')    return n.includes('ddu') || (n.includes('international') && !n.includes('duties') && !n.includes('ddp'));
    return false;
  });
  if (!candidates.length) return null;
  if (isExpedited) return candidates.find(m => nm(m).includes('expedited')) || candidates[0];
  return candidates.find(m => !nm(m).includes('expedited')) || candidates[0];
}

// Server-side store for pending edit data (MCP can't round-trip custom fields)
const pendingEdits = new Map();

/**
 * Calculate effective discount percentage on a line item from its allocations.
 */
function getLineItemDiscountPercent(lineItem) {
  const allocations = lineItem.discountAllocations || [];
  if (!allocations.length) return 0;

  const originalUnitPrice = parseFloat(lineItem.originalUnitPriceSet?.shopMoney?.amount || '0');
  const quantity = lineItem.quantity || 1;
  const originalLineTotal = originalUnitPrice * quantity;
  if (originalLineTotal === 0) return 0;

  const totalAllocated = allocations.reduce((sum, da) => {
    return sum + parseFloat(da.allocatedAmountSet?.shopMoney?.amount || '0');
  }, 0);

  return Math.round((totalAllocated / originalLineTotal) * 10000) / 100; // 2 decimal places
}

/**
 * Check if a newly added calculatedLineItem has any discount allocations.
 */
function hasAutoDiscount(calcLineItem) {
  const allocs = calcLineItem?.calculatedDiscountAllocations || [];
  return allocs.some(a => parseFloat(a.allocatedAmountSet?.shopMoney?.amount || '0') > 0);
}

const tools = [
  {
    name: 'edit_order',
    description: [
      'Edit an unfulfilled Shopify order by swapping, removing, or adding line items, and/or updating the shipping address.',
      'Two-phase flow:',
      'Phase 1 (confirmed omitted or false): Validates the order is editable (not fulfilled, not in-progress at Warehance),',
      'stages the edit in Shopify to get exact price calculations, and returns a detailed preview.',
      'Phase 2 (confirmed=true): Commits the staged edit, then auto-sends invoice (if customer owes more) or auto-refunds (if customer is owed money).',
      'IMPORTANT: Present Phase 1 preview to the user and get explicit confirmation before calling Phase 2.',
      'Each swap_items entry can: swap (remove_sku + add_query), remove only (remove_sku, no add), or add only (add_query, no remove_sku).',
      'Discounts from original items are automatically preserved on replacement items. You can also apply a custom discount (percent or fixed amount) to any added item — e.g. discount: { percent: 100 } to make it free.',
      'Use dry_run=true to test without committing (safe on any order).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Order number (e.g. "29338", "#29338")',
        },
        swap_items: {
          type: 'array',
          description: 'Items to swap/remove/add. Each entry can have remove_sku (to remove), add_query or add_variant_id (to add), or both (to swap).',
          items: {
            type: 'object',
            properties: {
              remove_sku: { type: 'string', description: 'SKU of the item to remove (optional — omit for add-only)' },
              remove_quantity: { type: 'number', description: 'Quantity to remove (default: all of that line item)' },
              add_query: { type: 'string', description: 'Product search query for replacement/addition (e.g. "Pink AJ Medium")' },
              add_variant_id: { type: 'string', description: 'Variant ID of replacement item (if known, skips search)' },
              add_quantity: { type: 'number', description: 'Quantity to add (default: same as removed, or 1 for add-only)' },
              even_swap: { type: 'boolean', description: 'If true, auto-calculates discount on the added item so the swap is cost-neutral (new item priced same as the removed item after discounts). Requires both remove_sku and add_query/add_variant_id.' },
              discount: {
                type: 'object',
                description: 'Custom discount to apply to the added item. Use percent (e.g. 100 for free) or fixed_amount (per-item dollar amount off). Overrides preserved discount from removed item. Ignored if even_swap is true.',
                properties: {
                  percent: { type: 'number', description: 'Percentage discount (e.g. 100 = free, 50 = half price)' },
                  fixed_amount: { type: 'number', description: 'Fixed dollar amount off per item' },
                  description: { type: 'string', description: 'Reason for discount (shown in Shopify admin)' },
                },
              },
            },
          },
        },
        shipping_address: {
          type: 'object',
          description: 'Update shipping address. Can be used alone (address-only update) or with swap_items. Fields: address1, address2, city, province, country, zip, first_name, last_name.',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            address1: { type: 'string' },
            address2: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            country: { type: 'string', description: 'Country code e.g. "US", "CA", "AU"' },
            zip: { type: 'string' },
          },
        },
        note: {
          type: 'string',
          description: 'Staff note for the edit (shown in Shopify admin timeline)',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, stages the full edit in Shopify but skips commit, invoice/refund, and warehouse operations. Safe to run on any order.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to execute the edit (Phase 2). Just pass confirmed=true and order_number — edit data is stored server-side from Phase 1.',
        },
      },
      required: ['order_number'],
    },
    handler: async ({ order_number, swap_items, shipping_address, note, dry_run, confirmed }) => {
      // ---------------------------------------------------------------
      // Phase 2: Commit the staged edit
      // ---------------------------------------------------------------
      if (confirmed) {
        const _edit_data = pendingEdits.get(order_number);
        if (!_edit_data) {
          return { content: [{ type: 'text', text: `Error: No pending edit found for order ${order_number}. Run Phase 1 first.` }] };
        }

        const lines = [];

        // Place warehouse hold if order is at Warehance
        let holdPlaced = false;
        if (_edit_data.warehance_order_id) {
          try {
            await setWarehouseHold(_edit_data.warehance_order_id);
            holdPlaced = true;
          } catch (e) {
            lines.push(`**Warning:** Could not place warehouse hold: ${e.message}. Proceeding with edit.`);
          }
        }

        // Commit the edit
        const committedOrder = await orderEditCommit(
          _edit_data.calculated_order_id,
          note || _edit_data.note || 'Order edited via CS MCP tool',
        );

        // Update shipping address if provided alongside item edits
        if (shipping_address) {
          const addrInput = {};
          if (shipping_address.first_name) addrInput.firstName = shipping_address.first_name;
          if (shipping_address.last_name) addrInput.lastName = shipping_address.last_name;
          if (shipping_address.address1) addrInput.address1 = shipping_address.address1;
          if (shipping_address.address2 !== undefined) addrInput.address2 = shipping_address.address2 || '';
          if (shipping_address.city) addrInput.city = shipping_address.city;
          if (shipping_address.province) addrInput.province = shipping_address.province;
          if (shipping_address.country) addrInput.countryCode = toCountryCode(shipping_address.country);
          if (shipping_address.zip) addrInput.zip = shipping_address.zip;
          await updateOrderShippingAddress(committedOrder.id, addrInput);
        }

        lines.push('**Order Edit Completed**', '');
        lines.push(`**Order:** ${committedOrder.name} — ${getAdminUrl(committedOrder.id)}`);

        // Show what changed
        for (const swap of _edit_data.swaps) {
          if (swap.remove_title) {
            lines.push(`  Removed: ${swap.remove_quantity}x ${swap.remove_title}`);
          }
          if (swap.add_title) {
            lines.push(`  Added: ${swap.add_quantity}x ${swap.add_title}${swap.discount_applied ? ` (${swap.discount_description})` : ''}`);
          }
        }
        lines.push('');

        // Handle price difference using Shopify's calculated amounts
        const originalTotal = parseFloat(committedOrder.totalPriceSet.shopMoney.amount);
        const currentTotal = parseFloat(committedOrder.currentTotalPriceSet.shopMoney.amount);
        const currency = committedOrder.totalPriceSet.shopMoney.currencyCode;
        const hasEvenSwaps = _edit_data.swaps.some(s => s.even_swap);
        const delta = hasEvenSwaps ? 0 : currentTotal - originalTotal;

        if (delta > 0.01) {
          // Customer owes more — send invoice
          try {
            await sendOrderInvoice(committedOrder.id);
            lines.push(`**Customer owes:** $${delta.toFixed(2)} ${currency}`);
            lines.push('**Invoice:** Sent to customer via email');
          } catch (e) {
            lines.push(`**Customer owes:** $${delta.toFixed(2)} ${currency}`);
            lines.push(`**Invoice:** Failed to send (${e.message}). Send manually from Shopify admin.`);
          }
        } else if (delta < -0.01) {
          // Customer is owed a refund
          const refundAmount = Math.abs(delta).toFixed(2);
          try {
            const suggestedData = await shopifyGraphQL(`
              query suggestedRefund($id: ID!) {
                order(id: $id) {
                  suggestedRefund(suggestFullRefund: false, refundShipping: false) {
                    amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
                    suggestedTransactions {
                      gateway
                      parentTransaction { id }
                      amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
                    }
                  }
                }
              }
            `, { id: committedOrder.id });

            const suggested = suggestedData.order.suggestedRefund;
            if (suggested.suggestedTransactions.length > 0) {
              const txn = suggested.suggestedTransactions[0];
              await createRefund({
                orderId: committedOrder.id,
                currency: txn.amountSet.presentmentMoney.currencyCode,
                transactions: [{
                  gateway: txn.gateway,
                  parentId: txn.parentTransaction.id,
                  amount: txn.amountSet.presentmentMoney.amount,
                  kind: 'REFUND',
                  orderId: committedOrder.id,
                }],
                notify: true,
                note: note || 'Refund for order edit price difference',
              });
              lines.push(`**Refund:** $${refundAmount} ${currency} refunded to original payment method`);
              lines.push('**Notification:** Sent to customer');
            } else {
              lines.push(`**Refund needed:** $${refundAmount} ${currency} — no suggested transaction found. Process manually.`);
            }
          } catch (e) {
            lines.push(`**Refund needed:** $${refundAmount} ${currency} — auto-refund failed (${e.message}). Process manually from Shopify admin.`);
          }
        } else {
          lines.push('**Price impact:** Even swap — no payment action needed');
        }

        // Release warehouse hold
        if (holdPlaced) {
          try {
            await releaseWarehouseHold(_edit_data.warehance_order_id);
            lines.push('**Warehouse hold:** Released');
          } catch (e) {
            lines.push(`**Warning:** Could not release warehouse hold: ${e.message}. Release manually.`);
          }
        }

        // Audit log
        writeAuditEntry({
          action_type: 'order_edited',
          actor: 'claude_code',
          entity_type: 'order',
          entity_id: committedOrder.name,
          details: {
            order_id: committedOrder.id,
            swaps: _edit_data.swaps.map(s => ({
              removed: s.remove_title ? `${s.remove_quantity}x ${s.remove_title}` : null,
              added: s.add_title ? `${s.add_quantity}x ${s.add_title}` : null,
            })),
            price_delta: delta.toFixed(2),
            note: note || _edit_data.note,
          },
        });

        // Clean up pending edit
        pendingEdits.delete(order_number);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ---------------------------------------------------------------
      // Address-only update (no swap_items needed)
      // ---------------------------------------------------------------
      if (shipping_address && (!swap_items || swap_items.length === 0)) {
        const order = await getOrderForEdit(order_number);
        if (order.displayFulfillmentStatus === 'FULFILLED') {
          return { content: [{ type: 'text', text: `Error: Order ${order.name} is already fulfilled. Cannot update shipping address.` }] };
        }

        const oldCountry = (order.shippingAddress?.countryCodeV2 || '').toUpperCase();
        // Normalize to ISO so a full country name ("United States") isn't mistaken
        // for a cross-border change against the ISO countryCodeV2.
        const newCountry = (toCountryCode(shipping_address.country) || '').toUpperCase();
        const countryChanged = newCountry && oldCountry && newCountry !== oldCountry;

        const addrInput = {};
        if (shipping_address.first_name) addrInput.firstName = shipping_address.first_name;
        if (shipping_address.last_name) addrInput.lastName = shipping_address.last_name;
        if (shipping_address.address1) addrInput.address1 = shipping_address.address1;
        if (shipping_address.address2 !== undefined) addrInput.address2 = shipping_address.address2 || '';
        if (shipping_address.city) addrInput.city = shipping_address.city;
        if (shipping_address.province) addrInput.province = shipping_address.province;
        if (shipping_address.country) addrInput.countryCode = shipping_address.country;
        if (shipping_address.zip) addrInput.zip = shipping_address.zip;

        const updated = await updateOrderShippingAddress(order.id, addrInput);
        const a = updated.shippingAddress;
        const lines = [
          '**Shipping Address Updated**',
          '',
          `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
          `**New address:** ${[a.address1, a.address2, a.city, `${a.province || ''} ${a.zip || ''}`, a.country].filter(Boolean).join(', ')}`,
        ];

        // Fetch the Warehance order once for two post-update tasks:
        //   1. On a country change, correct the shipping method to the new zone
        //      (Shopify's shipping line title is immutable on placed orders, so
        //      Warehance is the only place to fix routing).
        //   2. Release any warehouse hold that was freezing the order until the
        //      address was fixed — the change is applied now, so it must ship.
        //      Without this, an address change leaves the order held forever
        //      (the order can't ship and nothing else releases it).
        try {
          const orderNum = order.name.replace('#', '');
          const whOrder = await fetchOrderByNumber(orderNum);
          if (whOrder) {
            if (countryChanged) {
              const currentTitle = order.shippingLines?.[0]?.title || '';
              const isExpedited = /expedited/i.test(currentTitle);
              const newZone = await getShippingZone(newCountry);
              const methods = await fetchShippingMethods();
              const match = matchWarehanceShippingMethod(methods, newZone, isExpedited);
              if (match) {
                await updateShippingMethod(whOrder.id, match.id);
                lines.push(`**Warehance shipping:** Updated to "${match.name}"`);
              } else {
                lines.push(`**⚠️ Warehance shipping:** No method matched for zone "${newZone}"/${isExpedited ? 'expedited' : 'standard'} — update manually in Warehance`);
              }
            }
            if (whOrder.warehouse_hold) {
              await releaseWarehouseHold(whOrder.id);
              lines.push('**Warehouse hold:** Released — the address change is applied, so the order can ship.');
            }
          }
          // If whOrder is null, the order hasn't reached Warehance yet — no action needed.
        } catch (e) {
          lines.push(`**⚠️ Warehance:** Post-update step failed (${e.message}) — check the shipping method / hold manually in Warehance`);
        }

        writeAuditEntry({
          action_type: 'address_updated',
          actor: 'claude_code',
          entity_type: 'order',
          entity_id: order.name,
          details: { order_id: order.id, new_address: addrInput, country_changed: countryChanged, note },
        });

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // ---------------------------------------------------------------
      // Phase 1: Validate, stage edit, preview
      // ---------------------------------------------------------------
      if (!swap_items || swap_items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: swap_items or shipping_address required. Provide [{ remove_sku, add_query }] to swap, [{ remove_sku }] to remove, [{ add_query }] to add items, or shipping_address to update the address.' }] };
      }

      // Validate each swap has at least a remove or add operation
      for (const swap of swap_items) {
        if (!swap.remove_sku && !swap.add_query && !swap.add_variant_id) {
          return { content: [{ type: 'text', text: 'Error: Each swap_items entry must have at least remove_sku (to remove) or add_query/add_variant_id (to add).' }] };
        }
      }

      // 1. Fetch order with discount data
      const order = await getOrderForEdit(order_number);

      // 2. Validate editability
      if (order.cancelledAt) {
        return { content: [{ type: 'text', text: `Error: Order ${order.name} is cancelled and cannot be edited.` }] };
      }
      if (order.displayFulfillmentStatus === 'FULFILLED') {
        return { content: [{ type: 'text', text: `Error: Order ${order.name} is already fulfilled. Use create_exchange_order for post-fulfillment exchanges.` }] };
      }
      if (order.displayFinancialStatus === 'REFUNDED') {
        return { content: [{ type: 'text', text: `Error: Order ${order.name} is fully refunded and cannot be edited.` }] };
      }

      // 3. Check Warehance
      let whOrder = null;
      let warehanceOrderId = null;
      try {
        const orderNum = order.name.replace('#', '');
        whOrder = await fetchOrderByNumber(orderNum);
        if (whOrder) {
          if (whOrder.fulfillment_status === 'in_progress') {
            return { content: [{ type: 'text', text: `Error: Order ${order.name} is currently being picked/packed at the warehouse (status: in_progress) and cannot be edited. Contact the warehouse directly.` }] };
          }
          warehanceOrderId = whOrder.id;
        }
      } catch (e) {
        // Warehance check is best-effort
        console.error('[editOrder] Warehance check failed:', e.message);
      }

      // 4. Build swap plan — resolve SKUs and product searches
      const swapPlan = [];
      for (const swap of swap_items) {
        let removeLineItemId = null;
        let removeSku = null;
        let removeQty = 0;
        let removeTitle = null;
        let removeUnitPrice = '0';
        let discountPercent = 0;

        // Handle remove side
        if (swap.remove_sku) {
          removeSku = swap.remove_sku;
          const matchedLine = order.lineItems.find(li => li.sku === removeSku);
          if (!matchedLine) {
            const available = order.lineItems.map(li => `${li.sku} (${li.title} - ${li.variantTitle})`).join(', ');
            return { content: [{ type: 'text', text: `Error: SKU "${removeSku}" not found in order ${order.name}. Available: ${available}` }] };
          }

          removeQty = swap.remove_quantity || matchedLine.quantity;
          if (removeQty > matchedLine.quantity) {
            return { content: [{ type: 'text', text: `Error: Cannot remove ${removeQty} of SKU "${removeSku}" — order only has ${matchedLine.quantity}.` }] };
          }

          removeLineItemId = matchedLine.id;
          removeTitle = `${matchedLine.title}${matchedLine.variantTitle ? ` - ${matchedLine.variantTitle}` : ''}`;
          removeUnitPrice = matchedLine.originalUnitPriceSet?.shopMoney?.amount || '0';
          discountPercent = getLineItemDiscountPercent(matchedLine);
        }

        // Handle add side
        let addVariantId = null;
        let addTitle = null;
        let addPrice = '0';
        let addQty = 0;
        let addInventory = undefined;

        if (swap.add_variant_id || swap.add_query) {
          addVariantId = swap.add_variant_id;
          if (!addVariantId) {
            const results = searchProducts(swap.add_query);
            if (!results.length) {
              return { content: [{ type: 'text', text: `Error: No products found matching "${swap.add_query}". Try a different search.` }] };
            }
            const bestMatch = results[0];
            addVariantId = bestMatch.variantId;
            addTitle = `${bestMatch.productTitle} - ${bestMatch.variantTitle}`;
            addPrice = bestMatch.price;
            addInventory = bestMatch.inventoryQuantity;
          } else {
            addVariantId = normalizeGid(addVariantId, 'ProductVariant');
            addTitle = `Variant ${addVariantId}`;
            addPrice = 'TBD';
          }
          addQty = swap.add_quantity || removeQty || 1;
        }

        swapPlan.push({
          remove_line_item_id: removeLineItemId,
          remove_sku: removeSku,
          remove_quantity: removeQty,
          remove_title: removeTitle,
          remove_unit_price: removeUnitPrice,
          add_variant_id: addVariantId,
          add_quantity: addQty,
          add_title: addTitle,
          add_price: addPrice,
          add_inventory: addInventory,
          discount_percent: discountPercent,
          even_swap: swap.even_swap || false,
          custom_discount: swap.discount || null,
        });
      }

      // 5. Stage the edit in Shopify (begin → mutations)
      const calcOrder = await orderEditBegin(order.id);

      const stagedSwaps = [];
      for (const swap of swapPlan) {
        // Remove side
        if (swap.remove_sku) {
          const calcLineItem = calcOrder.lineItems.find(cli =>
            cli.sku === swap.remove_sku ||
            cli.variant?.id === order.lineItems.find(li => li.id === swap.remove_line_item_id)?.variant?.id
          );

          if (!calcLineItem) {
            return { content: [{ type: 'text', text: `Error: Could not find calculated line item for SKU "${swap.remove_sku}" in edit session.` }] };
          }

          const newQty = calcLineItem.quantity - swap.remove_quantity;
          await orderEditSetQuantity(calcOrder.id, calcLineItem.id, Math.max(0, newQty));
        }

        // Add side
        let addedLineItem = null;
        if (swap.add_variant_id) {
          const addResult = await orderEditAddVariant(calcOrder.id, swap.add_variant_id, swap.add_quantity);
          addedLineItem = addResult.calculatedLineItem;

          // Update title and price from Shopify's response
          if (addedLineItem) {
            swap.add_title = `${addedLineItem.title}${addedLineItem.variantTitle ? ` - ${addedLineItem.variantTitle}` : ''}`;
            if (addedLineItem.originalUnitPriceSet?.shopMoney?.amount) {
              swap.add_price = addedLineItem.originalUnitPriceSet.shopMoney.amount;
            }
          }

          // Apply discount: even_swap (deterministic) > custom discount > preserved discount
          let discountApplied = false;
          let discountDescription = '';

          if (swap.even_swap && addedLineItem && swap.remove_sku) {
            // Deterministic: calculate exact discount to make swap cost-neutral
            const removedEffective = parseFloat(swap.remove_unit_price) * (1 - swap.discount_percent / 100);
            const addedPrice = parseFloat(addedLineItem.originalUnitPriceSet?.shopMoney?.amount || swap.add_price);
            const discountNeeded = addedPrice - removedEffective;

            if (discountNeeded > 0.01) {
              try {
                // Round to 2 decimals for Shopify
                const fixedOff = Math.round(discountNeeded * 100) / 100;
                const currency = order.totalPriceSet.shopMoney.currencyCode;
                await orderEditAddLineItemDiscount(calcOrder.id, addedLineItem.id, {
                  description: `Even swap discount — matching original item price`,
                  fixedValue: { amount: fixedOff.toFixed(2), currencyCode: currency },
                });
                discountApplied = true;
                discountDescription = `$${fixedOff.toFixed(2)} off (even swap)`;
                // Store as custom_discount for preview/estimate consistency
                swap.custom_discount = { fixed_amount: fixedOff, description: 'Even swap' };
              } catch (e) {
                discountDescription = `Failed to apply even swap discount: ${e.message}`;
              }
            } else if (discountNeeded < -0.01) {
              // New item is cheaper — no discount needed, swap saves money
              discountDescription = 'New item is cheaper — no discount needed';
            } else {
              // Prices already match
              discountDescription = 'Prices already match';
            }
          } else if (swap.custom_discount && addedLineItem) {
            // Custom discount specified by caller
            const cd = swap.custom_discount;
            try {
              const discountInput = {
                description: cd.description || 'Custom discount applied via order edit',
              };
              if (cd.percent != null) {
                discountInput.percentValue = cd.percent;
              } else if (cd.fixed_amount != null) {
                const currency = order.totalPriceSet.shopMoney.currencyCode;
                discountInput.fixedValue = { amount: cd.fixed_amount.toFixed(2), currencyCode: currency };
              }
              await orderEditAddLineItemDiscount(calcOrder.id, addedLineItem.id, discountInput);
              discountApplied = true;
              if (cd.percent != null) {
                discountDescription = `${cd.percent}% off (custom)`;
              } else {
                discountDescription = `$${cd.fixed_amount} off (custom)`;
              }
            } catch (e) {
              discountDescription = `Failed to apply custom discount: ${e.message}`;
            }
          } else if (swap.discount_percent > 0 && addedLineItem) {
            if (hasAutoDiscount(addedLineItem)) {
              discountApplied = true;
              discountDescription = 'Auto-applied by Shopify';
            } else {
              try {
                await orderEditAddLineItemDiscount(calcOrder.id, addedLineItem.id, {
                  description: `Discount preserved from original item (${swap.discount_percent}% off)`,
                  percentValue: swap.discount_percent,
                });
                discountApplied = true;
                discountDescription = `${swap.discount_percent}% off (preserved from original)`;
              } catch (e) {
                discountDescription = `Failed to apply discount: ${e.message}`;
              }
            }
          }

          swap.discount_applied = discountApplied;
          swap.discount_description = discountDescription;
        }

        stagedSwaps.push({
          ...swap,
          calculated_line_item_id: addedLineItem?.id,
        });
      }

      // 6. Read the calculated order totals from Shopify
      const calcState = await shopifyGraphQL(`
        query getCalculatedOrder($id: ID!) {
          node(id: $id) {
            ... on CalculatedOrder {
              id
              originalOrder {
                id
                name
                totalPriceSet { shopMoney { amount currencyCode } }
                currentTotalPriceSet { shopMoney { amount currencyCode } }
              }
              addedLineItems(first: 50) {
                edges {
                  node { id title variantTitle quantity }
                }
              }
            }
          }
        }
      `, { id: calcOrder.id });

      const originalTotal = parseFloat(order.totalPriceSet.shopMoney.amount);
      const currency = order.totalPriceSet.shopMoney.currencyCode;

      // Build edit data for Phase 2
      const editData = {
        order_id: order.id,
        order_name: order.name,
        customer_email: order.customer?.email,
        calculated_order_id: calcOrder.id,
        warehance_order_id: warehanceOrderId,
        swaps: stagedSwaps,
        note: note || null,
      };

      // 7. Build preview output
      const lines = [];
      if (dry_run) {
        lines.push('**Order Edit DRY RUN — No changes will be made**', '');
      } else {
        lines.push('**Order Edit Preview — Awaiting Confirmation**', '');
      }

      lines.push(`**Order:** ${order.name} — ${getAdminUrl(order.id)}`);
      lines.push(`**Customer:** ${order.customer?.firstName || ''} ${order.customer?.lastName || ''} (${order.customer?.email || 'no email'})`.trim());
      lines.push(`**Status:** ${order.displayFulfillmentStatus} / ${order.displayFinancialStatus}`);
      lines.push(`**Current Total:** $${originalTotal.toFixed(2)} ${currency}`);

      if (order.discountCodes?.length) {
        lines.push(`**Discount Codes:** ${order.discountCodes.join(', ')}`);
      }

      if (whOrder) {
        const whUrl = warehanceOrderUrl(whOrder);
        lines.push(`**Warehance:** ${whOrder.fulfillment_status}${whUrl ? ` — ${whUrl}` : ''}`);
        if (!dry_run) lines.push('  → Warehouse hold will be placed during edit');
      }

      lines.push('', '**Changes:**');
      for (const swap of stagedSwaps) {
        if (swap.remove_title) {
          const removePrice = parseFloat(swap.remove_unit_price);
          let removePriceStr = `$${removePrice.toFixed(2)} each`;
          if (swap.discount_percent > 0) {
            const discountedRemove = removePrice * (1 - swap.discount_percent / 100);
            removePriceStr += ` (${swap.discount_percent}% off = $${discountedRemove.toFixed(2)})`;
          }
          lines.push(`  REMOVE: ${swap.remove_quantity}x ${swap.remove_title} — ${removePriceStr}`);
        }

        if (swap.add_title) {
          const addPrice = parseFloat(swap.add_price);
          let addPriceStr = `$${addPrice.toFixed(2)} each`;
          if (swap.discount_applied && swap.discount_description) {
            // Calculate effective price after discount
            let discountedAdd;
            if (swap.custom_discount?.percent != null) {
              discountedAdd = addPrice * (1 - swap.custom_discount.percent / 100);
            } else if (swap.custom_discount?.fixed_amount != null) {
              discountedAdd = Math.max(0, addPrice - swap.custom_discount.fixed_amount);
            } else if (swap.discount_percent > 0) {
              discountedAdd = addPrice * (1 - swap.discount_percent / 100);
            }
            if (discountedAdd != null) {
              addPriceStr += ` (${swap.discount_description} = $${discountedAdd.toFixed(2)})`;
            }
          }
          lines.push(`  ADD:    ${swap.add_quantity}x ${swap.add_title} — ${addPriceStr}`);
          if (swap.add_inventory != null && swap.add_inventory < swap.add_quantity) {
            lines.push(`  ⚠️ **INSUFFICIENT STOCK** — only ${swap.add_inventory} available (need ${swap.add_quantity})`);
          }
        }
        lines.push('');
      }

      // Price delta estimate
      let estimatedDelta = 0;
      for (const swap of stagedSwaps) {
        const preservedMult = swap.discount_percent > 0 ? (1 - swap.discount_percent / 100) : 1;
        if (swap.remove_title) {
          const removePrice = parseFloat(swap.remove_unit_price);
          estimatedDelta -= removePrice * preservedMult * swap.remove_quantity;
        }
        if (swap.add_title) {
          const addPrice = parseFloat(swap.add_price);
          let effectiveAdd = addPrice;
          if (swap.discount_applied && swap.custom_discount?.percent != null) {
            effectiveAdd = addPrice * (1 - swap.custom_discount.percent / 100);
          } else if (swap.discount_applied && swap.custom_discount?.fixed_amount != null) {
            effectiveAdd = Math.max(0, addPrice - swap.custom_discount.fixed_amount);
          } else if (swap.discount_applied) {
            effectiveAdd = addPrice * preservedMult;
          }
          estimatedDelta += effectiveAdd * swap.add_quantity;
        }
      }

      if (Math.abs(estimatedDelta) < 0.01) {
        lines.push('**Estimated Price Impact:** Even swap — no payment action needed');
      } else if (estimatedDelta > 0) {
        lines.push(`**Estimated Price Impact:** Customer owes ~$${estimatedDelta.toFixed(2)} ${currency} more`);
        lines.push('  → Invoice will be sent to customer automatically');
      } else {
        lines.push(`**Estimated Price Impact:** Customer is owed ~$${Math.abs(estimatedDelta).toFixed(2)} ${currency} refund`);
        lines.push('  → Refund will be processed automatically');
      }

      lines.push('');
      lines.push('*Note: Final amounts are calculated by Shopify after commit (may differ slightly due to tax recalculation).*');

      if (dry_run) {
        lines.push('', '**DRY RUN complete.** The staged edit has NOT been committed and will be auto-cleaned by Shopify.');
      } else {
        // Store edit data server-side for Phase 2 retrieval
        pendingEdits.set(order_number, editData);
        lines.push('', `To confirm, call edit_order again with confirmed=true and order_number="${order_number}".`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  },
];

module.exports = tools;
// Named export of the edit_order handler so the intake auto-apply of
// same-country address changes (processGorgiasTickets.autoExecuteAddressChange)
// can call it directly with { order_number, shipping_address }.
module.exports.handleEditOrder = tools.find((t) => t.name === 'edit_order').handler;
