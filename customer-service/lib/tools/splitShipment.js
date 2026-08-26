/**
 * Split shipment tool: split_shipment
 *
 * Splits an order so some items ship now and the rest ship separately later, in
 * one operation:
 *   1. Marks the held items as fulfilled on the original order (placeholder
 *      fulfillment — no tracking, customer not notified) so the warehouse can
 *      ship the remaining portion.
 *   2. Tags the original order and appends a staff note explaining the split.
 *   3. Creates a new $0 order for the held items, with a note referencing the
 *      original.
 *
 * `split_kind` decides what the new order MEANS, and the two kinds are not
 * interchangeable (2026-08-26). A pre-order split stamps every new line with a
 * `Pre-order` customAttribute carrying a target-availability date, tags both
 * orders `pre-order*`, and leaves the new order free to ship the moment stock
 * lands — which is right when the items really are out of stock, and wrong in
 * every way when they are not. The attribute is the canonical pre-order signal
 * (it is what the unnotified-pre-order sweep and preorder_hygiene read) and it
 * renders on the customer's own order status page, so stamping it on in-stock
 * goods both publishes a date we never promised and files the customer into the
 * pre-order population. A `hold` split therefore stamps nothing, tags
 * `split-*`, and places a Warehance warehouse hold on the new order — because
 * "these must not ship yet" is the whole reason that split exists, and the new
 * order is live in the warehouse queue within seconds of being created.
 *
 * Merge mode (`ship_with_order`): when the specified items are ALREADY part of
 * another existing order (e.g. a free replacement order was created containing
 * them so everything leaves the warehouse in one box), pass that order's
 * number. Step 3 is skipped — no new order is created; instead both orders
 * get cross-referencing notes and the original is tagged `ships-with-<dest>`.
 * `split_kind` does not apply: nothing is created to label.
 *
 * Two-phase: phase 1 previews; phase 2 (confirmed=true) executes.
 *
 * For manual fulfillment with real tracking, build a different tool when the
 * need arises.
 */

const {
  getOrderWithFulfillmentOrders,
  createFulfillment,
  addTags,
  appendOrderNote,
  createDraftOrder,
  completeDraftOrder,
  getAdminUrl,
} = require('../shopify');
const { preOrderAttrValue } = require('../preOrderAttrs');

/**
 * Allocate requested SKUs across fulfillment-order line items.
 *
 * Same allocation pattern as refundOrder's allocateRefundLineItems, applied to
 * FO line items: a single SKU can span MULTIPLE line items on one order
 * (Simple Bundles unbundles a bundle into one line item per component, each
 * quantity 1), so a `.find()`/`matches[0]` resolver either rejects a
 * satisfiable request ("requested 2 but only 1 unfulfilled") or double-targets
 * the first line. Spread the requested quantity across matching lines and
 * track consumed capacity. Requested quantity defaults to ALL unfulfilled
 * units of that SKU.
 *
 * Pure + deterministic (no I/O) so it's unit-testable. `attrValueForSku`
 * resolves the `Pre-order` line-item property value (the production caller
 * passes preOrderAttrValue for the app-identical date-aware text). Pass null to
 * emit NO line-item properties — a `hold` split is not a pre-order and must not
 * claim to be one.
 * Returns { byFo: Map<foId, [{id, quantity}]>, matchedSummary, newOrderLineItems, errors }.
 */
function allocateSplitLineItems(allFoLineItems, items, attrValueForSku = () => 'Will ship when in stock') {
  const remaining = new Map(allFoLineItems.map(li => [li.id, li.remainingQuantity]));
  const byFo = new Map();
  const matchedSummary = [];
  const newOrderLineItems = [];
  const errors = [];

  const pushFoAllocation = (foId, lineId, qty) => {
    const list = byFo.get(foId) || [];
    const existing = list.find(e => e.id === lineId);
    if (existing) existing.quantity += qty;
    else list.push({ id: lineId, quantity: qty });
    byFo.set(foId, list);
  };

  for (const requested of items) {
    const sku = requested.sku;
    if (!sku) { errors.push('Each item needs a sku.'); continue; }
    const matches = allFoLineItems.filter(li => li.lineItem?.sku === sku);
    if (matches.length === 0) {
      errors.push(`SKU not found in unfulfilled items: ${sku}`);
      continue;
    }
    const noVariant = matches.find(li => !li.lineItem.variant?.id);
    if (noVariant) {
      errors.push(`SKU ${sku}: no variant id on original line item — cannot create pre-order line item. Likely a custom/manual item.`);
      continue;
    }
    const totalAvail = matches.reduce((s, li) => s + (remaining.get(li.id) || 0), 0);
    const requestedQty = requested.quantity ?? totalAvail;
    if (requestedQty > totalAvail) {
      errors.push(`SKU ${sku}: requested ${requestedQty} but only ${totalAvail} unfulfilled across ${matches.length} line item(s).`);
      continue;
    }
    let need = requestedQty;
    for (const target of matches) {
      if (need <= 0) break;
      const avail = remaining.get(target.id) || 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      remaining.set(target.id, avail - take);
      pushFoAllocation(target.fulfillmentOrderId, target.id, take);
      matchedSummary.push(`${take}x ${target.lineItem.title}${target.lineItem.variantTitle ? ` — ${target.lineItem.variantTitle}` : ''} (${sku})`);
      newOrderLineItems.push({
        variantId: target.lineItem.variant.id,
        quantity: take,
        ...(attrValueForSku
          ? { customAttributes: [{ key: 'Pre-order', value: attrValueForSku(sku) }] }
          : {}),
      });
      need -= take;
    }
  }

  return { byFo, matchedSummary, newOrderLineItems, errors };
}

const PRE_ORDER_PENDING_TAG = 'pre-order-pending';
const NEW_ORDER_TAGS = ['pre-order', 'cs-mcp'];

const SPLIT_PENDING_TAG = 'split-pending';
const HOLD_ORDER_TAGS = ['cs-mcp'];

const SPLIT_KINDS = ['pre_order', 'hold'];

/**
 * How long to wait for a just-created Shopify order to appear in Warehance
 * before giving up on placing its hold. Warehance ingested the live case in
 * ~5s; the budget is deliberately several times that because the cost of
 * waiting is a slow tool call and the cost of not waiting is the warehouse
 * shipping goods the operator just said must not ship.
 */
const WAREHANCE_POLL_ATTEMPTS = 6;
const WAREHANCE_POLL_DELAY_MS = 4000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Place the warehouse hold on the newly created order, waiting for Warehance to
 * ingest it first. Returns { placed, detail } — never throws, because the split
 * itself has already committed by the time this runs and a thrown error would
 * hide it.
 */
async function holdNewOrder(orderNumber, reason, deps = {}) {
  const {
    fetchOrderByNumber = require('../../../reports/lib/warehanceClient').fetchOrderByNumber,
    handleWarehouseHold = require('./orderNotes').handleWarehouseHold,
    wait = sleep,
    attempts = WAREHANCE_POLL_ATTEMPTS,
    delayMs = WAREHANCE_POLL_DELAY_MS,
  } = deps;

  const bare = String(orderNumber || '').replace(/^#/, '');
  if (!bare) return { placed: false, detail: 'no order number returned for the new order' };

  let seen = null;
  for (let i = 0; i < attempts; i++) {
    seen = await fetchOrderByNumber(bare).catch(() => null);
    if (seen) break;
    if (i < attempts - 1) await wait(delayMs);
  }
  if (!seen) {
    return { placed: false, detail: `order #${bare} had not reached Warehance after ~${Math.round((attempts - 1) * delayMs / 1000)}s` };
  }

  let result;
  try {
    result = await handleWarehouseHold({ order_number: bare, reason });
  } catch (err) {
    return { placed: false, detail: err.message || String(err) };
  }
  const text = result?.content?.[0]?.text || '';
  if (result?.isError) return { placed: false, detail: text };
  return { placed: true, detail: text };
}

const tools = [
  {
    name: 'split_shipment',
    description: [
      'Split an order so some items ship now and the rest ship separately later. Marks the specified held line items as fulfilled (placeholder, no tracking, no customer notification) on the original order so the warehouse can release the rest, AND immediately creates a new $0 order containing the held items. The customer pays nothing extra and receives nothing less — this only splits the shipment timing.',
      'REQUIRED: split_kind says WHY the items are held, and the two kinds behave differently. Use "pre_order" when the held items are genuinely out of stock / on pre-order and should ship as soon as inventory arrives: every new line is stamped with a `Pre-order` line-item property carrying its target-availability date, the original is tagged `pre-order-pending`, the new order is tagged `pre-order` + `pre-order-from-<original>`, and nothing holds it back. Use "hold" when the items are in stock but must NOT ship yet — waiting on the customer to confirm a size, a pending address fix, anything the customer has to answer first: no `Pre-order` properties are stamped, the tags are `split-pending` / `split-from-<original>`, and a Warehance warehouse hold is placed on the new order using hold_reason.',
      'Do NOT use "pre_order" for an item that is merely being held. The `Pre-order` property is the signal our pre-order sweeps key on AND it renders on the customer\'s order status page, so it publishes an availability date we never promised and files the customer into the pre-order population.',
      'Two-phase: phase 1 (confirmed omitted/false) previews; phase 2 (confirmed=true) executes.',
      'You MUST present the phase 1 preview to the operator and receive explicit confirmation before calling phase 2.',
      'Pass the SKUs of the HELD items (the ones being moved to the new order), not the items being shipped now.',
      'MERGE MODE (ship_with_order): when the specified items are ALREADY included in another existing order — e.g. a free replacement order was created containing both the replacement items AND this order\'s in-stock items so everything ships in ONE box — pass that destination order number as ship_with_order. No new order is created (so split_kind does not apply and is not needed): the items are placeholder-fulfilled here (so the warehouse cannot double-ship them), the original is tagged `ships-with-<dest>`, and both orders get cross-referencing staff notes. Recipe for a one-box merge: 1) create_order with the replacement items PLUS this order\'s in-stock items (free=true so the already-paid items are not charged again), 2) create_order_complete, 3) split_shipment with ship_with_order=<new order number> and items=<the in-stock items that moved>.',
      'Do NOT use for manual fulfillment with real tracking — that is a different flow.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Original order number (e.g. "30267", "#30267")' },
        split_kind: {
          type: 'string',
          enum: SPLIT_KINDS,
          description: 'Why the items are being held. "pre_order" = genuinely out of stock, ships when inventory arrives (stamps `Pre-order` line properties + pre-order tags, no hold). "hold" = in stock but must not ship yet, e.g. awaiting the customer\'s size confirmation (no `Pre-order` properties, `split-*` tags, warehouse hold placed on the new order). Required unless ship_with_order is set.',
        },
        hold_reason: {
          type: 'string',
          description: 'Required when split_kind="hold": why the new order must not ship yet (e.g. "waiting on customer to confirm the L fits"). Used as the Warehance hold reason and in the staff notes.',
        },
        items: {
          type: 'array',
          description: 'Line items to mark as fulfilled on the original AND move into the new order. Each item: { sku, quantity? } — quantity defaults to the full unfulfilled quantity for that SKU.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'SKU of the held item' },
              quantity: { type: 'number', description: 'Quantity (default: all remaining)' },
            },
            required: ['sku'],
          },
        },
        staff_note: { type: 'string', description: 'Optional additional context appended to both the original-order note and the new pre-order note' },
        ship_with_order: {
          type: 'string',
          description: 'MERGE MODE: order number of an EXISTING order that already contains these items (e.g. "31479" or "#31479"). When set, no new pre-order is created — the items are placeholder-fulfilled on the original order and both orders get cross-referencing notes, because they will physically ship via the destination order.',
        },
        confirmed: { type: 'boolean', description: 'Set true in phase 2 to execute' },
        _fulfill_data: {
          type: 'object',
          description: 'Internal: phase 1 carry data — pass back unchanged in phase 2',
        },
      },
      required: ['order_number', 'items'],
    },
    handler: async ({ order_number, items, staff_note, split_kind, hold_reason, ship_with_order, confirmed, _fulfill_data }) => {
      // --- Phase 2: execute ---
      if (confirmed && _fulfill_data) {
        const {
          order_id,
          order_name,
          line_items_by_fo,
          item_summary,
          customer_id,
          shipping_address,
          new_order_line_items,
          ship_with,
        } = _fulfill_data;

        // Read the kind off the carry data rather than the args: phase 2 must
        // execute the split the operator was SHOWN, and the args are re-typed
        // by the model between the two calls.
        const kind = _fulfill_data.split_kind || split_kind;
        const holdReason = _fulfill_data.hold_reason || hold_reason;
        const isHoldSplit = kind === 'hold';

        const originalShortName = (order_name || '').replace(/^#/, '');

        // Step 1: placeholder fulfillment on original order
        const fulfillment = await createFulfillment({
          lineItemsByFulfillmentOrder: line_items_by_fo,
          notifyCustomer: false,
        });

        // --- Merge mode: items ship via an existing destination order ---
        if (ship_with) {
          const destShortName = (ship_with.dest_order_name || '').replace(/^#/, '');

          const originalNote = [
            `Merged shipment: ${item_summary} will ship with order ${ship_with.dest_order_name} (already paid on this order); marked fulfilled here so the warehouse doesn't double-ship.`,
            staff_note || null,
          ].filter(Boolean).join(' — ');
          await appendOrderNote(order_id, originalNote);
          await addTags(order_id, [`ships-with-${destShortName}`]);

          const destNote = [
            `Includes ${item_summary} from order ${order_name} — paid there, shipping here.`,
            staff_note || null,
          ].filter(Boolean).join(' — ');
          await appendOrderNote(ship_with.dest_order_id, destNote);

          return {
            content: [{
              type: 'text',
              text: [
                '**Shipment merged into existing order**',
                '',
                `**Original order:** ${order_name} — ${getAdminUrl(order_id)}`,
                `  - Items marked fulfilled (placeholder, ship via ${ship_with.dest_order_name}): ${item_summary}`,
                `  - Tag added: \`ships-with-${destShortName}\``,
                `  - Fulfillment id: ${fulfillment?.id || '(none)'}`,
                '',
                `**Destination order:** ${ship_with.dest_order_name} — ${getAdminUrl(ship_with.dest_order_id)}`,
                '  - Cross-referencing note added.',
                '',
                `Warehance will ship ${ship_with.dest_order_name} as the single outgoing shipment; ${order_name} keeps only its remaining (unfulfilled) items.`,
              ].join('\n'),
            }],
          };
        }

        const originalTag = isHoldSplit ? SPLIT_PENDING_TAG : PRE_ORDER_PENDING_TAG;
        const newOrderTags = isHoldSplit
          ? [...HOLD_ORDER_TAGS, `split-from-${originalShortName}`]
          : [...NEW_ORDER_TAGS, `pre-order-from-${originalShortName}`];
        const newOrderLabel = isHoldSplit ? 'held order' : 'pre-order';

        // Step 2: tag + note original order
        const originalNote = [
          isHoldSplit
            ? `Split shipment: ${item_summary} marked as fulfilled here and moved to a new $0 order, which is on a warehouse hold. NOT a pre-order — the items are in stock and held pending: ${holdReason || 'customer response'}.`
            : `Pre-order split: ${item_summary} marked as fulfilled (out of stock); a new $0 pre-order has been queued and will ship when inventory arrives.`,
          staff_note || null,
        ].filter(Boolean).join(' — ');
        await appendOrderNote(order_id, originalNote);
        await addTags(order_id, [originalTag]);

        // Step 3: create the new order. If this fails after step 1 succeeded,
        // surface a clear recovery instruction to the operator.
        let newOrder = null;
        let newOrderError = null;
        try {
          const draftInput = {
            customerId: customer_id,
            lineItems: new_order_line_items,
            shippingAddress: shipping_address || undefined,
            tags: newOrderTags,
            note: [
              isHoldSplit
                ? `Split from order #${originalShortName}, held pending: ${holdReason || 'customer response'}. These items are IN STOCK — this is not a pre-order. The order is on a warehouse hold; release it once the matter is resolved. Customer has already paid via the original order.`
                : `Pre-order release from order #${originalShortName}. The following items were out of stock when the original order was placed; they will ship from this order when inventory arrives. Customer has already paid via the original order.`,
              staff_note || null,
            ].filter(Boolean).join(' — '),
            useCustomerDefaultAddress: !shipping_address,
          };
          // Apply 100% discount so the new order totals $0
          draftInput.appliedDiscount = {
            valueType: 'PERCENTAGE',
            value: 100,
            description: isHoldSplit
              ? 'Split shipment — paid in original order'
              : 'Pre-order release — paid in original order',
          };
          const draft = await createDraftOrder(draftInput);
          const completed = await completeDraftOrder(draft.id);
          newOrder = completed.order || completed;
        } catch (err) {
          newOrderError = err.message || String(err);
        }

        if (newOrderError) {
          return {
            content: [{
              type: 'text',
              text: [
                `**Partial success — placeholder fulfillment done, new ${newOrderLabel} failed**`,
                '',
                `**Original order:** ${order_name} — ${getAdminUrl(order_id)}`,
                `**Held items marked fulfilled:** ${item_summary}`,
                `**Tag added:** \`${originalTag}\``,
                '',
                `**New ${newOrderLabel} creation failed:** ${newOrderError}`,
                '',
                `Recovery: manually create a $0 order for the held items via \`create_order\` (customer ${customer_id}, items as listed above, tags \`${newOrderTags.join('`, `')}\`, note referencing #${originalShortName})${isHoldSplit ? ', then place a warehouse hold on it' : ''}.`,
              ].join('\n'),
            }],
          };
        }

        const newOrderUrl = newOrder?.id ? getAdminUrl(newOrder.id) : '(no admin url)';
        const newOrderName = newOrder?.name || '(no order name returned)';

        // Step 4 (hold splits only): the new order is already live in the
        // Warehance queue, so the hold is part of the split rather than a
        // follow-up call the operator might not make in time.
        const hold = isHoldSplit
          ? await holdNewOrder(newOrderName, `Split from #${originalShortName}, held pending: ${holdReason || 'customer response'}`)
          : null;

        return {
          content: [{
            type: 'text',
            text: [
              isHoldSplit ? '**Order split — held items moved to a new order**' : '**Order split for pre-order**',
              '',
              `**Original order:** ${order_name} — ${getAdminUrl(order_id)}`,
              `  - Held items marked fulfilled (placeholder): ${item_summary}`,
              `  - Tag added: \`${originalTag}\``,
              `  - Fulfillment id: ${fulfillment?.id || '(none)'}`,
              '',
              `**New ${newOrderLabel}:** ${newOrderName} — ${newOrderUrl}`,
              `  - Items: ${item_summary}`,
              `  - Tags: \`${newOrderTags.join('`, `')}\``,
              `  - Total: $0 (already paid via original)`,
              isHoldSplit
                ? (hold?.placed
                  ? `  - Warehouse hold: PLACED — ${holdReason || 'customer response'}`
                  : `  - ⚠️ Warehouse hold: **NOT PLACED** (${hold?.detail || 'unknown error'}). This order will ship as soon as the warehouse picks it up — place the hold now with \`warehouse_hold\` on ${newOrderName}.`)
                : '  - Every line stamped with a `Pre-order` property (target availability date where known).',
              '',
              isHoldSplit
                ? `Warehance will ship the remaining items on ${order_name} now. ${newOrderName} stays put until its hold is released.`
                : `Warehance will ship the in-stock items on ${order_name} now, and the new pre-order automatically when inventory arrives.`,
            ].join('\n'),
          }],
        };
      }

      // --- Phase 1: preview ---
      if (!Array.isArray(items) || items.length === 0) {
        return { content: [{ type: 'text', text: 'Error: items array is required (at least one { sku, quantity? }).' }] };
      }

      // The kind is asked for rather than defaulted. Defaulting it to
      // "pre_order" is what silently stamped in-stock goods with a pre-order
      // date and a target-availability promise on the customer's order page;
      // asking costs one free preview round-trip and the caller always knows.
      const isHoldSplit = split_kind === 'hold';
      if (!ship_with_order && !SPLIT_KINDS.includes(split_kind)) {
        return { content: [{ type: 'text', text: [
          'Error: split_kind is required. Pass one of:',
          '  - "pre_order" — the held items are genuinely out of stock and should ship when inventory arrives. Stamps a `Pre-order` line property (with target availability date) on each new line and tags both orders `pre-order*`.',
          '  - "hold" — the held items are IN STOCK but must not ship yet (waiting on the customer to confirm a size, an address fix, etc). Stamps no `Pre-order` properties, tags `split-*`, and places a warehouse hold on the new order. Also pass hold_reason.',
          '',
          'The `Pre-order` property is read by our pre-order sweeps AND shown to the customer on their order status page, so "pre_order" on in-stock goods publishes an availability date we never promised.',
        ].join('\n') }] };
      }
      if (isHoldSplit && !hold_reason) {
        return { content: [{ type: 'text', text: 'Error: hold_reason is required when split_kind="hold" — say what the new order is waiting on (e.g. "waiting on customer to confirm the L fits"). It becomes the Warehance hold reason and the staff note.' }] };
      }

      const order = await getOrderWithFulfillmentOrders(order_number);

      if (order.cancelledAt) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} is cancelled — nothing to fulfill.` }] };
      }
      if (order.displayFulfillmentStatus === 'FULFILLED') {
        return { content: [{ type: 'text', text: `Error: order ${order.name} is already fully fulfilled.` }] };
      }
      if (!ship_with_order && !order.customer?.id) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} has no associated customer — cannot create a new order without a customer.` }] };
      }

      // Merge mode: resolve + validate the destination order the items will ship with
      let destOrder = null;
      if (ship_with_order) {
        try {
          destOrder = await getOrderWithFulfillmentOrders(ship_with_order);
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: could not find destination order "${ship_with_order}": ${err.message || err}` }] };
        }
        if (!destOrder) {
          return { content: [{ type: 'text', text: `Error: destination order "${ship_with_order}" not found.` }] };
        }
        if (destOrder.id === order.id) {
          return { content: [{ type: 'text', text: `Error: ship_with_order is the same order as ${order.name} — the destination must be a different, existing order that already contains the items.` }] };
        }
        if (destOrder.cancelledAt) {
          return { content: [{ type: 'text', text: `Error: destination order ${destOrder.name} is cancelled — items cannot ship with it.` }] };
        }
        if (destOrder.displayFulfillmentStatus === 'FULFILLED') {
          return { content: [{ type: 'text', text: `Error: destination order ${destOrder.name} is already fully fulfilled — too late to merge items into its shipment.` }] };
        }
      }

      // Map requested SKUs to fulfillment-order line items with remaining > 0
      const allFoLineItems = order.fulfillmentOrders.flatMap(fo =>
        fo.lineItems
          .filter(li => li.remainingQuantity > 0)
          .map(li => ({ ...li, fulfillmentOrderId: fo.id, fulfillmentOrderStatus: fo.status }))
      );

      if (allFoLineItems.length === 0) {
        return { content: [{ type: 'text', text: `Error: order ${order.name} has no unfulfilled line items in any open fulfillment order.` }] };
      }

      // A hold split passes null: no `Pre-order` line properties at all.
      const { byFo, matchedSummary, newOrderLineItems, errors } =
        allocateSplitLineItems(allFoLineItems, items, isHoldSplit ? null : preOrderAttrValue);

      if (errors.length) {
        return { content: [{ type: 'text', text: `Error preparing fulfillment:\n${errors.map(e => `- ${e}`).join('\n')}` }] };
      }

      const lineItemsByFulfillmentOrder = [...byFo.entries()].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      }));

      const itemSummary = matchedSummary.join('; ');
      const originalShortName = (order.name || '').replace(/^#/, '');

      // Merge mode: soft-check that the destination actually contains the
      // requested SKUs in sufficient unfulfilled quantity. Warn, don't block —
      // the operator may have deliberately used a different variant.
      const destWarnings = [];
      if (destOrder) {
        const destRemaining = new Map();
        for (const fo of destOrder.fulfillmentOrders || []) {
          for (const li of fo.lineItems || []) {
            const sku = li.lineItem?.sku;
            if (!sku || !li.remainingQuantity) continue;
            destRemaining.set(sku, (destRemaining.get(sku) || 0) + li.remainingQuantity);
          }
        }
        for (const requested of items) {
          const needed = requested.quantity
            ?? allFoLineItems.filter(li => li.lineItem?.sku === requested.sku)
              .reduce((s, li) => s + li.remainingQuantity, 0);
          const have = destRemaining.get(requested.sku) || 0;
          if (have < needed) {
            destWarnings.push(`⚠️ Destination ${destOrder.name} has ${have}x ${requested.sku} unfulfilled but ${needed}x are being merged — verify the destination order really contains these items before confirming.`);
          }
        }
      }

      const fulfillData = {
        order_id: order.id,
        order_name: order.name,
        line_items_by_fo: lineItemsByFulfillmentOrder,
        item_summary: itemSummary,
        customer_id: order.customer?.id || null,
        shipping_address: order.shippingAddress || null,
        new_order_line_items: newOrderLineItems,
        ship_with: destOrder ? { dest_order_id: destOrder.id, dest_order_name: destOrder.name } : undefined,
        // Carried so phase 2 executes the split that was previewed, rather than
        // whatever the model re-types on the confirm call.
        split_kind: destOrder ? undefined : split_kind,
        hold_reason: isHoldSplit ? hold_reason : undefined,
      };

      const stayingUnfulfilled = allFoLineItems
        .filter(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          if (!claimed) return true;
          return claimed.quantity < li.remainingQuantity;
        })
        .map(li => {
          const list = byFo.get(li.fulfillmentOrderId) || [];
          const claimed = list.find(x => x.id === li.id);
          const remainingAfter = li.remainingQuantity - (claimed?.quantity || 0);
          return `${remainingAfter}x ${li.lineItem.title}${li.lineItem.variantTitle ? ` — ${li.lineItem.variantTitle}` : ''} (${li.lineItem.sku})`;
        });

      const customerName = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim() || '(no name)';
      const newOrderTags = isHoldSplit
        ? [...HOLD_ORDER_TAGS, `split-from-${originalShortName}`]
        : [...NEW_ORDER_TAGS, `pre-order-from-${originalShortName}`];

      if (destOrder) {
        const destShortName = (destOrder.name || '').replace(/^#/, '');
        return {
          content: [{
            type: 'text',
            text: [
              '**Shipment Merge Preview — Awaiting Confirmation**',
              '',
              `**Original order:** ${order.name} — ${getAdminUrl(order.id)}`,
              `**Customer:** ${customerName} (${order.customer?.email || 'no email'})`,
              `**Destination order (ships the items):** ${destOrder.name} — ${getAdminUrl(destOrder.id)}`,
              '',
              '**On the original order — mark fulfilled (placeholder, no tracking, no customer email):**',
              `  ${itemSummary}`,
              stayingUnfulfilled.length
                ? '\n**On the original order — remaining (unchanged, ships from this order when available):**\n' + stayingUnfulfilled.map(l => `  ${l}`).join('\n')
                : '\n**Remaining on original:** none — original will become fully fulfilled.',
              '',
              `**No new order will be created** — the items already exist on ${destOrder.name}, which ships as the single outgoing shipment.`,
              `**Tag to add on original:** \`ships-with-${destShortName}\``,
              destWarnings.length ? '\n' + destWarnings.join('\n') + '\n' : '',
              staff_note ? `**Staff note (added to both orders):** ${staff_note}\n` : '',
              `To confirm, call split_shipment again with confirmed=true, order_number="${order_number}", items=${JSON.stringify(items)}, ship_with_order="${ship_with_order}", and _fulfill_data=${JSON.stringify(fulfillData)}.`,
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            isHoldSplit
              ? '**Order Split Preview (held, not a pre-order) — Awaiting Confirmation**'
              : '**Order Split Preview (pre-order) — Awaiting Confirmation**',
            '',
            `**Original order:** ${order.name} — ${getAdminUrl(order.id)}`,
            `**Customer:** ${customerName} (${order.customer?.email || 'no email'})`,
            '',
            '**On the original order — mark fulfilled (placeholder, no tracking, no customer email):**',
            `  ${itemSummary}`,
            stayingUnfulfilled.length
              ? '\n**On the original order — remaining (Warehance will ship now):**\n' + stayingUnfulfilled.map(l => `  ${l}`).join('\n')
              : '\n**Remaining on original:** none — original will become fully fulfilled.',
            '',
            isHoldSplit ? '**New held order to create:**' : '**New pre-order to create:**',
            isHoldSplit
              ? `  Items: ${itemSummary} — NO "Pre-order" line-item properties (these items are in stock, the customer is shown no availability date)`
              : `  Items: ${itemSummary} — each tagged with a "Pre-order" line-item property (target availability date when known)`,
            `  Total: $0 (already paid via ${order.name})`,
            `  Tags: \`${newOrderTags.join('`, `')}\``,
            `  Customer: ${order.customer?.email || customerName}`,
            '  Shipping address: ' + (order.shippingAddress ? `same as ${order.name}` : 'customer default'),
            isHoldSplit ? `  Warehouse hold: will be placed on the new order — ${hold_reason}` : null,
            `  Tag to add on original: \`${isHoldSplit ? SPLIT_PENDING_TAG : PRE_ORDER_PENDING_TAG}\``,
            '',
            staff_note ? `**Staff note (added to both orders):** ${staff_note}\n` : '',
            `To confirm, call split_shipment again with confirmed=true, order_number="${order_number}", items=${JSON.stringify(items)}, split_kind="${split_kind}", and _fulfill_data=${JSON.stringify(fulfillData)}.`,
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  },
];

module.exports = tools;
module.exports.allocateSplitLineItems = allocateSplitLineItems;
module.exports.holdNewOrder = holdNewOrder;
module.exports.SPLIT_KINDS = SPLIT_KINDS;
