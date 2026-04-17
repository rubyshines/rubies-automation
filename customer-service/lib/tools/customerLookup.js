/**
 * Customer lookup tools: lookup_customer, get_customer_orders, get_order_details
 *
 * Reads from Supabase (fast, ~50ms). Falls back to Shopify if not found.
 */

const { searchCustomers, getCustomerOrders, getOrderByNumber } = require('../shopify');
const {
  searchCustomersFromSupabase,
  getCustomerOrdersFromSupabase,
  getOrderByNumberFromSupabase,
} = require('../supabaseQueries');

const tools = [
  {
    name: 'lookup_customer',
    description: 'Find a RUBIES customer by name, email, or phone number. Returns matching customer records with contact info, address, order count, and total spent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Customer name, email address, or phone number to search for',
        },
      },
      required: ['query'],
    },
    handler: async ({ query }) => {
      // Try Supabase first, fall back to Shopify
      let customers = await searchCustomersFromSupabase(query);
      if (!customers.length) {
        customers = await searchCustomers(query);
      }

      if (customers.length === 0) {
        return { content: [{ type: 'text', text: `No customers found matching "${query}"` }] };
      }

      // Supabase `customers` mirror sometimes has `default_address` unpopulated
      // (sync gap). Enrich missing addresses from Shopify live before returning.
      for (const c of customers) {
        if (c.defaultAddress || !c.email) continue;
        try {
          const live = await searchCustomers(`email:${c.email}`);
          const match = live.find(sc => (sc.email || '').toLowerCase() === c.email.toLowerCase());
          if (match?.defaultAddress) c.defaultAddress = match.defaultAddress;
        } catch (_) { /* non-critical */ }
      }

      const formatted = customers.map(c => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)',
        email: c.email,
        phone: c.phone,
        address: c.defaultAddress,
        ordersCount: c.ordersCount,
        totalSpent: c.totalSpent,
        tags: c.tags,
        note: c.note,
        createdAt: c.createdAt,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
  {
    name: 'get_customer_orders',
    description: 'Get recent orders for a specific customer by their Shopify customer ID. Returns order details including items, status, and totals.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Shopify customer ID (GID or numeric)',
        },
        limit: {
          type: 'number',
          description: 'Number of recent orders to return (default: 10)',
        },
      },
      required: ['customer_id'],
    },
    handler: async ({ customer_id, limit }) => {
      // Try Supabase first, fall back to Shopify
      let result = await getCustomerOrdersFromSupabase(customer_id, limit || 10);
      if (!result) {
        result = await getCustomerOrders(customer_id, limit || 10);
      }

      const formatted = {
        customer: {
          id: result.customer.id,
          name: [result.customer.firstName, result.customer.lastName].filter(Boolean).join(' '),
          email: result.customer.email,
        },
        orders: result.orders.map(o => ({
          id: o.id,
          name: o.name,
          createdAt: o.createdAt,
          financialStatus: o.displayFinancialStatus,
          fulfillmentStatus: o.displayFulfillmentStatus,
          total: o.totalPriceSet?.shopMoney,
          items: o.lineItems.map(li => ({
            title: li.title,
            variant: li.variantTitle,
            quantity: li.quantity,
            sku: li.sku,
          })),
        })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
  {
    name: 'get_order_details',
    description: 'Get full details for a specific order by order number. Accepts formats: "1042", "#1042", or "RUBIES-1042".',
    inputSchema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: 'Order number (e.g. "1042", "#1042", or "RUBIES-1042")',
        },
      },
      required: ['order_number'],
    },
    handler: async ({ order_number }) => {
      // Try Supabase first, fall back to Shopify
      let order = await getOrderByNumberFromSupabase(order_number);
      if (!order) {
        order = await getOrderByNumber(order_number);
      }

      const formatted = {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        financialStatus: order.displayFinancialStatus,
        fulfillmentStatus: order.displayFulfillmentStatus,
        customer: order.customer ? {
          id: order.customer.id,
          name: [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' '),
          email: order.customer.email,
        } : null,
        shippingAddress: order.shippingAddress,
        totals: {
          subtotal: order.subtotalPriceSet?.shopMoney,
          shipping: order.totalShippingPriceSet?.shopMoney,
          tax: order.totalTaxSet?.shopMoney,
          total: order.totalPriceSet?.shopMoney,
        },
        items: order.lineItems.map(li => ({
          title: li.title,
          variant: li.variantTitle,
          quantity: li.quantity,
          sku: li.sku,
          unitPrice: li.originalUnitPriceSet?.shopMoney,
          variantId: li.variant?.id,
        })),
        fulfillments: order.fulfillments,
        note: order.note,
        tags: order.tags,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      };
    },
  },
];

module.exports = tools;
