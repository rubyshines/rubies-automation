/**
 * Customer LTV (Lifetime Value) MCP Tools
 *
 * Tools: customer_ltv, top_customers_ltv
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');

function fmtCurrency(n, currency = 'AUD') {
  if (n == null || isNaN(n)) return 'N/A';
  const sym = currency === 'USD' ? 'US$' : '$';
  return `${sym}${Number(n).toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

function daysBetween(a, b) {
  return Math.abs(new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24);
}

// ---------------------------------------------------------------------------
// Tool: customer_ltv
// ---------------------------------------------------------------------------

async function handleCustomerLtv({ email }) {
  const supabase = getSupabaseClient();

  // Get customer record
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('email, first_name, last_name, total_orders, total_spent, total_spent_currency, first_order_at, last_order_at')
    .eq('email', email.toLowerCase())
    .single();

  if (custErr || !customer) {
    return { content: [{ type: 'text', text: `No customer found for "${email}".` }] };
  }

  // Get all non-cancelled orders
  const { data: orders, error: ordErr } = await supabase
    .from('orders')
    .select('order_number, created_at, total_price, subtotal_price, total_shipping, total_discounts, total_tax, financial_status, fulfillment_status, shop_currency')
    .eq('customer_email', email.toLowerCase())
    .is('cancelled_at', null)
    .order('created_at', { ascending: true });

  if (ordErr) throw new Error(`Failed to fetch orders: ${ordErr.message}`);

  if (!orders || orders.length === 0) {
    return { content: [{ type: 'text', text: `Customer ${customer.first_name} ${customer.last_name} (${email}) has no orders.` }] };
  }

  // Filter out $0 exchange orders for LTV purposes
  const paidOrders = orders.filter(o => parseFloat(o.total_price) > 0);
  const exchangeOrders = orders.filter(o => parseFloat(o.total_price) === 0);

  const totalRevenue = paidOrders.reduce((sum, o) => sum + parseFloat(o.total_price), 0);
  const totalSubtotal = paidOrders.reduce((sum, o) => sum + parseFloat(o.subtotal_price || 0), 0);
  const totalShipping = paidOrders.reduce((sum, o) => sum + parseFloat(o.total_shipping || 0), 0);
  const totalDiscounts = paidOrders.reduce((sum, o) => sum + parseFloat(o.total_discounts || 0), 0);
  const totalTax = paidOrders.reduce((sum, o) => sum + parseFloat(o.total_tax || 0), 0);

  const avgOrderValue = paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;
  const currency = orders[0].shop_currency || 'AUD';

  // Time-based metrics
  const firstOrder = paidOrders[0]?.created_at;
  const lastOrder = paidOrders[paidOrders.length - 1]?.created_at;
  const lifespanDays = paidOrders.length > 1 ? daysBetween(firstOrder, lastOrder) : 0;
  const avgDaysBetweenOrders = paidOrders.length > 1 ? lifespanDays / (paidOrders.length - 1) : null;

  // Days since last order
  const daysSinceLast = daysBetween(lastOrder, new Date().toISOString());

  let md = `## Customer LTV: ${customer.first_name} ${customer.last_name}\n`;
  md += `**Email:** ${email}\n\n`;

  md += '### Revenue Summary\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Total Revenue (LTV) | **${fmtCurrency(totalRevenue, currency)}** |\n`;
  md += `| Subtotal (products) | ${fmtCurrency(totalSubtotal, currency)} |\n`;
  md += `| Total Shipping | ${fmtCurrency(totalShipping, currency)} |\n`;
  md += `| Total Discounts | ${fmtCurrency(totalDiscounts, currency)} |\n`;
  md += `| Total Tax | ${fmtCurrency(totalTax, currency)} |\n`;
  md += `| Paid Orders | ${paidOrders.length} |\n`;
  if (exchangeOrders.length > 0) {
    md += `| Exchange Orders ($0) | ${exchangeOrders.length} |\n`;
  }
  md += `| Avg Order Value | ${fmtCurrency(avgOrderValue, currency)} |\n`;

  md += '\n### Engagement\n\n';
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| First Order | ${new Date(firstOrder).toLocaleDateString('en-AU')} |\n`;
  md += `| Last Order | ${new Date(lastOrder).toLocaleDateString('en-AU')} |\n`;
  md += `| Customer Lifespan | ${Math.round(lifespanDays)} days |\n`;
  md += `| Avg Days Between Orders | ${avgDaysBetweenOrders != null ? Math.round(avgDaysBetweenOrders) + ' days' : 'N/A (single order)'} |\n`;
  md += `| Days Since Last Order | ${Math.round(daysSinceLast)} days |\n`;

  md += '\n### Order History\n\n';
  md += '| # | Date | Total | Status |\n';
  md += '|---|------|-------|--------|\n';
  for (const o of orders) {
    const total = parseFloat(o.total_price);
    const isExchange = total === 0;
    const label = isExchange ? '(exchange)' : o.fulfillment_status?.toLowerCase() || o.financial_status?.toLowerCase();
    md += `| ${o.order_number} | ${new Date(o.created_at).toLocaleDateString('en-AU')} | ${fmtCurrency(total, currency)} | ${label} |\n`;
  }

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool: top_customers_ltv
// ---------------------------------------------------------------------------

async function handleTopCustomersLtv({ limit, min_orders, sort_by }) {
  const supabase = getSupabaseClient();
  const lim = limit || 20;
  const minOrd = min_orders || 1;
  const sortField = sort_by === 'orders' ? 'total_orders' : 'total_spent';

  let query = supabase
    .from('customers')
    .select('email, first_name, last_name, total_orders, total_spent, total_spent_currency, first_order_at, last_order_at')
    .gte('total_orders', minOrd)
    .gt('total_spent', 0)
    .order(sortField, { ascending: false })
    .limit(lim);

  const { data: customers, error } = await query;
  if (error) throw new Error(`Failed to fetch customers: ${error.message}`);

  if (!customers || customers.length === 0) {
    return { content: [{ type: 'text', text: 'No customers found matching criteria.' }] };
  }

  // Aggregate stats
  const totalCustomers = customers.length;
  const totalRev = customers.reduce((s, c) => s + parseFloat(c.total_spent || 0), 0);
  const totalOrders = customers.reduce((s, c) => s + (c.total_orders || 0), 0);
  const avgLtv = totalRev / totalCustomers;
  const avgOrders = totalOrders / totalCustomers;

  let md = `## Top ${lim} Customers by ${sort_by === 'orders' ? 'Order Count' : 'LTV'}\n`;
  if (minOrd > 1) md += `*Minimum ${minOrd} orders*\n`;
  md += '\n';

  md += `### Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Customers shown | ${totalCustomers} |\n`;
  md += `| Combined revenue | ${fmtCurrency(totalRev)} |\n`;
  md += `| Combined orders | ${totalOrders} |\n`;
  md += `| Avg LTV | ${fmtCurrency(avgLtv)} |\n`;
  md += `| Avg orders per customer | ${avgOrders.toFixed(1)} |\n`;

  md += '\n### Ranking\n\n';
  md += '| Rank | Customer | Email | Orders | LTV | First Order | Last Order |\n';
  md += '|------|----------|-------|--------|-----|-------------|------------|\n';

  customers.forEach((c, i) => {
    const spent = parseFloat(c.total_spent || 0);
    const first = c.first_order_at ? new Date(c.first_order_at).toLocaleDateString('en-AU') : '—';
    const last = c.last_order_at ? new Date(c.last_order_at).toLocaleDateString('en-AU') : '—';
    md += `| ${i + 1} | ${c.first_name || ''} ${c.last_name || ''} | ${c.email} | ${c.total_orders || 0} | ${fmtCurrency(spent)} | ${first} | ${last} |\n`;
  });

  return { content: [{ type: 'text', text: md }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'customer_ltv',
    description: 'Calculate the lifetime value (LTV) of a customer. Shows total revenue, average order value, order frequency, lifespan, and full order history. Excludes $0 exchange orders from revenue calculations.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Customer email address',
        },
      },
      required: ['email'],
    },
    handler: handleCustomerLtv,
  },
  {
    name: 'top_customers_ltv',
    description: 'Show top customers ranked by lifetime value or order count. Returns a leaderboard with revenue, order count, and date ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of customers to return (default: 20)',
        },
        min_orders: {
          type: 'number',
          description: 'Minimum number of orders to include (default: 1)',
        },
        sort_by: {
          type: 'string',
          description: 'Sort by "revenue" (default) or "orders"',
        },
      },
      required: [],
    },
    handler: handleTopCustomersLtv,
  },
];

module.exports = tools;
