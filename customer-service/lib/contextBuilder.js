/**
 * Shared Context Builder
 *
 * Extracts the common "find customer + find order" plumbing used by all
 * CS message type handlers (exchange advisor, shipping lookup, future handlers).
 *
 * Avoids duplicating Shopify lookups across tools.
 */

const { searchCustomers, getCustomerOrders, getOrderByNumber } = require('./shopify');
const { normalizeSize } = require('./decisionTree');

// ---------------------------------------------------------------------------
// Order analysis — split orders into fulfilled vs exchange vs all
// ---------------------------------------------------------------------------

function analyzeOrders(orders) {
  const fulfilled = orders.filter(o =>
    o.displayFulfillmentStatus === 'FULFILLED' &&
    !o.cancelledAt &&
    o.displayFinancialStatus !== 'REFUNDED'
  );
  const exchanges = orders.filter(o =>
    !o.cancelledAt &&
    o.displayFulfillmentStatus !== 'FULFILLED' &&
    parseFloat(o.totalPriceSet?.shopMoney?.amount || '999') === 0
  );
  return { fulfilled, exchanges, all: orders };
}

// ---------------------------------------------------------------------------
// Build full customer + order context from email / order number
// ---------------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {string} params.customer_email
 * @param {string|null} [params.order_number] - explicit order number
 * @param {string|null} [params.issue_description] - customer message (for regex order extraction)
 * @param {Object|null} [params.existingIntake] - previous intake (may contain order_number)
 * @returns {Promise<Object>} ctx
 */
async function buildContext({ customer_email, order_number, issue_description, existingIntake }) {
  // Quick-extract order number from message BEFORE order lookup
  let messageOrderNumber = null;
  if (issue_description) {
    const orderMatch = issue_description.match(/#\s*(\d{4,6})\b/) || issue_description.match(/order\s*#?\s*(\d{4,6})\b/i);
    if (orderMatch) {
      const num = parseInt(orderMatch[1], 10);
      if (num >= 1000 && num <= 999999) messageOrderNumber = orderMatch[1];
    }
  }

  // Find customer
  let customers = await searchCustomers(customer_email);
  let customer = customers[0] || null;
  let customerGid = customer?.id;
  let customerCountry = customer?.defaultAddress?.countryCodeV2 || customer?.defaultAddress?.country || null;
  let isNorthAmerica = ['US', 'CA'].includes(customerCountry);

  // Find orders
  let orders = [];
  if (customer) {
    try {
      const result = await getCustomerOrders(customerGid, 20);
      orders = result.orders;
    } catch (err) { /* handled below */ }
  }

  const { fulfilled, exchanges, all } = analyzeOrders(orders);
  let targetOrder = null;

  // Priority: explicit param > message extraction > previous intake > auto-detect
  const effectiveOrderNumber = order_number || messageOrderNumber || existingIntake?.order_number || null;

  if (effectiveOrderNumber) {
    const normalized = effectiveOrderNumber.toString().replace('#', '');
    targetOrder = all.find(o => o.name?.replace('#', '') === normalized);

    if (!targetOrder) {
      try {
        const orderResult = await getOrderByNumber(effectiveOrderNumber);
        if (orderResult) {
          targetOrder = orderResult;
          const orderCustomerEmail = orderResult.customer?.email;
          if (orderCustomerEmail && orderCustomerEmail.toLowerCase() !== customer_email.toLowerCase()) {
            const orderCustomers = await searchCustomers(orderCustomerEmail);
            if (orderCustomers.length) {
              customer = orderCustomers[0];
              customerGid = customer.id;
              customerCountry = customer.defaultAddress?.countryCodeV2 || customer.defaultAddress?.country || null;
              isNorthAmerica = ['US', 'CA'].includes(customerCountry);
              const result = await getCustomerOrders(customerGid, 20);
              orders = result.orders;
            }
          }
        }
      } catch (err) { /* order not found */ }
    }
  }

  if (!targetOrder) targetOrder = fulfilled[0] || null;

  // Build order line items with normalized SKU sizes
  const orderLineItems = (targetOrder?.lineItems || []).map(li => {
    const rawSkuSize = li.sku ? li.sku.split('-').pop() : null;
    return { ...li, _skuSize: rawSkuSize ? normalizeSize(rawSkuSize) : null, _rawSkuSize: rawSkuSize };
  });

  return {
    customer,
    customerGid,
    customerCountry,
    isNorthAmerica,
    orders,
    fulfilled,
    exchanges,
    all,
    targetOrder,
    orderLineItems,
    effectiveOrderNumber,
  };
}

module.exports = { buildContext, analyzeOrders };
