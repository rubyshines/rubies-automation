/**
 * Shared Context Builder
 *
 * Extracts the common "find customer + find order" plumbing used by all
 * CS message type handlers (exchange advisor, shipping lookup, future handlers).
 *
 * Primary path: reads from Supabase (fast, ~50ms).
 * Fallback: reads from Shopify direct if Supabase data is stale (>1 hour).
 */

const { searchCustomers, getCustomerOrders, getOrderByNumber, isTipLineItem } = require('./shopify');
const { extractSizeFromSku } = require('./sizeUtils');
const { getSupabaseClient } = require('../../shared/supabaseClient');

// Max age before falling back to Shopify (1 hour)
const STALENESS_THRESHOLD_MS = 60 * 60 * 1000;

// Gmail treats @googlemail.com as identical to @gmail.com. Normalize so
// lookups match regardless of which alias the customer used.
function normalizeEmail(email) {
  if (!email) return email;
  return email.toLowerCase().trim().replace(/@googlemail\.com$/, '@gmail.com');
}

// Prior-ticket lookup for second-round follow-up context injection.
// Only pulls closed tickets in categories where a prior action might still
// be relevant to a new message (exchange/refund/defect). See domain_cs.md.
const PRIOR_TICKET_MESSAGE_TYPES = ['exchange', 'refund', 'defect'];
const PRIOR_TICKET_LOOKBACK_DAYS = 60;

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
    parseFloat((o.currentTotalPriceSet || o.totalPriceSet)?.shopMoney?.amount || '999') === 0
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
    currentTotalPriceSet: {
      shopMoney: { amount: String(orderRow.current_total_price ?? orderRow.total_price ?? 0), currencyCode: orderRow.shop_currency },
    },
    totalRefundedSet: {
      shopMoney: { amount: String(orderRow.total_refunded || 0), currencyCode: orderRow.shop_currency },
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
    totalDiscountsSet: {
      shopMoney: { amount: String(orderRow.total_discounts || 0), currencyCode: orderRow.shop_currency },
    },
    discountCodes: orderRow.discount_codes || [],
    shippingLines: orderRow.shipping_method ? [{ title: orderRow.shipping_method }] : [],
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

// Name-fallback: used when no customer record was found under the sender's
// email. Runs a Shopify name search and only accepts a unique match to avoid
// wrong-person collisions. The caller must mark the returned context as
// resolvedByName so the advisor prompt can apply its verification gates.
function isValidFullName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 3) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const junk = /^(customer|guest|user|shopper|unknown|n\/?a)$/i;
  if (parts.some(p => junk.test(p))) return false;
  return true;
}

async function buildContextFromShopifyByName(customer_name) {
  if (!isValidFullName(customer_name)) return null;
  const customers = await searchCustomers(customer_name.trim());
  if (customers.length !== 1) return null;
  const customer = customers[0];

  let orders = [];
  try {
    const result = await getCustomerOrders(customer.id, 20);
    orders = result.orders;
  } catch (err) { /* handled below */ }

  return { customer, orders, source: 'shopify-name-fallback' };
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
/**
 * Extract an order number from free-text customer message.
 * Handles: #29784, order #29784, Order number: #29784, order # was 29887, order number 29784
 * Returns the number string or null.
 */
function extractOrderNumber(text) {
  if (!text) return null;
  const match = text.match(/#\s*(\d{4,6})\b/) ||
    text.match(/(?:order|#)\s*(?:#|number|num|no\.?|was|is)?\s*:?\s*(\d{4,6})\b/i);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1000 && num <= 999999) return match[1];
  }
  return null;
}

/**
 * Fetch the most recent closed ticket (exchange/refund/defect) for a customer
 * within the lookback window. Requires a populated history_summary — legacy
 * tickets from before the advisor reliably emitted that field are skipped.
 * Operators can surface legacy context manually via the dashboard's "Copy to
 * steer" helper on the Prior Tickets panel.
 */
async function fetchPriorTicket(customer_email, exclude_gorgias_ticket_id) {
  if (!customer_email) return null;
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - PRIOR_TICKET_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let q = supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, message_type, order_number, closed_at, history_summary')
    .eq('customer_email', customer_email.toLowerCase().trim())
    .eq('status', 'closed')
    .in('message_type', PRIOR_TICKET_MESSAGE_TYPES)
    .gte('closed_at', cutoff)
    .not('history_summary', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1);

  if (exclude_gorgias_ticket_id) {
    q = q.neq('gorgias_ticket_id', exclude_gorgias_ticket_id);
  }

  const { data: rows } = await q;
  const prior = rows?.[0];
  if (!prior) return null;

  return {
    gorgias_ticket_id: prior.gorgias_ticket_id,
    message_type: prior.message_type,
    order_number: prior.order_number,
    closed_at: prior.closed_at,
    history_summary: prior.history_summary,
  };
}

async function buildContext({ customer_email, customer_name, order_number, issue_description, existingIntake, current_gorgias_ticket_id }) {
  const messageOrderNumber = extractOrderNumber(issue_description);
  customer_email = normalizeEmail(customer_email);

  // Try Supabase first, fall back to Shopify (skip if no email — e.g. Facebook Messenger)
  let customerData = null;
  if (customer_email) {
    try {
      customerData = await buildContextFromSupabase(customer_email);
    } catch (err) {
      console.warn(`[context] Supabase lookup failed: ${err.message} — falling back to Shopify`);
    }

    if (!customerData) {
      customerData = await buildContextFromShopify(customer_email);
    }
  }

  // Name fallback: sender's email isn't on any customer record. Try a Shopify
  // name search and accept only a unique match. Flagged so the advisor can
  // apply its verification gates (recent order + message-about-order) before
  // trusting the match.
  let resolvedByName = false;
  if (!customerData && customer_name) {
    const nameMatch = await buildContextFromShopifyByName(customer_name);
    if (nameMatch) {
      customerData = nameMatch;
      resolvedByName = true;
      console.log(`[context] ${customer_email} resolved by name fallback ("${customer_name}") → ${nameMatch.customer.email}`);
    }
  }

  let customer = customerData?.customer || null;
  let customerGid = customer?.id;
  let customerCountry = customer?.defaultAddress?.countryCodeV2 || customer?.defaultAddress?.country || null;
  let isNorthAmerica = ['US', 'CA'].includes(customerCountry);
  let orders = customerData?.orders || [];

  if (customerData?.source) {
    console.log(`[context] ${customer_email} resolved via ${customerData.source} (${orders.length} orders)`);
  }

  // Shopify's getCustomerOrders lags for brand-new customers — the order webhook
  // arrives and populates our orders table before Shopify finishes linking the order
  // to the new customer account. If we resolved via Shopify and got 0 orders, check
  // the Supabase order mirror by email — it's always timely because it's fed by the
  // order webhook, not the customer association.
  if (orders.length === 0 && customer_email && customerData?.source && customerData.source !== 'supabase') {
    try {
      const supabase = getSupabaseClient();
      const { data: mirrorOrders } = await supabase
        .from('orders')
        .select('*')
        .eq('customer_email', customer_email.toLowerCase().trim())
        .order('created_at', { ascending: false })
        .limit(20);

      if (mirrorOrders?.length) {
        const orderIds = mirrorOrders.map(o => o.shopify_order_id);
        const { data: allLineItems } = await supabase
          .from('order_line_items')
          .select('*')
          .in('shopify_order_id', orderIds);
        const lineItemsByOrder = {};
        for (const li of (allLineItems || [])) {
          if (!lineItemsByOrder[li.shopify_order_id]) lineItemsByOrder[li.shopify_order_id] = [];
          lineItemsByOrder[li.shopify_order_id].push(li);
        }
        orders = mirrorOrders.map(o => supabaseOrderToShopify(o, lineItemsByOrder[o.shopify_order_id] || []));
        console.log(`[context] ${customer_email} Shopify orders empty — supplemented from Supabase mirror (${orders.length} orders)`);
      }
    } catch (err) {
      console.warn(`[context] Supabase order mirror fallback failed: ${err.message}`);
    }
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
          targetOrder = {
            ...orderResult,
            lineItems: (orderResult.lineItems || []).filter(li => li.currentQuantity > 0),
          };
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

  if (!targetOrder) {
    // Prefer most recent non-cancelled, non-$0-exchange order (may be unfulfilled)
    const nonExchange = all.filter(o =>
      !o.cancelledAt &&
      parseFloat(o.totalPriceSet?.shopMoney?.amount || '0') > 0
    );
    targetOrder = nonExchange[0] || fulfilled[0] || null;
  }

  // Build order line items with normalized SKU sizes
  const orderLineItems = (targetOrder?.lineItems || [])
    .filter(li => !isTipLineItem(li))
    .map(li => {
      const { raw, normalized } = extractSizeFromSku(li.sku);
      return { ...li, _skuSize: normalized, _rawSkuSize: raw };
    });

  // Prior-ticket context (for second-round follow-ups). Safe to fail — absence
  // of a prior ticket is the common case, not an error.
  let priorTicket = null;
  try {
    priorTicket = await fetchPriorTicket(customer_email, current_gorgias_ticket_id);
  } catch (err) {
    console.warn(`[contextBuilder] fetchPriorTicket failed: ${err.message}`);
  }

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
    resolvedByName,
    conversationEmail: resolvedByName ? customer_email : null,
    priorTicket,
  };
}

module.exports = { buildContext, analyzeOrders, extractOrderNumber, normalizeEmail };
