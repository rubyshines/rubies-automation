/**
 * shopifyClient.js
 * Shopify Analytics via ShopifyQL (GraphQL Admin API) for backfill + daily pipeline.
 *
 * Exports:
 *   fetchShopifyChannels()   - sessions/orders/revenue/AOV/new+returning by channel
 *   fetchShopifyGeography()  - sessions/orders/revenue/conv% by country (top 10, excl. China)
 *
 * Auth:
 *   SHOPIFY_STORE_URL   - your-store.myshopify.com
 *   SHOPIFY_API_KEY     - Admin API key (legacy private app) [optional]
 *   SHOPIFY_PASSWORD    - Admin API password / access token
 *
 * Requires \"read_reports\" permission on your Shopify API credentials.
 */

// Minimal date helper (only used when callers omit explicit dates)
function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_PASSWORD = process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD;
const SHOPIFY_API_VERSION = '2025-10';

const graphqlToken = SHOPIFY_ACCESS_TOKEN || SHOPIFY_PASSWORD;
const hasCredentials = Boolean(SHOPIFY_STORE_URL && graphqlToken);

if (!hasCredentials) {
  console.log(
    '  ⚠️  Shopify env vars missing. Set SHOPIFY_STORE_URL and either ' +
    'SHOPIFY_ACCESS_TOKEN or SHOPIFY_PASSWORD. Shopify metrics will be skipped.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ShopifyQL helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runShopifyQLQuery(shopifyql) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': graphqlToken,
    },
    body: JSON.stringify({
      query: `{
        shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) {
          tableData { columns { name dataType displayName } rows }
          parseErrors
        }
      }`,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL error (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);

  const result = data.data && data.data.shopifyqlQuery;
  if (!result) throw new Error('Unexpected Shopify GraphQL response shape');
  if (result.parseErrors && result.parseErrors.length > 0) {
    throw new Error(`ShopifyQL parse errors: ${result.parseErrors.join(', ')}`);
  }

  return result.tableData;
}

function parseTableData(tableData) {
  if (!tableData || !tableData.rows || !tableData.columns) return [];
  const cols = tableData.columns.map((c) => c.name);
  return tableData.rows.map((row) => {
    const obj = {};
    cols.forEach((col) => { obj[col] = row[col]; });
    return obj;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel mapping
// ─────────────────────────────────────────────────────────────────────────────

function mapChannel(referringMedium) {
  if (!referringMedium) return 'Direct';
  const ch = referringMedium.toLowerCase();
  if (ch === 'search') return 'Search';
  if (ch === 'social') return 'Social';
  if (ch === 'email' || ch === 'email/sms' || ch === 'sms') return 'Email';
  return 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel breakdown
// ─────────────────────────────────────────────────────────────────────────────

async function fetchShopifyChannels(options = {}) {
  if (!hasCredentials) return null;

  let sinceDate;
  let untilDate;
  if (options.startDate != null && options.endDate != null) {
    sinceDate = options.startDate;
    untilDate = options.endDate;
  } else {
    const date = options.date || getYesterdayDate();
    sinceDate = date;
    untilDate = date;
  }

  const sessionsQL = `FROM sessions
  SHOW sessions
  GROUP BY referring_medium
  WHERE session_country != 'China'
  SINCE ${sinceDate} UNTIL ${untilDate}`;

  const salesQL = `FROM sales
  SHOW orders, total_sales, new_customers, returning_customers
  GROUP BY referring_medium
  SINCE ${sinceDate} UNTIL ${untilDate}`;

  let sessionsRows = [];
  let salesRows = [];

  try {
    sessionsRows = parseTableData(await runShopifyQLQuery(sessionsQL));
    console.log(`  ✓ ShopifyQL sessions (excl. China): ${sessionsRows.length} channel row(s)`);
  } catch (err) {
    console.error('  ✗ ShopifyQL sessions query failed:', err.message);
    if (err.message.includes('403') || err.message.toLowerCase().includes('access')) {
      console.error('    → Ensure \"read_reports\" is enabled on your Shopify API credentials');
    }
  }

  try {
    salesRows = parseTableData(await runShopifyQLQuery(salesQL));
    console.log(`  ✓ ShopifyQL sales: ${salesRows.length} channel row(s)`);
  } catch (err) {
    console.error('  ✗ ShopifyQL sales query failed:', err.message);
  }

  if (sessionsRows.length === 0 && salesRows.length === 0) return null;

  const CHANNELS = ['Direct', 'Search', 'Social', 'Email', 'Unknown'];
  const buckets = {};
  for (const ch of CHANNELS) {
    buckets[ch] = { channel: ch, sessions: 0, orders: 0, revenue: 0, newCustomers: 0, returningCustomers: 0 };
  }

  for (const row of sessionsRows) {
    const ch = mapChannel(row.referring_medium);
    buckets[ch].sessions += parseFloat(row.sessions) || 0;
  }

  for (const row of salesRows) {
    const ch = mapChannel(row.referring_medium);
    buckets[ch].orders += parseFloat(row.orders) || 0;
    buckets[ch].revenue += parseFloat(row.total_sales) || 0;
    buckets[ch].newCustomers += parseFloat(row.new_customers) || 0;
    buckets[ch].returningCustomers += parseFloat(row.returning_customers) || 0;
  }

  return CHANNELS.map((ch) => {
    const b = buckets[ch];
    return {
      channel: b.channel,
      sessions: b.sessions,
      orders: b.orders,
      revenue: Math.round(b.revenue * 100) / 100,
      conversionRate: b.sessions > 0 ? Math.round((b.orders / b.sessions) * 100 * 100) / 100 : 0,
      avgOrderValue: b.orders > 0 ? Math.round((b.revenue / b.orders) * 100) / 100 : 0,
      newCustomers: b.newCustomers,
      returningCustomers: b.returningCustomers,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Geography breakdown
// ─────────────────────────────────────────────────────────────────────────────

async function fetchShopifyGeography(options = {}) {
  if (!hasCredentials) return null;

  let sinceDate;
  let untilDate;
  if (options.startDate != null && options.endDate != null) {
    sinceDate = options.startDate;
    untilDate = options.endDate;
  } else {
    const date = options.date || getYesterdayDate();
    sinceDate = date;
    untilDate = date;
  }

  const sessionsQL = `FROM sessions
  SHOW sessions
  GROUP BY session_country
  WHERE session_country != 'China'
  SINCE ${sinceDate} UNTIL ${untilDate}
  LIMIT 10`;

  const salesQL = `FROM sales
  SHOW orders, total_sales
  GROUP BY billing_country
  SINCE ${sinceDate} UNTIL ${untilDate}`;

  let sessionsRows = [];
  let salesRows = [];

  try {
    sessionsRows = parseTableData(await runShopifyQLQuery(sessionsQL));
  } catch (err) {
    console.error('  ✗ ShopifyQL geography sessions failed:', err.message);
  }

  try {
    salesRows = parseTableData(await runShopifyQLQuery(salesQL));
  } catch (err) {
    console.error('  ✗ ShopifyQL geography sales failed:', err.message);
  }

  if (sessionsRows.length === 0 && salesRows.length === 0) return null;

  const map = {};

  for (const row of sessionsRows) {
    const country = row.session_country || 'Unknown';
    if (!map[country]) map[country] = { country, sessions: 0, orders: 0, revenue: 0 };
    map[country].sessions += parseFloat(row.sessions) || 0;
  }

  for (const row of salesRows) {
    const country = row.billing_country || 'Unknown';
    if (!map[country]) map[country] = { country, sessions: 0, orders: 0, revenue: 0 };
    map[country].orders += parseFloat(row.orders) || 0;
    map[country].revenue += parseFloat(row.total_sales) || 0;
  }

  return Object.values(map)
    .sort((a, b) => b.sessions - a.sessions)
    .map((c) => ({
      country: c.country,
      sessions: c.sessions,
      orders: c.orders,
      revenue: Math.round(c.revenue * 100) / 100,
      conversionRate: c.sessions > 0 ? Math.round((c.orders / c.sessions) * 100 * 100) / 100 : 0,
    }));
}

module.exports = { fetchShopifyChannels, fetchShopifyGeography };

