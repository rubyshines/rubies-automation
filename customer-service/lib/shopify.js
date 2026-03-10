/**
 * Shopify GraphQL Admin API client for customer service operations.
 * Separate from shared/shopifyClient.js (which is ShopifyQL-only for analytics).
 * Uses the same env vars: SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN/SHOPIFY_PASSWORD.
 */

const SHOPIFY_API_VERSION = '2025-10';

function getConfig() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_PASSWORD;
  if (!storeUrl || !token) {
    throw new Error('Missing SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN/SHOPIFY_PASSWORD in .env');
  }
  return { storeUrl, token };
}

async function shopifyGraphQL(query, variables = {}) {
  const { storeUrl, token } = getConfig();
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

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

  const products = data.products.edges.map(e => ({
    ...e.node,
    variants: e.node.variants.edges.map(v => v.node),
  }));

  return {
    products,
    pageInfo: data.products.pageInfo,
  };
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
  const data = await shopifyGraphQL(`
    mutation sendInvoice($id: ID!, $email: DraftOrderInvoiceInput) {
      draftOrderInvoiceSend(id: $id, email: $email) {
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
  `, { id: gid, email: email ? { to: email } : undefined });
  return data.draftOrderInvoiceSend.draftOrder;
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

module.exports = {
  shopifyGraphQL,
  searchCustomers,
  getCustomerOrders,
  getCustomerFulfilledOrders,
  getOrderByNumber,
  fetchAllProducts,
  createDraftOrder,
  deleteDraftOrder,
  completeDraftOrder,
  sendDraftOrderInvoice,
  normalizeGid,
  normalizeOrderNumber,
};
