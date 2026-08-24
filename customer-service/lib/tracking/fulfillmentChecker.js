/**
 * Fulfillment Checker — investigates WHY an order hasn't shipped.
 *
 * Checks:
 * 1. Pre-order/backorder (product tags/metafields)
 * 2. Warehouse allocation per item (Warehance is the truth for what can ship —
 *    items reserved for this order can ship even when the website shows 0;
 *    Shopify availability is only the fallback when warehouse data is missing).
 *    "Reserved for this order" is a per-order fact and comes from
 *    reports/lib/orderAllocation, the one place that answers it — the SKU-level
 *    on_hand / available / backordered counters are totals across every order
 *    and cannot.
 * 3. Order age (normal processing vs stuck)
 * 4. Partial fulfillment (some items shipped, some didn't)
 *
 * Returns an investigation result with a draft customer response.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { callClaude } = require('../../../shared/aiClient');
const { MODELS } = require('../../../shared/aiPricing');
const { addBusinessDays, businessDaysBetween } = require('../../../shared/businessDays');
const { isLineAllocated, orderFullyAllocated } = require('../../../reports/lib/orderAllocation');
const { relativeDay } = require('./analyzer');

// ---------------------------------------------------------------------------
// Check inventory levels via Shopify
// ---------------------------------------------------------------------------

async function checkInventory(order) {
  // Query Shopify for inventory levels of each line item
  const { shopifyGraphQL } = require('../shopify');
  const results = [];

  for (const item of (order.lineItems || order.items || [])) {
    if (!item.variantId) continue;
    try {
      // Get variant inventory
      const variantGid = item.variantId.includes('gid://') ? item.variantId : `gid://shopify/ProductVariant/${item.variantId}`;
      const query = `{
        productVariant(id: "${variantGid}") {
          title
          inventoryQuantity
          product { title tags }
          inventoryItem {
            inventoryLevels(first: 5) {
              edges { node { quantities(names: ["available"]) { name quantity } location { name } } }
            }
          }
        }
      }`;
      const data = await shopifyGraphQL(query);
      const variant = data.productVariant;
      if (!variant) continue;

      const totalAvailable = variant.inventoryItem?.inventoryLevels?.edges?.reduce(
        (sum, e) => {
          const avail = e.node.quantities?.find(q => q.name === 'available');
          return sum + (avail?.quantity || 0);
        }, 0
      ) || 0;

      const tags = variant.product?.tags || [];
      const preOrderAttr = (item.customAttributes || []).find(a => /pre-?order/i.test(a.key || ''));
      const isPreOrder = !!preOrderAttr || tags.some(t => /pre-?order|backorder|coming soon/i.test(t));

      results.push({
        title: variant.product?.title || item.title,
        variant: variant.title || item.variant,
        sku: item.sku,
        ordered: item.quantity,
        available: totalAvailable,
        inventoryQuantity: variant.inventoryQuantity,
        isPreOrder,
        preOrderTarget: preOrderAttr?.value || null,
        tags,
        locations: variant.inventoryItem?.inventoryLevels?.edges?.map(e => {
          const avail = e.node.quantities?.find(q => q.name === 'available');
          return { name: e.node.location.name, available: avail?.quantity || 0 };
        }) || [],
      });
    } catch (e) {
      results.push({
        title: item.title,
        variant: item.variant || item.variantTitle,
        sku: item.sku,
        error: e.message,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Analyze unfulfilled order
// ---------------------------------------------------------------------------

async function analyzeUnfulfilledOrder(order) {
  const orderDate = new Date(order.createdAt);
  const now = new Date();
  const daysSinceOrder = Math.floor((now - orderDate) / 86400000);
  const businessDays = businessDaysBetween(orderDate, now);

  const investigation = {
    orderNumber: order.name,
    orderDate: order.createdAt?.split('T')[0],
    daysSinceOrder,
    businessDays,
    issues: [],
    inventory: [],
    hasPreOrderItems: false,
    hasOutOfStockItems: false,
    isPartiallyFulfilled: false,
    onHold: false,
    holds: [],
    severity: 'normal', // normal, attention, urgent
  };

  // Check partial fulfillment
  const fulfillments = order.fulfillments || [];
  if (fulfillments.length > 0) {
    investigation.isPartiallyFulfilled = true;
    investigation.issues.push({
      type: 'partial_fulfillment',
      description: `Order is partially fulfilled — ${fulfillments.length} shipment(s) sent, but some items remain unfulfilled.`,
    });
  }

  // Fetch the warehouse view of this order up front. Warehance is the source of
  // truth for what can actually ship: Shopify "available" is net of allocations,
  // so an item whose units are already allocated to THIS order reads as 0 on the
  // website even though it's sitting at the warehouse reserved for the order.
  // Classifying OOS from Shopify alone mis-reports those items as blockers.
  let whOrder = null;
  let whStock = new Map();
  let whAllocation = new Map();
  let whError = null;
  const orderNum = String(order.name || '').replace('#', '');
  try {
    const { fetchAllocationIndex } = require('../../../reports/lib/orderAllocation');
    if (orderNum) {
      const skus = (order.lineItems || order.items || []).map(i => i.sku);
      const alloc = await fetchAllocationIndex(skus);
      whOrder = alloc.orders.get(orderNum) || null;
      if (whOrder) {
        whStock = alloc.stockBySku;
        whAllocation = alloc.index;
      }
    }
  } catch (e) {
    whError = e.message;
  }

  // Check inventory
  const inventoryResults = await checkInventory(order);
  investigation.inventory = inventoryResults;

  for (const item of inventoryResults) {
    if (item.error) continue;

    const wh = whStock.get(item.sku) || null;
    if (wh) {
      item.warehouse = {
        on_hand: wh.on_hand ?? 0,
        allocated: wh.allocated ?? 0,
        available: wh.available ?? 0,
        backordered: wh.backordered ?? 0,
      };
    }

    if (item.isPreOrder) {
      investigation.hasPreOrderItems = true;
      investigation.issues.push({
        type: 'pre_order',
        description: item.preOrderTarget
          ? `${item.title} (${item.variant}) is a pre-order. ${item.preOrderTarget}`
          : `${item.title} (${item.variant}) is tagged as pre-order.`,
        item: item.title,
        preOrderTarget: item.preOrderTarget || null,
      });
      continue;
    }

    if (wh) {
      // Whether this item blocks the order is a question about THIS order, so
      // it is answered per-order (orderAllocation.js), never from the SKU
      // counters beside it. Stock on hand is not the same as stock reserved for
      // this customer: units sitting at the warehouse can be entirely spoken
      // for by orders placed earlier, and this branch previously read on_hand
      // alone and told the customer outright that such an item "CAN ship with
      // this order and is NOT a blocker" — an affirmative claim, made wrong,
      // in the reply they read.
      const allocated = orderFullyAllocated(whOrder) === true
        ? true
        : isLineAllocated(whAllocation, orderNum, item.sku);
      if (allocated === true) {
        investigation.issues.push({
          type: 'allocated',
          description: `${item.title} (${item.variant}) shows out of stock on the website, but its unit(s) are reserved for this order at the warehouse — it CAN ship with this order and is NOT a blocker.`,
          item: item.title,
          variant: item.variant,
          sku: item.sku,
        });
      } else if (allocated === false) {
        investigation.hasOutOfStockItems = true;
        const reason = (wh.on_hand ?? 0) > 0
          ? `on hand: ${wh.on_hand}, but reserved for earlier orders`
          : `on hand: 0, backordered: ${wh.backordered ?? 0}`;
        investigation.issues.push({
          type: 'out_of_stock',
          description: `${item.title} (${item.variant}) is not reserved for this order (${reason}) — awaiting stock.`,
          item: item.title,
          variant: item.variant,
          sku: item.sku,
        });
      }
      // allocated === null: the reconstruction has nothing to say about this
      // line. Claiming either way would be a guess in customer-facing text.
    } else if (item.available <= 0) {
      // No warehouse data for this SKU/order — fall back to Shopify availability.
      investigation.hasOutOfStockItems = true;
      investigation.issues.push({
        type: 'out_of_stock',
        description: `${item.title} (${item.variant}) has 0 inventory available. Website may be out of sync.`,
        item: item.title,
        variant: item.variant,
        sku: item.sku,
      });
    }
  }

  // Check for an active Warehance hold — the most common reason a paid, in-stock
  // order sits unfulfilled (e.g. a CS-placed hold from an address/item change
  // that was never released). This is authoritative: if held, THAT is why it
  // hasn't shipped, so it must short-circuit the "stuck/slow" heuristics below —
  // otherwise the advisor reports a held order as "mysteriously stuck" and
  // routes to a human instead of explaining the hold.
  if (whError) {
    investigation.issues.push({
      type: 'hold_check_failed',
      description: `Could not check warehouse hold status: ${whError}`,
    });
  } else {
    if (whOrder && whOrder.has_hold) {
      const holds = [];
      if (whOrder.warehouse_hold) holds.push('warehouse');
      if (whOrder.address_hold) holds.push('address');
      if (whOrder.fraud_hold) holds.push('fraud');
      if (whOrder.payment_hold) holds.push('payment');
      if (whOrder.allocation_hold) holds.push('allocation');
      if (whOrder.store_hold) holds.push('store');
      if (holds.length) {
        investigation.onHold = true;
        investigation.holds = holds;
        investigation.issues.push({
          type: 'hold',
          holds,
          description: `Order is on a ${holds.join(' + ')} hold in the warehouse — that is why it hasn't shipped. An operator can release it once the change it was placed for is done.`,
        });
      }
    }
  }

  // Determine severity. A hold is a KNOWN, resolvable cause — it takes priority
  // and suppresses the stuck/slow heuristics (a held order isn't "stuck").
  // SLA: orders ship within 1 business day. 2 biz days = leeway. Beyond that = flag.
  if (investigation.onHold) {
    investigation.severity = 'attention';
  } else if (investigation.hasOutOfStockItems) {
    investigation.severity = 'urgent';
  } else if (investigation.hasPreOrderItems) {
    investigation.severity = 'attention';
  } else if (businessDays > 3) {
    investigation.severity = 'urgent';
    investigation.issues.push({
      type: 'stuck',
      description: `Order placed ${businessDays} business days ago with no fulfillment and no obvious reason.`,
    });
  } else if (businessDays > 2) {
    investigation.severity = 'attention';
    investigation.issues.push({
      type: 'slow',
      description: `Order placed ${businessDays} business days ago — should have shipped by now.`,
    });
  }

  return investigation;
}

// ---------------------------------------------------------------------------
// Deterministic unfulfilled response builder
// ---------------------------------------------------------------------------

function buildUnfulfilledResponse(investigation, context) {
  const { customerName } = context || {};
  const name = customerName || null;
  const greeting = name ? `Hi ${name}` : 'Hi';
  const parts = [];
  let needsHumanFollowUp = false;

  // Find alternatives for out-of-stock items
  const alternatives = {};
  if (investigation.hasOutOfStockItems) {
    for (const issue of investigation.issues.filter(i => i.type === 'out_of_stock')) {
      const inStock = investigation.inventory.filter(inv =>
        inv.title === issue.item && inv.available > 0 && !inv.error
      );
      if (inStock.length > 0) alternatives[issue.item] = inStock;
    }
  }

  if (investigation.onHold) {
    // On a warehouse/address hold — that's why it hasn't shipped. Reassure
    // (common follow-up: "did I do something wrong?"), explain, and flag for an
    // operator to release (the advisor can't release holds itself).
    parts.push(`${greeting}, you didn't do anything wrong.`);
    parts.push(`Your order is on a brief hold on our end (usually from a recent change like an address or item update), which is why it hasn't shipped yet.`);
    parts.push(`I'm getting that cleared so it ships right away, and you'll get a tracking email once it's on its way.`);
    needsHumanFollowUp = true;

  } else if (investigation.hasPreOrderItems) {
    // Pre-order
    const preOrderItems = investigation.issues.filter(i => i.type === 'pre_order');
    parts.push(`${greeting}, when you placed your order you would have seen a message that ${preOrderItems.length === 1 ? preOrderItems[0].item + ' is' : 'some items are'} a pre-order.`);
    parts.push(`We're still waiting for inventory to arrive at our warehouse.`);
    parts.push(`If you'd prefer not to wait, just let me know and I can process a refund.`);
    needsHumanFollowUp = true;

  } else if (investigation.hasOutOfStockItems) {
    // Out of stock
    const oosItems = investigation.issues.filter(i => i.type === 'out_of_stock');
    parts.push(`${greeting}, I'm sorry for the delay.`);
    for (const item of oosItems) {
      parts.push(`Our warehouse was packing up your order and they let me know the ${item.item} ${item.variant} is out of stock. It seems our website was out of sync with our inventory.`);
      if (alternatives[item.item]) {
        const altList = alternatives[item.item].map(a => a.variant).join(', ');
        parts.push(`We do have ${altList} in stock if you'd like to swap.`);
      }
    }
    if (Object.keys(alternatives).length === 0) {
      parts.push(`Would you like me to refund the order, or wait until we restock?`);
    }
    needsHumanFollowUp = true;

  } else if (investigation.isPartiallyFulfilled) {
    // Partial fulfillment
    parts.push(`${greeting}, part of your order has already shipped but some items are still being sorted out.`);
    parts.push(`I'm looking into the remaining items and will get back to you.`);
    needsHumanFollowUp = true;

  } else if (investigation.businessDays <= 2) {
    // Normal processing (within SLA + leeway)
    const shipDate = addBusinessDays(new Date(), 1);
    const day = relativeDay(shipDate);
    const shipPhrase = (day === 'today' || day === 'tomorrow') ? day : `by ${day}`;
    parts.push(`${greeting}, your order is being prepared and should ship ${shipPhrase}.`);
    parts.push(`You'll get a shipping confirmation email with tracking once it's on its way.`);

  } else if (investigation.businessDays <= 3) {
    // Slightly delayed (past 1-day SLA + leeway)
    const shipDate = addBusinessDays(new Date(), 1);
    const day = relativeDay(shipDate);
    const shipPhrase = (day === 'today' || day === 'tomorrow') ? day : `by ${day}`;
    parts.push(`${greeting}, I'm sorry your order is taking a bit longer than usual to ship.`);
    parts.push(`I'm looking into it and expect it will go out ${shipPhrase}.`);
    needsHumanFollowUp = true;

  } else {
    // Stuck — 3+ business days, should have shipped by now
    parts.push(`${greeting}, I'm sorry for the delay with your order.`);
    parts.push(`I will look into this and get back to you soon.`);
    needsHumanFollowUp = true;
  }

  const prefix = needsHumanFollowUp && investigation.severity === 'urgent' ? 'ACTION REQUIRED — ' : '';
  return { text: prefix + parts.join(' '), needsHumanFollowUp };
}

// ---------------------------------------------------------------------------
// Draft unfulfilled response — deterministic + light AI polish
// ---------------------------------------------------------------------------

async function draftUnfulfilledResponse(investigation, context) {
  const { customerMessage } = context || {};
  const { text, needsHumanFollowUp } = buildUnfulfilledResponse(investigation, context);

  // If no customer message, deterministic response is good enough
  if (!customerMessage) return text;

  // Light AI polish — smooth phrasing only, no added content
  try {
    const response = await callClaude({
      component: 'fulfillment_checker',
      model: MODELS.OPUS,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Lightly smooth this customer service response so it reads naturally. Jamie (RUBIES founder) is warm and direct.

DRAFT:
${text}

CUSTOMER MESSAGE:
"${customerMessage}"

RULES:
- Keep ALL facts, dates, links, and offers EXACTLY as written — change nothing substantive
- Only smooth awkward phrasing or combine choppy sentences
- Do NOT add emotional commentary ("that's frustrating", "I understand how you feel", etc.)
- Do NOT add filler or padding — shorter is better
- Do NOT add a sign-off
- If the draft already reads fine, return it unchanged
- Return ONLY the response`,
      }],
    });
    return response.content[0]?.text || text;
  } catch (e) {
    return text;
  }
}

module.exports = {
  checkInventory,
  analyzeUnfulfilledOrder,
  buildUnfulfilledResponse,
  draftUnfulfilledResponse,
};
