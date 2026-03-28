/**
 * Fulfillment Checker — investigates WHY an order hasn't shipped.
 *
 * Checks:
 * 1. Pre-order/backorder (product tags/metafields)
 * 2. Inventory levels (out of stock at warehouse?)
 * 3. Order age (normal processing vs stuck)
 * 4. Partial fulfillment (some items shipped, some didn't)
 *
 * Returns an investigation result with a draft customer response.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getAI() {
  if (!_client) _client = new Anthropic();
  return _client;
}

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
              edges { node { available location { name } } }
            }
          }
        }
      }`;
      const data = await shopifyGraphQL(query);
      const variant = data.productVariant;
      if (!variant) continue;

      const totalAvailable = variant.inventoryItem?.inventoryLevels?.edges?.reduce(
        (sum, e) => sum + (e.node.available || 0), 0
      ) || 0;

      const tags = variant.product?.tags || [];
      const isPreOrder = tags.some(t => /pre-?order|backorder|coming soon/i.test(t));

      results.push({
        title: variant.product?.title || item.title,
        variant: variant.title || item.variant,
        sku: item.sku,
        ordered: item.quantity,
        available: totalAvailable,
        inventoryQuantity: variant.inventoryQuantity,
        isPreOrder,
        tags,
        locations: variant.inventoryItem?.inventoryLevels?.edges?.map(e => ({
          name: e.node.location.name,
          available: e.node.available,
        })) || [],
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

  // Count business days (rough — skip weekends)
  let businessDays = 0;
  const d = new Date(orderDate);
  while (d < now) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) businessDays++;
  }

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

  // Check inventory
  const inventoryResults = await checkInventory(order);
  investigation.inventory = inventoryResults;

  for (const item of inventoryResults) {
    if (item.error) continue;

    if (item.isPreOrder) {
      investigation.hasPreOrderItems = true;
      investigation.issues.push({
        type: 'pre_order',
        description: `${item.title} (${item.variant}) is tagged as pre-order.`,
        item: item.title,
      });
    }

    if (item.available <= 0 && !item.isPreOrder) {
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

  // Determine severity
  if (investigation.hasOutOfStockItems) {
    investigation.severity = 'urgent';
  } else if (investigation.hasPreOrderItems) {
    investigation.severity = 'attention';
  } else if (businessDays > 5) {
    investigation.severity = 'urgent';
    investigation.issues.push({
      type: 'stuck',
      description: `Order placed ${businessDays} business days ago with no fulfillment and no obvious reason.`,
    });
  } else if (businessDays > 2) {
    investigation.severity = 'attention';
    investigation.issues.push({
      type: 'slow',
      description: `Order placed ${businessDays} business days ago — slightly delayed.`,
    });
  }

  return investigation;
}

// ---------------------------------------------------------------------------
// Draft customer response using Sonnet
// ---------------------------------------------------------------------------

async function draftUnfulfilledResponse(investigation, context) {
  const { customerName, isThirdParty, thirdPartyLabel } = context || {};

  // Find available alternatives for out-of-stock items
  let alternativeInfo = '';
  if (investigation.hasOutOfStockItems) {
    const outOfStockItems = investigation.issues.filter(i => i.type === 'out_of_stock');
    for (const item of outOfStockItems) {
      // Check what colors/variants ARE in stock for the same product
      const inStock = investigation.inventory.filter(inv =>
        inv.title === item.item && inv.available > 0 && !inv.error
      );
      if (inStock.length > 0) {
        alternativeInfo += `\nIn stock alternatives for ${item.item}: ${inStock.map(i => `${i.variant} (${i.available} available)`).join(', ')}`;
      }
    }
  }

  const ai = getAI();
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are drafting a customer service response for RUBIES, a gender-affirming underwear brand. An order hasn't shipped yet and you need to explain why.

INVESTIGATION RESULTS:
${JSON.stringify(investigation, null, 2)}
${alternativeInfo ? `\nAVAILABLE ALTERNATIVES:${alternativeInfo}` : ''}

${customerName ? `Customer name: ${customerName}` : 'No customer name — use "Hi!"'}
${isThirdParty ? `Buying for: ${thirdPartyLabel}` : ''}

RULES:
- Be warm and direct — match Jamie's tone (RUBIES founder)
- If pre-order: let them know it's a pre-order item and give any estimated date if available. Ask if they want to keep waiting or prefer a refund.
- If out of stock: apologize sincerely. Say "Our warehouse was packing up your order and they let me know the [product] [color] is out of stock. It seems our website was out of sync with our inventory." Suggest an alternative color/variant if available. If no alternatives, offer a refund.
- If just slow (< 3 business days): reassure them it's being prepared
- If stuck (> 5 business days): apologize and say you're looking into it
- If partially fulfilled: explain some items shipped and the rest are being sorted out
- Do NOT add a sign-off
- If severity is "urgent", prefix with "ACTION REQUIRED — " (this flags it for human review)
- Return ONLY the response text`,
    }],
  });

  return response.content[0]?.text || "I'm looking into the status of your order and will get back to you shortly.";
}

module.exports = {
  checkInventory,
  analyzeUnfulfilledOrder,
  draftUnfulfilledResponse,
};
