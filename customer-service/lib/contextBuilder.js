/**
 * Shared Context Builder
 *
 * Extracts the common "find customer + find order" plumbing used by all
 * CS message type handlers (exchange advisor, shipping lookup, future handlers).
 *
 * Primary path: reads from Supabase (fast, ~50ms).
 * Fallback: reads from Shopify direct if Supabase data is stale (>1 hour).
 */

const { searchCustomers, getCustomerOrders, getOrderByNumber } = require('./shopify');
const { normalizeSize } = require('./decisionTree');
const { getSupabaseClient } = require('../../shared/supabaseClient');

// Max age before falling back to Shopify (1 hour)
const STALENESS_THRESHOLD_MS = 60 * 60 * 1000;

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
// Supabase row → camelCase GraphQL shape (matches what analyzeOrders expects)
// ---------------------------------------------------------------------------

function supabaseCustomerToShopify(row) {
  if (!row) return null;
  return {
    id: row.shopify_customer_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    defaultAddress: row.default_address ? {
      address1: row.default_address.address1,
      address2: row.default_address.address2,
      city: row.default_address.city,
      province: row.default_address.province,
      country: row.default_address.country,
      countryCodeV2: row.default_address.countryCode,
      zip: row.default_address.zip,
    } : null,
    numberOfOrders: String(row.total_orders || 0),
    amountSpent: row.total_spent != null
      ? { amount: String(row.total_spent), currencyCode: row.total_spent_currency }
      : null,
    createdAt: row.customer_created_at,
    note: row.note,
    tags: row.tags || [],
    _synced_at: row.synced_at,
  };
}

function supabaseOrderToShopify(orderRow, lineItems) {
  return {
    id: orderRow.shopify_order_id,
    name: `#${orderRow.order_number}`,
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at,
    cancelledAt: orderRow.cancelled_at,
    closedAt: orderRow.closed_at,
    displayFulfillmentStatus: orderRow.fulfillment_status,
    displayFinancialStatus: orderRow.financial_status,
    totalPriceSet: {
      shopMoney: { amount: String(orderRow.total_price || 0), currencyCode: orderRow.shop_currency },
      presentmentMoney: { amount: String(orderRow.presentment_total_price || orderRow.total_price || 0), currencyCode: orderRow.presentment_currency || orderRow.shop_currency },
    },
    subtotalPriceSet: {
      shopMoney: { amount: String(orderRow.subtotal_price || 0), currencyCode: orderRow.shop_currency },
    },
    totalShippingPriceSet: {
      shopMoney: { amount: String(orderRow.total_shipping || 0), currencyCode: orderRow.shop_currency },
    },
    shippingAddress: orderRow.shipping_address ? {
      address1: orderRow.shipping_address.address1,
      address2: orderRow.shipping_address.address2,
      city: orderRow.shipping_address.city,
      province: orderRow.shipping_address.province,
      country: orderRow.shipping_address.country,
      countryCodeV2: orderRow.shipping_address.countryCode,
      zip: orderRow.shipping_address.zip,
    } : null,
    fulfillments: orderRow.fulfillments || [],
    note: orderRow.note,
    tags: orderRow.tags || [],
    lineItems: (lineItems || []).map(li => ({
      title: li.title,
      variantTitle: li.variant_title,
      quantity: li.quantity,
      sku: li.sku,
      variant: li.shopify_variant_id ? { id: li.shopify_variant_id } : null,
      originalUnitPriceSet: {
        shopMoney: { amount: String(li.unit_price || 0), currencyCode: li.unit_price_currency },
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Supabase-backed context builder
// ---------------------------------------------------------------------------

async function buildContextFromSupabase(customer_email) {
  const supabase = getSupabaseClient();

  // Fetch customer
  const { data: customerRow } = await supabase
    .from('customers')
    .select('*')
    .eq('email', customer_email.toLowerCase().trim())
    .maybeSingle();

  if (!customerRow) return null;

  // Check staleness — if data is too old, return null to trigger fallback
  if (customerRow.synced_at) {
    const age = Date.now() - new Date(customerRow.synced_at).getTime();
    if (age > STALENESS_THRESHOLD_MS) {
      console.log(`[context] Supabase data for ${customer_email} is ${Math.round(age / 60000)}min old — falling back to Shopify`);
      return null;
    }
  }

  // Fetch orders with line items
  const { data: orderRows } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_email', customer_email.toLowerCase().trim())
    .order('created_at', { ascending: false })
    .limit(20);

  if (!orderRows?.length) {
    // Customer exists but no orders — still return customer context
    return {
      customer: supabaseCustomerToShopify(customerRow),
      orders: [],
      source: 'supabase',
    };
  }

  // Fetch all line items for these orders in one query
  const orderIds = orderRows.map(o => o.shopify_order_id);
  const { data: allLineItems } = await supabase
    .from('order_line_items')
    .select('*')
    .in('shopify_order_id', orderIds);

  // Group line items by order
  const lineItemsByOrder = {};
  for (const li of (allLineItems || [])) {
    if (!lineItemsByOrder[li.shopify_order_id]) lineItemsByOrder[li.shopify_order_id] = [];
    lineItemsByOrder[li.shopify_order_id].push(li);
  }

  // Transform to Shopify-like shapes
  const orders = orderRows.map(o =>
    supabaseOrderToShopify(o, lineItemsByOrder[o.shopify_order_id] || [])
  );

  return {
    customer: supabaseCustomerToShopify(customerRow),
    orders,
    source: 'supabase',
  };
}

// ---------------------------------------------------------------------------
// Shopify-backed context builder (original path)
// ---------------------------------------------------------------------------

async function buildContextFromShopify(customer_email) {
  const customers = await searchCustomers(customer_email);
  const customer = customers[0] || null;
  if (!customer) return null;

  let orders = [];
  try {
    const result = await getCustomerOrders(customer.id, 20);
    orders = result.orders;
  } catch (err) { /* handled below */ }

  return { customer, orders, source: 'shopify' };
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

  // Try Supabase first, fall back to Shopify
  let customerData = null;
  try {
    customerData = await buildContextFromSupabase(customer_email);
  } catch (err) {
    console.warn(`[context] Supabase lookup failed: ${err.message} — falling back to Shopify`);
  }

  if (!customerData) {
    customerData = await buildContextFromShopify(customer_email);
  }

  let customer = customerData?.customer || null;
  let customerGid = customer?.id;
  let customerCountry = customer?.defaultAddress?.countryCodeV2 || customer?.defaultAddress?.country || null;
  let isNorthAmerica = ['US', 'CA'].includes(customerCountry);
  let orders = customerData?.orders || [];

  if (customerData?.source) {
    console.log(`[context] ${customer_email} resolved via ${customerData.source} (${orders.length} orders)`);
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
