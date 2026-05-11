/**
 * Consolidate orders tool: consolidate_orders
 *
 * Merges two unfulfilled orders for the same customer into one shipment without
 * cancelling/refunding either. Adds the dropped order's items onto the keeper
 * at 100% discount (the customer already paid for them on the dropped order),
 * placeholder-fulfills the dropped order so the warehouse stops processing it,
 * and (if the combined product subtotal meets the destination's free-shipping
 * threshold) refunds the shipping fee that was paid on each order.
 *
 * Two-phase: phase 1 previews; phase 2 (confirmed=true) executes.
 */

const {
  shopifyGraphQL,
  getOrderForEdit,
  getOrderWithFulfillmentOrders,
  orderEditBegin,
  orderEditAddVariant,
  orderEditAddLineItemDiscount,
  orderEditCommit,
  createFulfillment,
  createRefund,
  addTags,
  appendOrderNote,
  getAdminUrl,
} = require('../shopify');
const { getShippingZone } = require('./shippingLookup');
const { fetchOrderByNumber, setWarehouseHold, releaseWarehouseHold } = require('../../../reports/lib/warehanceClient');
const { writeAuditEntry } = require('./adminTools');

const KEEPER_TAG = 'consolidated-keeper';
const DROPPED_TAG = 'consolidated-dropped';
const FREE_DISCOUNT_DESCRIPTION = 'Already paid via consolidated order';

const pendingConsolidations = new Map();

/**
 * Decide whether to refund shipping on each order, given combined product
 * subtotal vs the destination's free-shipping threshold.
 *
 * Pure function — exported for unit tests.
 */
function planShippingRefunds({ keeperSubtotal, dropSubtotal, threshold, keeperShipping, dropShipping }) {
  const combined = (Number(keeperSubtotal) || 0) + (Number(dropSubtotal) || 0);
  if (threshold == null || threshold <= 0) {
    return { refundShipping: false, reason: 'no free-shipping threshold for destination', combined, threshold };
  }
  if (combined < threshold) {
    return {
      refundShipping: false,
      reason: `combined product subtotal ${combined.toFixed(2)} is below free-shipping threshold ${Number(threshold).toFixed(2)}`,
      combined,
      threshold,
    };
  }
  return {
    refundShipping: true,
    reason: `combined product subtotal ${combined.toFixed(2)} >= free-shipping threshold ${Number(threshold).toFixed(2)}`,
    combined,
    threshold,
    keeperHasShipping: Number(keeperShipping) > 0.01,
    dropHasShipping: Number(dropShipping) > 0.01,
  };
}

/**
 * Fetch shipping line totals + suggested-shipping-refund details for an order.
 */
async function getOrderShippingRefundContext(orderId) {
  const data = await shopifyGraphQL(`
    query orderShippingRefund($id: ID!) {
      order(id: $id) {
        currentShippingPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
        suggestedRefund(suggestFullRefund: false, refundShipping: true) {
          amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          shipping {
            amountSet { shopMoney { amount currencyCode } }
            taxSet { shopMoney { amount currencyCode } }
          }
          suggestedTransactions {
            gateway
            parentTransaction { id }
            amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          }
        }
      }
    }
  `, { id: orderId });
  const order = data.order || {};
  return {
    currentShipping: parseFloat(order.currentShippingPriceSet?.shopMoney?.amount || '0'),
    totalShipping: parseFloat(order.totalShippingPriceSet?.shopMoney?.amount || '0'),
    suggested: order.suggestedRefund,
  };
}

function customerName(c) {
  return [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim() || '(no name)';
}

function lineSummary(li) {
  return `${li.quantity}x ${li.title}${li.variantTitle ? ` — ${li.variantTitle}` : ''} (${li.sku || 'no sku'})`;
}

const tools = [
  {
    name: 'consolidate_orders',
    description: [
      'Merge two unfulfilled Shopify orders for the same customer into one shipment without cancelling or refunding either.',
      'Adds the dropped order\'s items onto the keeper at 100% discount (the customer already paid on the dropped order), placeholder-fulfills the dropped order so the warehouse stops processing it, and tags/notes both orders cross-referencing each other.',
      'If the combined product subtotal (pre-merge) of both orders meets the keeper destination\'s free-shipping threshold, refunds the shipping fee paid on each order (with tax).',
      'Both orders must belong to the same customer, both must be unfulfilled and not cancelled, and neither can be in_progress at the warehouse.',
      'The dropped order must have no real (non-placeholder) fulfillments — partial-fulfilled orders are refused.',
      'Two-phase: phase 1 (confirmed omitted/false) previews; phase 2 (confirmed=true) executes. You MUST present phase 1 to the operator and receive explicit confirmation before calling phase 2.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        keep_order_number: { type: 'string', description: 'Order number that will absorb the items and ship combined (e.g. "30637")' },
        drop_order_number: { type: 'string', description: 'Order number whose items move to the keeper and which will be placeholder-fulfilled (e.g. "30638")' },
        staff_note: { type: 'string', description: 'Optional additional context appended to both order notes' },
        confirmed: { type: 'boolean', description: 'Set true in phase 2 to execute' },
      },
      required: ['keep_order_number', 'drop_order_number'],
    },
    handler: async ({ keep_order_number, drop_order_number, staff_note, confirmed }) => {
      // ---------------------------------------------------------------
      // Phase 2: Execute
      // ---------------------------------------------------------------
      if (confirmed) {
        const key = `${keep_order_number}|${drop_order_number}`;
        const plan = pendingConsolidations.get(key);
        if (!plan) {
          return { content: [{ type: 'text', text: `Error: No pending consolidation found for ${keep_order_number} ← ${drop_order_number}. Run phase 1 first.` }] };
        }

        const lines = [];
        let holdPlaced = false;

        // 1. Hold keeper at warehouse if it's there
        if (plan.keeper_warehance_id) {
          try {
            await setWarehouseHold(plan.keeper_warehance_id);
            holdPlaced = true;
          } catch (e) {
            lines.push(`**Warning:** Could not place warehouse hold on keeper: ${e.message}. Proceeding.`);
          }
        }

        // 2. Commit the order edit on keeper (no customer email — they didn't ask for changes)
        const committed = await orderEditCommit(
          plan.calculated_order_id,
          staff_note ? `Consolidated from ${plan.drop_name}. ${staff_note}` : `Consolidated from ${plan.drop_name}`,
          { notifyCustomer: false },
        );

        // 3. Placeholder-fulfill the dropped order
        let droppedFulfillmentId = null;
        try {
          const ff = await createFulfillment({
            lineItemsByFulfillmentOrder: plan.drop_line_items_by_fo,
            notifyCustomer: false,
          });
          droppedFulfillmentId = ff?.id || null;
        } catch (e) {
          // Edit on keeper has already committed. Surface a clear recovery instruction.
          if (holdPlaced) {
            try { await releaseWarehouseHold(plan.keeper_warehance_id); } catch {}
          }
          return {
            content: [{
              type: 'text',
              text: [
                '**Partial success — keeper edit committed, dropped order fulfillment FAILED**',
                '',
                `**Keeper:** ${plan.keep_name} — items added (${plan.drop_item_summary}) at 100% discount.`,
                `**Dropped:** ${plan.drop_name} — placeholder fulfillment failed: ${e.message}`,
                '',
                `Recovery: manually mark ${plan.drop_name} fulfilled (Shopify admin → Mark as fulfilled, no tracking, do not notify customer), then add tag \`${DROPPED_TAG}\` and a note "Consolidated into ${plan.keep_name}".`,
              ].join('\n'),
            }],
          };
        }

        // 4. Tag + note both orders
        try {
          await Promise.all([
            addTags(plan.keep_id, [KEEPER_TAG, `consolidated-from-${plan.drop_short}`]),
            addTags(plan.drop_id, [DROPPED_TAG, `consolidated-into-${plan.keep_short}`]),
            appendOrderNote(plan.keep_id, [
              `Consolidated with ${plan.drop_name}: added ${plan.drop_item_summary} at 100% discount (already paid on ${plan.drop_name}).`,
              staff_note || null,
            ].filter(Boolean).join(' — ')),
            appendOrderNote(plan.drop_id, [
              `Merged into ${plan.keep_name}. Placeholder-fulfilled (no shipment from this order); items will ship on ${plan.keep_name}.`,
              staff_note || null,
            ].filter(Boolean).join(' — ')),
          ]);
        } catch (e) {
          lines.push(`**Warning:** Tag/note write failed: ${e.message}. Apply manually.`);
        }

        // 5. Shipping refund (if planned)
        const shippingRefundResults = [];
        if (plan.refund_plan?.refundShipping) {
          for (const target of plan.shipping_refunds) {
            try {
              const refund = await createRefund({
                orderId: target.order_id,
                currency: target.currency,
                transactions: target.transactions.map(t => ({ ...t, orderId: target.order_id })),
                notify: true,
                note: `Shipping refunded — orders ${plan.keep_name} and ${plan.drop_name} consolidated and combined subtotal qualifies for free shipping.`,
              });
              shippingRefundResults.push({ order_name: target.order_name, ok: true, amount: target.amount, currency: target.currency, refund_id: refund?.id });
            } catch (e) {
              shippingRefundResults.push({ order_name: target.order_name, ok: false, error: e.message, amount: target.amount, currency: target.currency });
            }
          }
        }

        // 6. Release warehouse hold
        if (holdPlaced) {
          try {
            await releaseWarehouseHold(plan.keeper_warehance_id);
            lines.push('**Warehouse hold:** Released');
          } catch (e) {
            lines.push(`**Warning:** Could not release warehouse hold: ${e.message}. Release manually.`);
          }
        }

        // 7. Audit
        writeAuditEntry({
          action_type: 'orders_consolidated',
          actor: 'claude_code',
          entity_type: 'order',
          entity_id: plan.keep_name,
          details: {
            keeper: { id: plan.keep_id, name: plan.keep_name },
            dropped: { id: plan.drop_id, name: plan.drop_name },
            items_moved: plan.drop_item_summary,
            dropped_fulfillment_id: droppedFulfillmentId,
            shipping_refund_plan: plan.refund_plan,
            shipping_refund_results: shippingRefundResults,
            note: staff_note,
          },
        });

        pendingConsolidations.delete(key);

        const out = [
          '**Orders Consolidated**',
          '',
          `**Keeper:** ${plan.keep_name} — ${getAdminUrl(plan.keep_id)}`,
          `  Added: ${plan.drop_item_summary} (each at 100% discount — already paid on ${plan.drop_name})`,
          `  Tags added: \`${KEEPER_TAG}\`, \`consolidated-from-${plan.drop_short}\``,
          `  Edit committed: ${committed?.name || plan.keep_name}`,
          '',
          `**Dropped:** ${plan.drop_name} — ${getAdminUrl(plan.drop_id)}`,
          `  Placeholder fulfillment id: ${droppedFulfillmentId || '(none)'}`,
          `  Tags added: \`${DROPPED_TAG}\`, \`consolidated-into-${plan.keep_short}\``,
        ];

        if (plan.refund_plan?.refundShipping) {
          out.push('', '**Shipping refunds:**');
          for (const r of shippingRefundResults) {
            if (r.ok) {
              out.push(`  ${r.order_name}: refunded ${r.amount} ${r.currency} (refund ${r.refund_id || '?'})`);
            } else {
              out.push(`  ${r.order_name}: FAILED — ${r.error}. Issue manually for ${r.amount} ${r.currency}.`);
            }
          }
        } else if (plan.refund_plan) {
          out.push('', `**Shipping refund:** none — ${plan.refund_plan.reason}`);
        }

        out.push(...lines);
        out.push('', `Customer was NOT emailed by Shopify about the edit. If you need to message them, use a separate reply.`);

        return { content: [{ type: 'text', text: out.join('\n') }] };
      }

      // ---------------------------------------------------------------
      // Phase 1: Preview
      // ---------------------------------------------------------------
      if (keep_order_number === drop_order_number) {
        return { content: [{ type: 'text', text: 'Error: keep_order_number and drop_order_number must be different.' }] };
      }

      const [keeper, dropped] = await Promise.all([
        getOrderForEdit(keep_order_number),
        getOrderForEdit(drop_order_number),
      ]);

      // Editability checks (both)
      for (const [order, role] of [[keeper, 'keeper'], [dropped, 'dropped']]) {
        if (order.cancelledAt) {
          return { content: [{ type: 'text', text: `Error: ${role} order ${order.name} is cancelled.` }] };
        }
        if (order.displayFulfillmentStatus === 'FULFILLED') {
          return { content: [{ type: 'text', text: `Error: ${role} order ${order.name} is already fully fulfilled — nothing to consolidate.` }] };
        }
        if (order.displayFinancialStatus === 'REFUNDED') {
          return { content: [{ type: 'text', text: `Error: ${role} order ${order.name} is fully refunded.` }] };
        }
      }

      // Same customer
      if (!keeper.customer?.id || !dropped.customer?.id) {
        return { content: [{ type: 'text', text: `Error: both orders must have a customer assigned.` }] };
      }
      if (keeper.customer.id !== dropped.customer.id) {
        return { content: [{ type: 'text', text: `Error: orders belong to different customers (${keeper.customer.email} vs ${dropped.customer.email}). Refusing to consolidate.` }] };
      }

      // Refuse if dropped has any prior fulfillment activity (avoids double-counting)
      const droppedWithFOs = await getOrderWithFulfillmentOrders(drop_order_number);
      const droppedFOs = droppedWithFOs.fulfillmentOrders || [];
      const droppedAllFoLineItems = droppedFOs.flatMap(fo =>
        fo.lineItems
          .filter(li => li.remainingQuantity > 0)
          .map(li => ({ ...li, fulfillmentOrderId: fo.id, fulfillmentOrderStatus: fo.status }))
      );
      const droppedTotalRemaining = droppedAllFoLineItems.reduce((s, li) => s + li.remainingQuantity, 0);
      const droppedTotalQty = droppedFOs.flatMap(fo => fo.lineItems).reduce((s, li) => s + (li.totalQuantity || 0), 0);
      if (droppedTotalRemaining === 0) {
        return { content: [{ type: 'text', text: `Error: dropped order ${dropped.name} has no unfulfilled line items in any open fulfillment order — nothing to move.` }] };
      }
      if (droppedTotalRemaining < droppedTotalQty) {
        return { content: [{ type: 'text', text: `Error: dropped order ${dropped.name} is partially fulfilled (${droppedTotalQty - droppedTotalRemaining} of ${droppedTotalQty} already shipped). Refusing to consolidate — handle manually.` }] };
      }

      // Warehance status — refuse if either is in_progress; collect keeper's warehance id for hold
      let keeperWarehanceId = null;
      try {
        const keeperWh = await fetchOrderByNumber(keeper.name.replace('#', ''));
        if (keeperWh) {
          if (keeperWh.fulfillment_status === 'in_progress') {
            return { content: [{ type: 'text', text: `Error: keeper order ${keeper.name} is in_progress at the warehouse. Cannot edit.` }] };
          }
          keeperWarehanceId = keeperWh.id;
        }
        const dropWh = await fetchOrderByNumber(dropped.name.replace('#', ''));
        if (dropWh && dropWh.fulfillment_status === 'in_progress') {
          return { content: [{ type: 'text', text: `Error: dropped order ${dropped.name} is in_progress at the warehouse. Cannot consolidate.` }] };
        }
      } catch (e) {
        // Best effort
        console.error('[consolidateOrders] Warehance check failed:', e.message);
      }

      // Build the additions plan: every line on the dropped order, by remaining quantity
      // (we already verified the dropped order is fully unfulfilled, so we move all of it).
      const additions = [];
      for (const li of dropped.lineItems) {
        if (!li.variant?.id) {
          return { content: [{ type: 'text', text: `Error: dropped line item "${li.title}" (${li.sku || 'no sku'}) has no variant id — cannot add to keeper. Likely a custom/manual item; consolidate manually.` }] };
        }
        additions.push({
          variant_id: li.variant.id,
          quantity: li.currentQuantity,
          title: li.title,
          variantTitle: li.variantTitle,
          sku: li.sku,
        });
      }

      // Stage edit on keeper
      const calc = await orderEditBegin(keeper.id);
      const stagedAdditions = [];
      for (const add of additions) {
        const result = await orderEditAddVariant(calc.id, add.variant_id, add.quantity);
        const calcLi = result.calculatedLineItem;
        if (!calcLi?.id) {
          return { content: [{ type: 'text', text: `Error: Shopify did not return a calculated line item for variant ${add.variant_id} — cannot apply discount. Aborting.` }] };
        }
        const unitPrice = parseFloat(calcLi.originalUnitPriceSet?.shopMoney?.amount || '0');
        const currency = calcLi.originalUnitPriceSet?.shopMoney?.currencyCode || keeper.totalPriceSet.shopMoney.currencyCode;
        await orderEditAddLineItemDiscount(calc.id, calcLi.id, {
          description: FREE_DISCOUNT_DESCRIPTION,
          percentValue: 100,
        });
        stagedAdditions.push({
          ...add,
          calc_line_item_id: calcLi.id,
          unit_price: unitPrice,
          currency,
        });
      }

      // Free-shipping threshold check
      const destCountry = keeper.shippingAddress?.countryCodeV2
        || keeper.shippingAddress?.countryCode
        || keeper.shippingAddress?.country;
      const zone = destCountry ? await getShippingZone(destCountry) : null;
      const threshold = zone?.free_shipping_threshold ?? null;
      const keeperSubtotal = parseFloat(keeper.subtotalPriceSet?.shopMoney?.amount || '0');
      const dropSubtotal = parseFloat(dropped.subtotalPriceSet?.shopMoney?.amount || '0');

      // Pull each order's shipping line + suggested refund
      const [keepShipCtx, dropShipCtx] = await Promise.all([
        getOrderShippingRefundContext(keeper.id),
        getOrderShippingRefundContext(dropped.id),
      ]);

      const refundPlan = planShippingRefunds({
        keeperSubtotal,
        dropSubtotal,
        threshold,
        keeperShipping: keepShipCtx.currentShipping,
        dropShipping: dropShipCtx.currentShipping,
      });

      const shippingRefunds = [];
      if (refundPlan.refundShipping) {
        for (const [order, ctx] of [[keeper, keepShipCtx], [dropped, dropShipCtx]]) {
          if (!ctx.suggested?.suggestedTransactions?.length) continue;
          const txn = ctx.suggested.suggestedTransactions[0];
          const amount = parseFloat(txn.amountSet.presentmentMoney.amount);
          if (amount <= 0.01) continue;
          shippingRefunds.push({
            order_id: order.id,
            order_name: order.name,
            amount: amount.toFixed(2),
            currency: txn.amountSet.presentmentMoney.currencyCode,
            transactions: [{
              gateway: txn.gateway,
              parentId: txn.parentTransaction.id,
              amount: amount.toFixed(2),
              kind: 'REFUND',
            }],
          });
        }
      }

      const dropItemSummary = stagedAdditions.map(lineSummary).join('; ');
      const keepShort = keeper.name.replace(/^#/, '');
      const dropShort = dropped.name.replace(/^#/, '');

      // Stash plan for phase 2
      const plan = {
        keep_id: keeper.id,
        keep_name: keeper.name,
        keep_short: keepShort,
        drop_id: dropped.id,
        drop_name: dropped.name,
        drop_short: dropShort,
        calculated_order_id: calc.id,
        keeper_warehance_id: keeperWarehanceId,
        drop_line_items_by_fo: droppedFOs
          .filter(fo => fo.lineItems.some(li => li.remainingQuantity > 0))
          .map(fo => ({
            fulfillmentOrderId: fo.id,
            fulfillmentOrderLineItems: fo.lineItems
              .filter(li => li.remainingQuantity > 0)
              .map(li => ({ id: li.id, quantity: li.remainingQuantity })),
          })),
        drop_item_summary: dropItemSummary,
        refund_plan: refundPlan,
        shipping_refunds: shippingRefunds,
      };
      const key = `${keep_order_number}|${drop_order_number}`;
      pendingConsolidations.set(key, plan);

      // Build preview
      const out = [
        '**Order Consolidation Preview — Awaiting Confirmation**',
        '',
        `**Customer:** ${customerName(keeper.customer)} (${keeper.customer?.email || 'no email'})`,
        '',
        `**Keeper:** ${keeper.name} — ${getAdminUrl(keeper.id)}`,
        `  Existing items remain unchanged.`,
        `  ADD (each at 100% discount, total = $0):`,
        ...stagedAdditions.map(a => `    ${a.quantity}x ${a.title}${a.variantTitle ? ` — ${a.variantTitle}` : ''} (${a.sku || 'no sku'}) @ $${a.unit_price.toFixed(2)} ${a.currency} → $0.00`),
        `  Tags to add: \`${KEEPER_TAG}\`, \`consolidated-from-${dropShort}\``,
        '',
        `**Dropped:** ${dropped.name} — ${getAdminUrl(dropped.id)}`,
        `  Mark fulfilled (placeholder, no tracking, no customer email).`,
        `  Tags to add: \`${DROPPED_TAG}\`, \`consolidated-into-${keepShort}\``,
        '',
        `**Combined product subtotal (pre-merge):** $${(keeperSubtotal + dropSubtotal).toFixed(2)} ${keeper.totalPriceSet.shopMoney.currencyCode}`,
        `  Keeper subtotal: $${keeperSubtotal.toFixed(2)} | Dropped subtotal: $${dropSubtotal.toFixed(2)}`,
        `**Destination:** ${destCountry || '(unknown)'} | **Free-shipping threshold:** ${threshold == null ? '(none on file)' : `$${Number(threshold).toFixed(2)} ${zone?.currency || ''}`}`,
        '',
        '**Shipping refund:**',
        refundPlan.refundShipping
          ? (shippingRefunds.length
              ? shippingRefunds.map(r => `  ${r.order_name}: refund $${r.amount} ${r.currency} (shipping + tax) to original payment`).join('\n')
              : '  (qualifies, but no refundable shipping found on either order)')
          : `  none — ${refundPlan.reason}`,
        '',
        `**Keeper shipping line:** $${keepShipCtx.currentShipping.toFixed(2)} | **Dropped shipping line:** $${dropShipCtx.currentShipping.toFixed(2)}`,
        staff_note ? `\n**Staff note (added to both orders):** ${staff_note}` : '',
        '',
        `Customer will NOT receive Shopify\'s order-edited email when this commits.`,
        '',
        `To confirm, call consolidate_orders with confirmed=true, keep_order_number="${keep_order_number}", drop_order_number="${drop_order_number}".`,
      ].filter(Boolean);

      return { content: [{ type: 'text', text: out.join('\n') }] };
    },
  },
];

module.exports = tools;
module.exports.planShippingRefunds = planShippingRefunds;
