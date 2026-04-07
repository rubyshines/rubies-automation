/**
 * Supabase read helpers for CS tools
 *
 * Replaces direct Shopify API calls with Supabase queries for read-only
 * operations. Data is kept fresh by webhooks + daily sync reconciliation.
 *
 * All functions return data in the same camelCase shape that downstream
 * code expects (matching the Shopify GraphQL response format).
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Customer lookup
// ---------------------------------------------------------------------------

/**
 * Search customers by email, name, or phone.
 * Returns array in same shape as shopify.searchCustomers().
 */
async function searchCustomersFromSupabase(query) {
  const supabase = getSupabaseClient();
  const q = query.toLowerCase().trim();

  // Try exact email match first
  const { data: exactMatch } = await supabase
    .from('customers')
    .select('*')
    .eq('email', q)
    .limit(1);

  if (exactMatch?.length) {
    return exactMatch.map(rowToCustomer);
  }

  // Fuzzy search: email contains, name contains, phone contains
  const { data: fuzzy } = await supabase
    .from('customers')
    .select('*')
    .or(`email.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(10);

  return (fuzzy || []).map(rowToCustomer);
}

function rowToCustomer(row) {
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
    ordersCount: row.total_orders || 0,
    amountSpent: row.total_spent != null
      ? { amount: String(row.total_spent), currencyCode: row.total_spent_currency }
      : null,
    totalSpent: row.total_spent != null
      ? { amount: String(row.total_spent), currencyCode: row.total_spent_currency }
      : null,
    createdAt: row.customer_created_at,
    note: row.note,
    tags: row.tags || [],
  };
}

// ---------------------------------------------------------------------------
// Order queries
// ---------------------------------------------------------------------------

/**
 * Get orders for a customer by email or Shopify customer ID.
 * Returns { customer, orders } in same shape as shopify.getCustomerOrders().
 */
async function getCustomerOrdersFromSupabase(customerIdOrEmail, limit = 10) {
  const supabase = getSupabaseClient();

  // Determine if input is email or GID
  const isEmail = customerIdOrEmail.includes('@');
  let customerRow;
  let email;

  if (isEmail) {
    email = customerIdOrEmail.toLowerCase().trim();
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    customerRow = data;
  } else {
    // GID or numeric ID — look up by shopify_customer_id
    let gid = customerIdOrEmail;
    if (!gid.startsWith('gid://')) gid = `gid://shopify/Customer/${gid}`;
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('shopify_customer_id', gid)
      .maybeSingle();
    customerRow = data;
    email = customerRow?.email;
  }

  if (!customerRow || !email) return null;

  const customer = rowToCustomer(customerRow);

  // Fetch orders
  const { data: orderRows } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_email', email)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!orderRows?.length) {
    return { customer, orders: [] };
  }

  // Fetch line items for all orders
  const orderIds = orderRows.map(o => o.shopify_order_id);
  const { data: allLineItems } = await supabase
    .from('order_line_items')
    .select('*')
    .in('shopify_order_id', orderIds);

  const lineItemsByOrder = {};
  for (const li of (allLineItems || [])) {
    if (!lineItemsByOrder[li.shopify_order_id]) lineItemsByOrder[li.shopify_order_id] = [];
    lineItemsByOrder[li.shopify_order_id].push(li);
  }

  const orders = orderRows.map(o => rowToOrder(o, lineItemsByOrder[o.shopify_order_id] || []));

  return { customer, orders };
}

/**
 * Get a single order by order number.
 * Returns same shape as shopify.getOrderByNumber().
 */
async function getOrderByNumberFromSupabase(orderNumber) {
  const supabase = getSupabaseClient();
  const num = parseInt(String(orderNumber).replace(/\D/g, ''), 10);

  const { data: orderRow } = await supabase
    .from('orders')
    .select('*')
    .eq('order_number', num)
    .maybeSingle();

  if (!orderRow) return null;

  // Fetch line items
  const { data: lineItems } = await supabase
    .from('order_line_items')
    .select('*')
    .eq('shopify_order_id', orderRow.shopify_order_id);

  // Fetch customer
  let customer = null;
  if (orderRow.customer_email) {
    const { data: custRow } = await supabase
      .from('customers')
      .select('shopify_customer_id, first_name, last_name, email')
      .eq('email', orderRow.customer_email)
      .maybeSingle();
    if (custRow) {
      customer = {
        id: custRow.shopify_customer_id,
        firstName: custRow.first_name,
        lastName: custRow.last_name,
        email: custRow.email,
      };
    }
  }

  const order = rowToOrder(orderRow, lineItems || []);
  order.customer = customer;
  return order;
}

/**
 * Get fulfilled, non-cancelled, non-refunded orders for a customer.
 * Returns same shape as shopify.getCustomerFulfilledOrders().
 */
async function getCustomerFulfilledOrdersFromSupabase(customerIdOrEmail, limit = 10) {
  const supabase = getSupabaseClient();

  // Resolve email
  let email;
  if (customerIdOrEmail.includes('@')) {
    email = customerIdOrEmail.toLowerCase().trim();
  } else {
    let gid = customerIdOrEmail;
    if (!gid.startsWith('gid://')) gid = `gid://shopify/Customer/${gid}`;
    const { data } = await supabase
      .from('customers')
      .select('email')
      .eq('shopify_customer_id', gid)
      .maybeSingle();
    email = data?.email;
  }

  if (!email) return [];

  const { data: orderRows } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_email', email)
    .eq('fulfillment_status', 'FULFILLED')
    .neq('financial_status', 'REFUNDED')
    .is('cancelled_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!orderRows?.length) return [];

  // Fetch line items
  const orderIds = orderRows.map(o => o.shopify_order_id);
  const { data: allLineItems } = await supabase
    .from('order_line_items')
    .select('*')
    .in('shopify_order_id', orderIds);

  const lineItemsByOrder = {};
  for (const li of (allLineItems || [])) {
    if (!lineItemsByOrder[li.shopify_order_id]) lineItemsByOrder[li.shopify_order_id] = [];
    lineItemsByOrder[li.shopify_order_id].push(li);
  }

  return orderRows.map(o => rowToOrder(o, lineItemsByOrder[o.shopify_order_id] || []));
}

// ---------------------------------------------------------------------------
// Row → Shopify-like shape transformers
// ---------------------------------------------------------------------------

function rowToOrder(orderRow, lineItems) {
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
    totalTaxSet: {
      shopMoney: { amount: String(orderRow.total_tax || 0), currencyCode: orderRow.shop_currency },
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

module.exports = {
  searchCustomersFromSupabase,
  getCustomerOrdersFromSupabase,
  getOrderByNumberFromSupabase,
  getCustomerFulfilledOrdersFromSupabase,
};
