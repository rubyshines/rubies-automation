/**
 * Shopify GraphQL Admin API client for customer service operations.
 * Separate from shared/shopifyClient.js (which is ShopifyQL-only for analytics).
 * Uses the same env vars: SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN/SHOPIFY_PASSWORD.
 */

const SHOPIFY_API_VERSION = '2025-10';

function getConfig() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD;
  if (!storeUrl || !token) {
    throw new Error('Missing SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN/SHOPIFY_PASSWORD in .env');
  }
  return { storeUrl, token };
}

async function shopifyGraphQL(query, variables = {}, { retries = 3 } = {}) {
  const { storeUrl, token } = getConfig();
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      });

      // Retry on 429 (rate limit) and 5xx
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const waitMs = response.status === 429 ? 2000 * attempt : 1000 * attempt;
        console.error(`[Shopify] ${response.status} on attempt ${attempt}, retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Shopify API error (${response.status}): ${text}`);
      }

      const json = await response.json();
      if (json.errors) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
      }

      // Check for userErrors in mutations
      const dataKeys = Object.keys(json.data || {});
      for (const key of dataKeys) {
        const userErrors = json.data[key]?.userErrors;
        if (userErrors && userErrors.length > 0) {
          throw new Error(`Shopify user errors: ${JSON.stringify(userErrors)}`);
        }
      }

      return json.data;
    } catch (err) {
      // Retry on network errors (ECONNRESET, fetch failed, etc.)
      if (attempt < retries && (err.cause?.code === 'ECONNRESET' || err.message?.includes('fetch failed'))) {
        const waitMs = 2000 * attempt;
        console.error(`[Shopify] Network error on attempt ${attempt}: ${err.message}, retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

// --- Customer queries ---

async function searchCustomers(query) {
  const data = await shopifyGraphQL(`
    query searchCustomers($query: String!) {
      customers(first: 10, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
            defaultAddress {
              address1
              city
              province
              country
              countryCodeV2
              zip
            }
            numberOfOrders
            amountSpent { amount currencyCode }
            createdAt
            note
            tags
          }
        }
      }
    }
  `, { query });
  return data.customers.edges.map(e => e.node);
}

async function getCustomerOrders(customerId, limit = 10, { queryFilter } = {}) {
  const gid = normalizeGid(customerId, 'Customer');
  const variables = { id: gid, first: limit };
  if (queryFilter) variables.query = queryFilter;
  const data = await shopifyGraphQL(`
    query getCustomerOrders($id: ID!, $first: Int!${queryFilter ? ', $query: String' : ''}) {
      customer(id: $id) {
        id
        firstName
        lastName
        email
        orders(first: $first, sortKey: CREATED_AT, reverse: true${queryFilter ? ', query: $query' : ''}) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              cancelledAt
              totalPriceSet { shopMoney { amount currencyCode } }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    variantTitle
                    quantity
                    sku
                  }
                }
              }
            }
          }
        }
      }
    }
  `, variables);
  if (!data.customer) throw new Error(`Customer not found: ${customerId}`);
  return {
    customer: data.customer,
    orders: data.customer.orders.edges.map(e => ({
      ...e.node,
      lineItems: e.node.lineItems.edges.map(li => li.node),
    })),
  };
}

async function getOrderByNumber(orderNumber) {
  const normalized = normalizeOrderNumber(orderNumber);
  const data = await shopifyGraphQL(`
    query getOrder($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              id
              firstName
              lastName
              email
            }
            shippingAddress {
              address1
              city
              province
              country
              countryCodeV2
              zip
            }
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  sku
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  variant { id }
                }
              }
            }
            fulfillments {
              status
              trackingInfo { number url }
            }
            note
            tags
          }
        }
      }
    }
  `, { query: `name:${normalized}` });
  const order = data.orders.edges[0]?.node;
  if (!order) throw new Error(`Order not found: ${orderNumber}`);
  return {
    ...order,
    lineItems: order.lineItems.edges.map(e => e.node),
  };
}

// --- Fulfilled order lookup (for exchanges) ---

/**
 * Find fulfilled, non-cancelled, non-refunded orders for a customer.
 * Uses the TOP-LEVEL orders query (which supports the `query` filter),
 * NOT customer.orders (which does NOT support query filtering).
 */
async function getCustomerFulfilledOrders(customerId, limit = 10) {
  const gid = normalizeGid(customerId, 'Customer');
  const numericId = gid.split('/').pop();
  // Shopify Admin API query syntax for top-level orders connection
  const queryString = `customer_id:${numericId} fulfillment_status:shipped -financial_status:refunded`;
  const data = await shopifyGraphQL(`
    query getFulfilledOrders($query: String!, $first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  sku
                }
              }
            }
          }
        }
      }
    }
  `, { query: queryString, first: limit });

  // Belt-and-suspenders: filter in JS too, in case Shopify's query is imprecise
  return data.orders.edges
    .map(e => ({
      ...e.node,
      lineItems: e.node.lineItems.edges.map(li => li.node),
    }))
    .filter(o =>
      o.displayFulfillmentStatus === 'FULFILLED' &&
      o.displayFinancialStatus !== 'REFUNDED' &&
      !o.cancelledAt
    );
}

// --- Product queries ---

async function fetchAllProducts(cursor = null) {
  const data = await shopifyGraphQL(`
    query fetchProducts($after: String) {
      products(first: 50, after: $after) {
        edges {
          node {
            id
            title
            handle
            status
            tags
            descriptionHtml
            productType
            vendor
            metafields(first: 20) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  selectedOptions { name value }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `, { after: cursor });

  const products = data.products.edges.map(e => {
    const node = e.node;
    // Extract custom metafields into a flat object
    const metafields = {};
    for (const mf of (node.metafields?.edges || [])) {
      const { namespace, key, value } = mf.node;
      if (namespace === 'custom') {
        try { metafields[key] = JSON.parse(value); } catch { metafields[key] = value; }
      }
    }
    return {
      ...node,
      metafields,
      variants: node.variants.edges.map(v => v.node),
    };
  });

  return {
    products,
    pageInfo: data.products.pageInfo,
  };
}

// --- Customer mutations ---

async function createCustomer(input) {
  const data = await shopifyGraphQL(`
    mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          firstName
          lastName
          email
          phone
          defaultAddress {
            address1
            city
            province
            country
            zip
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { input });
  return data.customerCreate.customer;
}

// --- Draft order mutations ---

async function createDraftOrder(input) {
  const data = await shopifyGraphQL(`
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          invoiceUrl
          totalPrice
          subtotalPrice
          presentmentCurrencyCode
          totalPriceSet {
            presentmentMoney { amount currencyCode }
          }
          subtotalPriceSet {
            presentmentMoney { amount currencyCode }
          }
          lineItems(first: 250) {
            edges {
              node {
                title
                variant { id title }
                quantity
                originalUnitPrice
                originalUnitPriceSet {
                  presentmentMoney { amount currencyCode }
                }
                discountedUnitPriceSet {
                  presentmentMoney { amount currencyCode }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { input });
  return data.draftOrderCreate.draftOrder;
}

async function completeDraftOrder(draftOrderId) {
  const gid = normalizeGid(draftOrderId, 'DraftOrder');
  const data = await shopifyGraphQL(`
    mutation completeDraft($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder {
          id
          name
          order { id name }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { id: gid });
  return data.draftOrderComplete.draftOrder;
}

async function deleteDraftOrder(draftOrderId) {
  const gid = normalizeGid(draftOrderId, 'DraftOrder');
  const data = await shopifyGraphQL(`
    mutation deleteDraft($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors {
          field
          message
        }
      }
    }
  `, { input: { id: gid } });
  return data.draftOrderDelete.deletedId;
}

async function sendDraftOrderInvoice(draftOrderId, email) {
  const gid = normalizeGid(draftOrderId, 'DraftOrder');
  const variables = { id: gid };
  let emailParam = '';
  let emailDecl = '';
  if (email) {
    emailDecl = ', $email: EmailInput';
    emailParam = ', email: $email';
    variables.email = { to: email };
  }
  const data = await shopifyGraphQL(`
    mutation sendInvoice($id: ID!${emailDecl}) {
      draftOrderInvoiceSend(id: $id${emailParam}) {
        draftOrder {
          id
          name
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `, variables);
  return data.draftOrderInvoiceSend.draftOrder;
}

// --- Draft order queries ---

async function listDraftOrders({ status, limit = 20 } = {}) {
  const queryParts = [];
  if (status) queryParts.push(`status:${status}`);
  const queryString = queryParts.length ? queryParts.join(' ') : null;

  const variables = { first: limit };
  if (queryString) variables.query = queryString;

  const data = await shopifyGraphQL(`
    query listDraftOrders($first: Int!${queryString ? ', $query: String' : ''}) {
      draftOrders(first: $first, sortKey: UPDATED_AT, reverse: true${queryString ? ', query: $query' : ''}) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            status
            invoiceUrl
            customer {
              id
              email
              firstName
              lastName
            }
            totalPrice
            presentmentCurrencyCode
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variant { id title }
                  quantity
                  originalUnitPrice
                }
              }
            }
            note2
            tags
          }
        }
      }
    }
  `, variables);

  return data.draftOrders.edges.map(e => ({
    ...e.node,
    lineItems: e.node.lineItems.edges.map(li => li.node),
  }));
}

// --- Order sync query (comprehensive, dual-currency) ---

/**
 * Fetch orders for syncing to Supabase. Includes all money fields in both
 * shop and presentment currencies, billing/shipping addresses, discounts,
 * refund totals, and line-item details.
 *
 * @param {string|null} since - ISO date string; only orders updated after this
 * @param {string|null} cursor - pagination cursor
 * @returns {{ orders, pageInfo }}
 */
async function fetchOrdersForSync(since = null, cursor = null) {
  const queryParts = [];
  if (since) queryParts.push(`updated_at:>='${since}'`);
  const queryString = queryParts.join(' ') || null;

  const variables = { first: 50, after: cursor || null };
  if (queryString) variables.query = queryString;

  const data = await shopifyGraphQL(`
    query fetchOrdersForSync($first: Int!, $after: String${queryString ? ', $query: String' : ''}) {
      orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: false${queryString ? ', query: $query' : ''}) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            cancelledAt
            closedAt
            sourceName

            displayFinancialStatus
            displayFulfillmentStatus

            customer {
              id
              email
              firstName
              lastName
            }

            # --- Money: shop currency ---
            totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }

            # --- Addresses ---
            shippingAddress {
              firstName lastName address1 address2 city province provinceCode
              country countryCodeV2 zip phone company
            }
            billingAddress {
              firstName lastName address1 address2 city province provinceCode
              country countryCodeV2 zip phone company
            }

            # --- Discounts ---
            discountCodes
            discountApplications(first: 10) {
              edges {
                node {
                  allocationMethod
                  targetType
                  value {
                    ... on MoneyV2 { amount currencyCode }
                    ... on PricingPercentageValue { percentage }
                  }
                  ... on DiscountCodeApplication { code }
                  ... on AutomaticDiscountApplication { title }
                  ... on ScriptDiscountApplication { title }
                  ... on ManualDiscountApplication { title }
                }
              }
            }

            # --- Fulfillments ---
            fulfillments {
              status
              createdAt
              trackingInfo { number url }
            }

            # --- Line items ---
            lineItems(first: 100) {
              edges {
                node {
                  title
                  variantTitle
                  sku
                  quantity
                  variant { id }
                  originalUnitPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
                  discountAllocations {
                    allocatedAmountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
                    discountApplication {
                      allocationMethod
                      targetType
                      value {
                        ... on MoneyV2 { amount currencyCode }
                        ... on PricingPercentageValue { percentage }
                      }
                    }
                  }
                  duties {
                    price { shopMoney { amount currencyCode } }
                  }
                }
              }
            }

            # --- Refunds (summary only) ---
            refunds {
              createdAt
              refundLineItems(first: 50) {
                edges {
                  node {
                    quantity
                    lineItem { sku variantTitle }
                  }
                }
              }
            }

            note
            tags
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `, variables);

  const orders = data.orders.edges.map(e => {
    const o = e.node;

    // Flatten line items
    o.lineItems = o.lineItems.edges.map(li => li.node);

    // Flatten discount applications
    o.discountApplications = (o.discountApplications?.edges || []).map(e => e.node);

    // Build per-line-item refunded quantity map from refunds
    const refundedBySkuVariant = {};
    for (const refund of (o.refunds || [])) {
      for (const rli of (refund.refundLineItems?.edges || []).map(e => e.node)) {
        const key = `${rli.lineItem?.sku || ''}::${rli.lineItem?.variantTitle || ''}`;
        refundedBySkuVariant[key] = (refundedBySkuVariant[key] || 0) + rli.quantity;
      }
    }
    o._refundedBySkuVariant = refundedBySkuVariant;

    // Earliest fulfillment date
    const fulfillmentDates = (o.fulfillments || [])
      .filter(f => f.createdAt)
      .map(f => new Date(f.createdAt));
    o._earliestFulfillmentDate = fulfillmentDates.length
      ? new Date(Math.min(...fulfillmentDates)).toISOString()
      : null;

    return o;
  });

  return {
    orders,
    pageInfo: data.orders.pageInfo,
  };
}

/**
 * Fetch a single Shopify customer profile by GID.
 */
async function getCustomerProfile(customerId) {
  const gid = normalizeGid(customerId, 'Customer');
  const data = await shopifyGraphQL(`
    query getCustomerProfile($id: ID!) {
      customer(id: $id) {
        id
        firstName
        lastName
        email
        phone
        defaultAddress {
          address1 address2 city province provinceCode
          country countryCodeV2 zip phone company
        }
        numberOfOrders
        amountSpent { amount currencyCode }
        createdAt
        note
        tags
      }
    }
  `, { id: gid });
  return data.customer;
}

// --- Refund queries & mutations ---

/**
 * Calculate a suggested refund for specific line items on an order.
 * Uses Shopify's suggestedRefund to get correct amounts including taxes/duties.
 */
async function calculateRefund(orderId, refundLineItems) {
  const gid = normalizeGid(orderId, 'Order');
  const data = await shopifyGraphQL(`
    query calculateRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]!) {
      order(id: $id) {
        id
        name
        suggestedRefund(refundLineItems: $refundLineItems) {
          amountSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          subtotalSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalTaxSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          refundLineItems {
            lineItem {
              id
              title
              variantTitle
              sku
              quantity
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
            }
            quantity
            subtotalSet {
              shopMoney { amount currencyCode }
            }
          }
          suggestedTransactions {
            gateway
            parentTransaction { id }
            amountSet {
              shopMoney { amount currencyCode }
              presentmentMoney { amount currencyCode }
            }
          }
        }
      }
    }
  `, { id: gid, refundLineItems });
  return {
    order: { id: data.order.id, name: data.order.name },
    ...data.order.suggestedRefund,
  };
}

/**
 * Create a refund on an order.
 * @param {object} input - RefundInput (orderId, refundLineItems, transactions, note, notify)
 */
async function createRefund(input) {
  const data = await shopifyGraphQL(`
    mutation refundCreate($input: RefundInput!) {
      refundCreate(input: $input) {
        refund {
          id
          createdAt
          note
          totalRefundedSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          refundLineItems(first: 50) {
            edges {
              node {
                lineItem {
                  title
                  variantTitle
                  sku
                }
                quantity
                subtotalSet {
                  shopMoney { amount currencyCode }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { input });
  const refund = data.refundCreate.refund;
  if (refund) {
    refund.refundLineItems = (refund.refundLineItems?.edges || []).map(e => e.node);
  }
  return refund;
}

// --- Helpers ---

function normalizeOrderNumber(input) {
  const str = String(input).trim();
  // Accept "1042", "#1042", "RUBIES-1042" → "#1042"
  const match = str.match(/(\d+)$/);
  if (!match) throw new Error(`Invalid order number: ${input}`);
  return `#${match[1]}`;
}

function normalizeGid(id, type) {
  const str = String(id).trim();
  if (str.startsWith('gid://')) return str;
  return `gid://shopify/${type}/${str}`;
}

/**
 * Build a Shopify admin URL for an order or draft order GID.
 * Uses SHOPIFY_ADMIN_STORE env var (the admin slug, e.g. "rubies-active-wear"),
 * falling back to SHOPIFY_STORE_URL with .myshopify.com stripped.
 */
function getAdminUrl(gid) {
  const storeName = process.env.SHOPIFY_ADMIN_STORE
    || (process.env.SHOPIFY_STORE_URL || '').replace('.myshopify.com', '');
  const numericId = gid.split('/').pop();
  if (gid.includes('/DraftOrder/')) {
    return `https://admin.shopify.com/store/${storeName}/draft_orders/${numericId}`;
  }
  return `https://admin.shopify.com/store/${storeName}/orders/${numericId}`;
}

module.exports = {
  shopifyGraphQL,
  searchCustomers,
  getCustomerOrders,
  getCustomerFulfilledOrders,
  getOrderByNumber,
  fetchAllProducts,
  fetchOrdersForSync,
  getCustomerProfile,
  createDraftOrder,
  deleteDraftOrder,
  completeDraftOrder,
  sendDraftOrderInvoice,
  listDraftOrders,
  normalizeGid,
  createCustomer,
  normalizeOrderNumber,
  calculateRefund,
  createRefund,
  getAdminUrl,
};
