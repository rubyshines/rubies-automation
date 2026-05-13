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
              address2
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
              shippingAddress {
                address1 address2 city province country countryCodeV2 zip
              }
              totalPriceSet { shopMoney { amount currencyCode } }
              currentTotalPriceSet { shopMoney { amount currencyCode } }
              totalRefundedSet { shopMoney { amount currencyCode } }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    variantTitle
                    quantity
                    currentQuantity
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
      lineItems: e.node.lineItems.edges.map(li => li.node).filter(li => li.currentQuantity > 0),
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
            cancelledAt
            cancelReason
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
              address2
              city
              province
              country
              countryCodeV2
              zip
            }
            totalPriceSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  currentQuantity
                  sku
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  variant { id }
                  customAttributes { key value }
                }
              }
            }
            fulfillments {
              status
              displayStatus
              createdAt
              deliveredAt
              inTransitAt
              estimatedDeliveryAt
              trackingInfo { number url company }
              events(first: 20, sortKey: HAPPENED_AT, reverse: true) {
                edges { node { happenedAt status message } }
              }
            }
            refunds {
              id
              createdAt
              note
              totalRefundedSet { shopMoney { amount currencyCode } }
              transactions(first: 5) {
                edges {
                  node {
                    kind
                    status
                    amountSet { shopMoney { amount currencyCode } }
                  }
                }
              }
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
            shippingAddress {
              address1 address2 city province country countryCodeV2 zip
            }
            totalPriceSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  variantTitle
                  quantity
                  currentQuantity
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
      lineItems: e.node.lineItems.edges.map(li => li.node).filter(li => li.currentQuantity > 0),
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
            seo { title description }
            metafields(first: 50) {
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
                  inventoryItem { id }
                  selectedOptions { name value }
                  metafields(first: 20) {
                    edges {
                      node {
                        namespace
                        key
                        value
                      }
                    }
                  }
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
    const variants = node.variants.edges.map(ve => {
      const v = ve.node;
      const variantMetafields = {};
      for (const mf of (v.metafields?.edges || [])) {
        const { namespace, key, value } = mf.node;
        if (namespace === 'custom') {
          try { variantMetafields[key] = JSON.parse(value); } catch { variantMetafields[key] = value; }
        }
      }
      return { ...v, metafields: variantMetafields };
    });
    return {
      ...node,
      metafields,
      variants,
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
            address2
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

async function updateCustomer(customerId, input) {
  const data = await shopifyGraphQL(`
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          firstName
          lastName
          email
          phone
        }
        userErrors {
          field
          message
        }
      }
    }
  `, { input: { id: normalizeGid(customerId, 'Customer'), ...input } });
  return data.customerUpdate.customer;
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

// Minimal draft fetch used by Phase 2 of create_wholesale_order to regenerate
// the customer-facing price-change summary without re-passing item context.
async function getDraftOrderRecap(draftOrderId) {
  const gid = normalizeGid(draftOrderId, 'DraftOrder');
  const data = await shopifyGraphQL(`
    query draftRecap($id: ID!) {
      draftOrder(id: $id) {
        id
        name
        tags
        lineItems(first: 250) {
          edges {
            node {
              title
              quantity
              variant { id title }
              originalUnitPriceSet { presentmentMoney { amount currencyCode } }
              discountedUnitPriceSet { presentmentMoney { amount currencyCode } }
              appliedDiscount { value valueType title }
            }
          }
        }
      }
    }
  `, { id: gid });
  if (!data.draftOrder) return null;
  return {
    id: data.draftOrder.id,
    name: data.draftOrder.name,
    tags: data.draftOrder.tags || [],
    lineItems: data.draftOrder.lineItems.edges.map(e => e.node),
  };
}

/**
 * Fetch a single open draft order by its display name (e.g. "D6720"). Returns
 * null when no draft with that name exists. Searches both open drafts and any
 * status — Shopify lets a name resolve to a single record across statuses.
 */
async function getDraftOrderByName(name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const queryString = `name:${cleanName}`;
  const data = await shopifyGraphQL(`
    query getDraftByName($query: String!) {
      draftOrders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            status
            invoiceUrl
            totalPrice
            shippingAddress { country countryCodeV2 }
            shippingLine { title shippingRateHandle price }
          }
        }
      }
    }
  `, { query: queryString });
  const edge = data.draftOrders.edges[0];
  return edge ? edge.node : null;
}

/**
 * Update the shipping line on a draft order. Title drives Warehance carrier
 * mapping (Passport DDP / DDU / Fedex / etc.). Price defaults to "0.00" since
 * RUBIES covers shipping.
 */
async function updateDraftOrderShipping(draftOrderId, { title, price = '0.00' }) {
  const gid = normalizeGid(draftOrderId, 'DraftOrder');
  const data = await shopifyGraphQL(`
    mutation updateDraftShipping($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder {
          id
          name
          shippingLine { title price }
        }
        userErrors { field message }
      }
    }
  `, {
    id: gid,
    input: { shippingLine: { title, price } },
  });
  const errs = data.draftOrderUpdate.userErrors || [];
  if (errs.length) {
    throw new Error(`draftOrderUpdate failed: ${errs.map(e => `${e.field}: ${e.message}`).join('; ')}`);
  }
  return data.draftOrderUpdate.draftOrder;
}

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
              displayStatus
              createdAt
              deliveredAt
              inTransitAt
              estimatedDeliveryAt
              trackingInfo { number url company }
              location { legacyResourceId }
              events(first: 20, sortKey: HAPPENED_AT, reverse: true) {
                edges { node { happenedAt status message } }
              }
            }

            # --- Shipping lines ---
            shippingLines(first: 5) {
              edges {
                node {
                  title
                  originalPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }

            # --- Line items ---
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  variantTitle
                  sku
                  quantity
                  currentQuantity
                  variant { id }
                  customAttributes { key value }
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
                      ... on DiscountCodeApplication { code }
                      ... on AutomaticDiscountApplication { title }
                      ... on ScriptDiscountApplication { title }
                      ... on ManualDiscountApplication { title }
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

    // Build per-line-item refunded quantity map from refunds first — we need
    // it to decide whether a currentQuantity=0 item was removed by an order
    // edit (drop) vs fully refunded (keep, with strikethrough on the card).
    const refundedBySkuVariant = {};
    for (const refund of (o.refunds || [])) {
      for (const rli of (refund.refundLineItems?.edges || []).map(e => e.node)) {
        const key = `${rli.lineItem?.sku || ''}::${rli.lineItem?.variantTitle || ''}`;
        refundedBySkuVariant[key] = (refundedBySkuVariant[key] || 0) + rli.quantity;
      }
    }
    o._refundedBySkuVariant = refundedBySkuVariant;

    // Flatten line items — keep when:
    //   • currentQuantity is null (untouched) or > 0 (still in the order), OR
    //   • the item appears in the refunds map (fully refunded — Shopify drops
    //     currentQuantity to 0 even on NO_RESTOCK refunds; we still want to
    //     show it on the order card with strikethrough).
    // Items genuinely removed by order edits (currentQuantity=0, no refund
    // record) are correctly dropped.
    o.lineItems = o.lineItems.edges.map(li => li.node).filter(li => {
      if (li.currentQuantity == null || li.currentQuantity > 0) return true;
      const key = `${li.sku || ''}::${li.variantTitle || ''}`;
      return (refundedBySkuVariant[key] || 0) > 0;
    });

    // Flatten discount applications
    o.discountApplications = (o.discountApplications?.edges || []).map(e => e.node);

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

// --- Order Edit mutations ---

/**
 * Fetch an order with full discount data needed for editing.
 * Returns discount applications, per-line-item discount allocations, variant IDs, and line item IDs.
 */
async function getOrderForEdit(orderNumber) {
  const normalized = normalizeOrderNumber(orderNumber);
  const data = await shopifyGraphQL(`
    query getOrderForEdit($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            customer {
              id
              firstName
              lastName
              email
            }
            shippingAddress {
              address1 address2 city province country countryCodeV2 zip
            }
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            currentTotalPriceSet { shopMoney { amount currencyCode } }
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
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  variantTitle
                  quantity
                  currentQuantity
                  sku
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  variant { id title price }
                  discountAllocations {
                    allocatedAmountSet { shopMoney { amount currencyCode } }
                    discountApplication {
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
              }
            }
            fulfillments { status }
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
    lineItems: order.lineItems.edges.map(e => e.node).filter(li => li.currentQuantity > 0),
    discountApplications: (order.discountApplications?.edges || []).map(e => e.node),
  };
}

/**
 * Begin an order edit session. Returns the calculatedOrder (edit session).
 */
async function orderEditBegin(orderId) {
  const gid = normalizeGid(orderId, 'Order');
  const data = await shopifyGraphQL(`
    mutation orderEditBegin($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder {
          id
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                variantTitle
                quantity
                sku
                variant { id }
                calculatedDiscountAllocations {
                  allocatedAmountSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: gid });
  const calc = data.orderEditBegin.calculatedOrder;
  calc.lineItems = calc.lineItems.edges.map(e => e.node);
  return calc;
}

/**
 * Set line item quantity in an edit session (0 to remove).
 */
async function orderEditSetQuantity(calculatedOrderId, lineItemId, quantity) {
  const data = await shopifyGraphQL(`
    mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, restock: true, quantity: $quantity) {
        calculatedOrder {
          id
          addedLineItems(first: 50) {
            edges {
              node {
                id
                title
                variantTitle
                quantity
                calculatedDiscountAllocations {
                  allocatedAmountSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
        calculatedLineItem {
          id
          quantity
        }
        userErrors { field message }
      }
    }
  `, { id: calculatedOrderId, lineItemId, quantity });
  return data.orderEditSetQuantity;
}

/**
 * Add a variant to an edit session. Returns the new calculatedLineItem.
 */
async function orderEditAddVariant(calculatedOrderId, variantId, quantity) {
  const gid = normalizeGid(variantId, 'ProductVariant');
  const data = await shopifyGraphQL(`
    mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
      orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
        calculatedOrder {
          id
          addedLineItems(first: 50) {
            edges {
              node {
                id
                title
                variantTitle
                quantity
                calculatedDiscountAllocations {
                  allocatedAmountSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
        calculatedLineItem {
          id
          title
          variantTitle
          quantity
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          calculatedDiscountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: calculatedOrderId, variantId: gid, quantity });
  return data.orderEditAddVariant;
}

/**
 * Add a line item discount in an edit session.
 * @param {string} calculatedOrderId
 * @param {string} lineItemId - calculatedLineItem ID
 * @param {{ description: string, percentValue?: number, fixedValue?: { amount: string, currencyCode: string } }} discount
 */
async function orderEditAddLineItemDiscount(calculatedOrderId, lineItemId, discount) {
  const data = await shopifyGraphQL(`
    mutation orderEditAddDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
      orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
        calculatedOrder { id }
        calculatedLineItem {
          id
          calculatedDiscountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
          }
        }
        addedDiscountStagedChange {
          id
          value {
            ... on MoneyV2 { amount currencyCode }
            ... on PricingPercentageValue { percentage }
          }
        }
        userErrors { field message }
      }
    }
  `, { id: calculatedOrderId, lineItemId, discount });
  return data.orderEditAddLineItemDiscount;
}

/**
 * Commit a staged order edit. Returns the final order.
 */
async function orderEditCommit(calculatedOrderId, staffNote, options = {}) {
  const notifyCustomer = options.notifyCustomer !== false;
  const variables = { id: calculatedOrderId, notifyCustomer };
  if (staffNote) variables.staffNote = staffNote;
  const data = await shopifyGraphQL(`
    mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
      orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
        order {
          id
          name
          totalPriceSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          displayFinancialStatus
        }
        userErrors { field message }
      }
    }
  `, variables);
  return data.orderEditCommit.order;
}

/**
 * Send an invoice email for an order's outstanding balance.
 */
async function sendOrderInvoice(orderId) {
  const gid = normalizeGid(orderId, 'Order');
  const data = await shopifyGraphQL(`
    mutation orderInvoiceSend($id: ID!) {
      orderInvoiceSend(id: $id) {
        order { id name }
        userErrors { field message }
      }
    }
  `, { id: gid });
  return data.orderInvoiceSend.order;
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

// Tips appear as Shopify line items at checkout but aren't fulfillable products.
// Filter them out everywhere line items reach the advisor / operator agent so
// the AI doesn't reason about a tip as something to ship, refund, or split.
function isTipLineItem(li) {
  if (!li) return false;
  const title = (li.title || '').trim().toLowerCase();
  if (title !== 'tip') return false;
  if (li.sku) return false;
  if (li.variant?.id || li.shopify_variant_id) return false;
  return true;
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
  if (gid.includes('/DiscountCodeNode/') || gid.includes('/DiscountAutomaticNode/')) {
    return `https://admin.shopify.com/store/${storeName}/discounts/${numericId}`;
  }
  if (gid.includes('/Collection/')) {
    return `https://admin.shopify.com/store/${storeName}/collections/${numericId}`;
  }
  if (gid.includes('/Product/')) {
    return `https://admin.shopify.com/store/${storeName}/products/${numericId}`;
  }
  return `https://admin.shopify.com/store/${storeName}/orders/${numericId}`;
}

/**
 * Generate a random discount code string. 10 hex chars uppercase via
 * crypto.randomBytes — neutral format that fits any discount type
 * (10%, 20%, free product, etc.). The Shopify discount's `title` field
 * carries the descriptive name for admin search; the code itself is opaque.
 */
function randomDiscountCode() {
  const crypto = require('crypto');
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

/**
 * Create a Shopify discount code via the discountCodeBasicCreate mutation.
 * Caller assembles the BasicCodeDiscount input — this helper just wraps the call,
 * surfaces userErrors, and returns the created node so callers can build admin
 * links via getAdminUrl(node.id).
 */
async function createDiscountCode(input) {
  const data = await shopifyGraphQL(`
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `, { basicCodeDiscount: input });
  return data.discountCodeBasicCreate.codeDiscountNode;
}

// --- Product creation ---

/**
 * Create a new product in Shopify (DRAFT status by default).
 * @param {Object} input - ProductInput fields
 * @returns {Object} Created product { id, title, handle, status }
 */
async function createShopifyProduct(input) {
  const data = await shopifyGraphQL(`
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          handle
          status
        }
        userErrors { field message }
      }
    }
  `, { input });
  return data.productCreate.product;
}

/**
 * Bulk-create variants for a product.
 * @param {string} productId - Shopify product GID
 * @param {Array} variants - Array of { optionValues: [{name,optionName}], price, sku }
 * @returns {Array} Created variants
 */
async function createProductVariants(productId, variants) {
  const data = await shopifyGraphQL(`
    mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          sku
          price
        }
        userErrors { field message }
      }
    }
  `, { productId, variants });
  return data.productVariantsBulkCreate.productVariants;
}

/**
 * Bulk-update variant prices on a product.
 * @param {string} productId - Shopify product GID
 * @param {Array<{id: string, price: string|number}>} variantPrices
 * @returns {Array} Updated variants with { id, price }
 */
async function updateVariantPrices(productId, variantPrices) {
  const variants = variantPrices.map(v => ({
    id: v.id,
    price: String(v.price),
  }));
  const data = await shopifyGraphQL(`
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          sku
          price
        }
        userErrors { field message }
      }
    }
  `, { productId, variants });
  return data.productVariantsBulkUpdate.productVariants;
}

/**
 * Update a product's status (e.g., DRAFT → ACTIVE).
 * @param {string} productId - Shopify product GID
 * @param {string} status - "ACTIVE" or "DRAFT"
 */
async function updateProductStatus(productId, status) {
  const data = await shopifyGraphQL(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `, { input: { id: productId, status } });
  return data.productUpdate.product;
}

/**
 * Fetch a single product by numeric ID (for webhook metafield enrichment).
 */
async function fetchProductById(numericId) {
  const gid = normalizeGid(numericId, 'Product');
  const data = await shopifyGraphQL(`
    query fetchProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        status
        tags
        descriptionHtml
        productType
        vendor
        metafields(first: 50) {
          edges {
            node { namespace key value }
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
              inventoryItem { id }
              selectedOptions { name value }
            }
          }
        }
      }
    }
  `, { id: gid });

  if (!data.product) return null;

  const node = data.product;
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
}

/**
 * Update shipping address on an order.
 */
/**
 * Fetch an order with its open fulfillment orders + line items, for use
 * with fulfillmentCreate. Modern Shopify API requires routing fulfillments
 * through fulfillmentOrder ids, not order line item ids directly.
 */
async function getOrderWithFulfillmentOrders(orderNumber) {
  const normalized = normalizeOrderNumber(orderNumber);
  const data = await shopifyGraphQL(`
    query getOrderFulfillmentOrders($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            tags
            note
            customer { id firstName lastName email }
            shippingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCode
              zip
              phone
            }
            fulfillmentOrders(first: 20) {
              edges {
                node {
                  id
                  status
                  requestStatus
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        remainingQuantity
                        totalQuantity
                        lineItem {
                          id
                          title
                          variantTitle
                          sku
                          variant { id }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { query: `name:${normalized}` });
  const order = data.orders.edges[0]?.node;
  if (!order) throw new Error(`Order not found: ${orderNumber}`);
  return {
    ...order,
    fulfillmentOrders: (order.fulfillmentOrders?.edges || []).map(e => ({
      ...e.node,
      lineItems: (e.node.lineItems?.edges || []).map(li => li.node),
    })),
  };
}

/**
 * Create a fulfillment via Shopify's fulfillmentCreate mutation.
 * @param {object} input - FulfillmentInput
 * @param {Array<{fulfillmentOrderId: string, fulfillmentOrderLineItems: Array<{id: string, quantity: number}>}>} input.lineItemsByFulfillmentOrder
 * @param {boolean} [input.notifyCustomer=false]
 * @param {object} [input.trackingInfo] - { number, url, company } — omit for placeholder fulfillments
 */
async function createFulfillment(input) {
  const data = await shopifyGraphQL(`
    mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          createdAt
        }
        userErrors { field message }
      }
    }
  `, { fulfillment: input });
  const result = data.fulfillmentCreate;
  if (result.userErrors?.length) {
    const msg = result.userErrors.map(e => `${(e.field || []).join('.') || 'error'}: ${e.message}`).join('; ');
    throw new Error(`fulfillmentCreate failed: ${msg}`);
  }
  return result.fulfillment;
}

/**
 * Add tags to a Shopify resource (Order, Product, etc.) via tagsAdd.
 */
async function addTags(resourceId, tags) {
  const data = await shopifyGraphQL(`
    mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `, { id: resourceId, tags });
  const result = data.tagsAdd;
  if (result.userErrors?.length) {
    const msg = result.userErrors.map(e => e.message).join('; ');
    throw new Error(`tagsAdd failed: ${msg}`);
  }
  return result.node;
}

/**
 * Append text to an order's note via orderUpdate, preserving any existing
 * note content (separates with a blank line).
 */
async function appendOrderNote(orderId, additionalNote) {
  const existing = await shopifyGraphQL(`
    query getNote($id: ID!) { order(id: $id) { note } }
  `, { id: orderId });
  const prior = existing.order?.note || '';
  const merged = prior ? `${prior}\n\n${additionalNote}` : additionalNote;
  const data = await shopifyGraphQL(`
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `, { input: { id: orderId, note: merged } });
  if (data.orderUpdate.userErrors?.length) {
    const msg = data.orderUpdate.userErrors.map(e => e.message).join('; ');
    throw new Error(`orderUpdate (note) failed: ${msg}`);
  }
  return data.orderUpdate.order;
}

/**
 * Cancel an order via Shopify's orderCancel mutation. Runs as a background
 * job in Shopify — we return the job id; the order may take a few seconds
 * to show as cancelled in admin.
 *
 * @param {string} orderId - Shopify order GID
 * @param {object} opts
 * @param {('CUSTOMER'|'DECLINED'|'FRAUD'|'INVENTORY'|'OTHER'|'STAFF')} [opts.reason='CUSTOMER']
 * @param {boolean} [opts.refund=true] - Refund the customer
 * @param {boolean} [opts.restock=true] - Restock line items
 * @param {boolean} [opts.notifyCustomer=true] - Email the customer
 * @param {string} [opts.staffNote] - Internal note attached to the cancellation
 */
async function cancelOrder(orderId, { reason = 'CUSTOMER', refund = true, restock = true, notifyCustomer = true, staffNote } = {}) {
  const data = await shopifyGraphQL(`
    mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
      orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
        job { id done }
        orderCancelUserErrors { code field message }
        userErrors { field message }
      }
    }
  `, { orderId, reason, refund, restock, notifyCustomer, staffNote });
  const result = data.orderCancel;
  const errors = [
    ...(result.orderCancelUserErrors || []),
    ...(result.userErrors || []),
  ];
  if (errors.length) {
    const msg = errors.map(e => `${(e.field || []).join('.') || e.code || 'error'}: ${e.message}`).join('; ');
    throw new Error(`orderCancel failed: ${msg}`);
  }
  return result.job;
}

async function updateOrderShippingAddress(orderId, shippingAddress) {
  const data = await shopifyGraphQL(`
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order {
          id
          shippingAddress { address1 address2 city province provinceCode zip country countryCodeV2 }
        }
        userErrors { field message }
      }
    }
  `, { input: { id: orderId, shippingAddress } });
  return data.orderUpdate.order;
}

// --- Collection queries / mutations ---

async function fetchAllCollections(cursor = null) {
  const data = await shopifyGraphQL(`
    query fetchCollections($after: String) {
      collections(first: 100, after: $after) {
        edges {
          node {
            id
            handle
            title
            descriptionHtml
            seo { title description }
            ruleSet {
              appliedDisjunctively
              rules { column relation condition }
            }
            productsCount { count }
            products(first: 250) {
              edges { node { handle } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { after: cursor });

  const collections = data.collections.edges.map(e => {
    const node = e.node;
    return {
      id: node.id,
      handle: node.handle,
      title: node.title,
      descriptionHtml: node.descriptionHtml || null,
      seo: node.seo || { title: null, description: null },
      ruleSet: node.ruleSet || null,
      productsCount: node.productsCount?.count ?? 0,
      productHandles: (node.products?.edges || []).map(pe => pe.node.handle),
    };
  });

  return { collections, pageInfo: data.collections.pageInfo };
}

/**
 * Update a collection's handle and/or SEO meta. Pass only the fields you want to change.
 * Shopify auto-generates a 301 redirect when the handle changes.
 * Returns { id, handle, title, seo, urlRedirectId? }.
 */
async function updateCollectionSeo({ id, handle, title, seoTitle, seoDescription, descriptionHtml }) {
  const input = { id };
  if (handle !== undefined) input.handle = handle;
  if (title !== undefined) input.title = title;
  if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
  if (seoTitle !== undefined || seoDescription !== undefined) {
    input.seo = {};
    if (seoTitle !== undefined) input.seo.title = seoTitle;
    if (seoDescription !== undefined) input.seo.description = seoDescription;
  }

  const data = await shopifyGraphQL(`
    mutation collectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          handle
          title
          descriptionHtml
          seo { title description }
        }
        userErrors { field message }
      }
    }
  `, { input });
  return data.collectionUpdate.collection;
}

/**
 * Update a product's handle and/or SEO meta. Pass only the fields you want to change.
 * Shopify auto-generates a 301 redirect when the handle changes.
 */
async function updateProductSeo({ id, handle, title, seoTitle, seoDescription, descriptionHtml }) {
  const input = { id };
  if (handle !== undefined) input.handle = handle;
  if (title !== undefined) input.title = title;
  if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
  if (seoTitle !== undefined || seoDescription !== undefined) {
    input.seo = {};
    if (seoTitle !== undefined) input.seo.title = seoTitle;
    if (seoDescription !== undefined) input.seo.description = seoDescription;
  }

  const data = await shopifyGraphQL(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          handle
          title
          descriptionHtml
          seo { title description }
        }
        userErrors { field message }
      }
    }
  `, { input });
  return data.productUpdate.product;
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
  getDraftOrderRecap,
  getDraftOrderByName,
  updateDraftOrderShipping,
  listDraftOrders,
  normalizeGid,
  isTipLineItem,
  createCustomer,
  updateCustomer,
  createDiscountCode,
  randomDiscountCode,
  normalizeOrderNumber,
  calculateRefund,
  createRefund,
  getAdminUrl,
  createShopifyProduct,
  createProductVariants,
  updateProductStatus,
  updateVariantPrices,
  // Order Edit API
  getOrderForEdit,
  orderEditBegin,
  orderEditSetQuantity,
  orderEditAddVariant,
  orderEditAddLineItemDiscount,
  orderEditCommit,
  sendOrderInvoice,
  updateOrderShippingAddress,
  cancelOrder,
  getOrderWithFulfillmentOrders,
  createFulfillment,
  addTags,
  appendOrderNote,
  fetchProductById,
  fetchAllCollections,
  updateCollectionSeo,
  updateProductSeo,
};
