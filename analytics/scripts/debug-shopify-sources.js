#!/usr/bin/env node
/**
 * Debug script: run the two ShopifyQL queries for a given day and print
 * the raw channel rows so you can validate against Shopify Analytics.
 *
 * Usage (from analytics folder):
 *   node scripts/debug-shopify-sources.js [YYYY-MM-DD]
 * If no date is given, uses yesterday.
 *
 * Compare results to Shopify Admin → Analytics → Sessions by referrer
 * and Sales by channel for the same date.
 *
 * Requires "read_reports" permission on your Shopify API credentials.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getYesterdayDate } = require('../src/utils');

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_PASSWORD = process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const graphqlToken = SHOPIFY_ACCESS_TOKEN || SHOPIFY_PASSWORD;

async function runShopifyQLQuery(shopifyql) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': graphqlToken,
    },
    body: JSON.stringify({
      query: `{ shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) {
        tableData { columns { name dataType displayName } rows }
        parseErrors
      }}`,
    }),
  });
  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  const result = data.data.shopifyqlQuery;
  if (result.parseErrors && result.parseErrors.length > 0) {
    throw new Error(`Parse errors: ${result.parseErrors.join(', ')}`);
  }
  return result.tableData;
}

function parseTableData(tableData) {
  if (!tableData || !tableData.rows) return [];
  const cols = tableData.columns.map((c) => c.name);
  return tableData.rows.map((row) => {
    const obj = {};
    cols.forEach((col) => { obj[col] = row[col]; });
    return obj;
  });
}

function mapChannel(referringMedium) {
  if (!referringMedium) return 'direct';
  const ch = referringMedium.toLowerCase();
  if (ch === 'search') return 'search';
  if (ch === 'social') return 'social';
  if (ch === 'email' || ch === 'email/sms' || ch === 'sms') return 'email';
  return 'unknown';
}

async function main() {
  const date = process.argv[2] || getYesterdayDate();
  console.log(`\nShopifyQL debug for ${date}\n`);

  // Two separate queries — session_country filter is only valid on the sessions
  // table (not in an implicit join), so we run them independently and merge.
  const sessionsQL = `FROM sessions SHOW sessions GROUP BY referring_medium WHERE session_country != 'China' SINCE ${date} UNTIL ${date}`;
  const salesQL    = `FROM sales SHOW orders, net_sales GROUP BY referring_medium SINCE ${date} UNTIL ${date}`;

  console.log('── Sessions (excl. China) ──');
  console.log(`ShopifyQL: ${sessionsQL}\n`);
  let sessRows = [];
  try {
    sessRows = parseTableData(await runShopifyQLQuery(sessionsQL));
    console.table(sessRows);
  } catch (err) { console.error('  ✗', err.message); return; }

  console.log('\n── Sales ──');
  console.log(`ShopifyQL: ${salesQL}\n`);
  let salesRows = [];
  try {
    salesRows = parseTableData(await runShopifyQLQuery(salesQL));
    console.table(salesRows);
  } catch (err) { console.error('  ✗', err.message); return; }

  // Merge for bucket display
  const rows = [];
  const mediums = [...new Set([...sessRows.map(r => r.referring_medium), ...salesRows.map(r => r.referring_medium)])];
  for (const m of mediums) {
    const s = sessRows.find(r => r.referring_medium === m) || {};
    const o = salesRows.find(r => r.referring_medium === m) || {};
    rows.push({ referring_medium: m, sessions: s.sessions || '0', orders: o.orders || '0', net_sales: o.net_sales || '0' });
  }

  // Show how rows map to our five buckets
  console.log('\n── Mapped to buckets (direct/search/social/email/unknown) ──\n');
  const buckets = { direct: { sessions:0,orders:0,revenue:0 }, search: { sessions:0,orders:0,revenue:0 }, social: { sessions:0,orders:0,revenue:0 }, email: { sessions:0,orders:0,revenue:0 }, unknown: { sessions:0,orders:0,revenue:0 } };
  for (const row of rows) {
    const b = mapChannel(row.referring_medium);
    buckets[b].sessions += parseFloat(row.sessions)  || 0;
    buckets[b].orders   += parseFloat(row.orders)    || 0;
    buckets[b].revenue  += parseFloat(row.net_sales) || 0;
  }
  console.table(Object.entries(buckets).map(([name, v]) => ({
    channel: name,
    sessions: v.sessions,
    orders: v.orders,
    revenue: v.revenue.toFixed(2),
    'conv%': v.sessions > 0 ? ((v.orders / v.sessions) * 100).toFixed(2) : '0.00',
  })));

  console.log('\nCompare to: Shopify Admin → Analytics → Sessions by referrer / Sales by channel\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
