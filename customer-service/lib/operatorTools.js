/**
 * Shared tool loader for the operator agents.
 *
 * Both the ticket-bound operator (operatorAgent.js) and the ad hoc standalone
 * console (operatorAgentStandalone.js) call this so they always have an
 * identical tool surface. Mirrors customer-service/server.js's full tool
 * registration list, minus two self-referential modules:
 *   - csAdvisorMcp:  would let the operator call the advisor on itself
 *   - advisorTester: dev-only harness, not useful at runtime
 *
 * To add a tool to both agents, add it here and to server.js. To
 * deliberately scope a tool to one agent only, fork at the call site.
 */

function loadAllOperatorTools() {
  const toolModules = [
    require('./tools/customerLookup'),
    require('./tools/productSearch'),
    require('./tools/exchangeOrder'),
    require('./tools/wholesaleOrder'),
    require('./tools/invoiceOrder'),
    require('./tools/reloadProducts'),
    require('./tools/seoTrends'),
    require('./tools/klaviyo'),
    require('./tools/csHistory'),
    require('./tools/csKnowledge'),
    require('./tools/csAdmin'),
    require('./tools/margins'),
    require('./tools/reviews'),
    require('./tools/inventory'),
    require('./tools/blogResearch'),
    require('./tools/draftOrders'),
    require('./tools/adminTools'),
    require('./tools/ltv'),
    require('./tools/createOrder'),
    require('./tools/refundOrder'),
    require('./tools/shippingLookup'),
    require('./tools/shippingInfo'),
    require('./tools/orderNotes'),
    require('./tools/deliveryEstimate'),
    require('./tools/passportClaims'),
    require('./tools/editOrder'),
    require('./tools/deliveryTimeReport'),
    require('./tools/setPrices'),
    require('./tools/updateCustomer'),
    require('./tools/discountCode'),
    require('./tools/cancelOrder'),
    require('./tools/splitShipment'),
    require('./tools/consolidateOrders'),
    require('./tools/seoMeta'),
    require('./tools/createOutreachTicket'),
    require('./tools/warehouseAllocation'),
    require('./tools/donationPartners'),
  ];

  const tools = [];
  const handlers = {};

  for (const mod of toolModules) {
    for (const tool of mod) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
      handlers[tool.name] = tool.handler;
    }
  }

  return { tools, handlers };
}

module.exports = { loadAllOperatorTools };
