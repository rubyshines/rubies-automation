/**
 * sheetsClient365.js
 * Writes 365-day summary data to a separate Google Sheet.
 *
 * Same six tabs as the daily sheet, but each row is a single date range (e.g. last 365 days)
 * with aggregated metrics. Headers use "Date Range Start" and "Date Range End".
 *
 * Uses env: GOOGLE_SHEET_ID_365
 */

const { google } = require('googleapis');

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function getSpreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID_365;
  if (!id) throw new Error('GOOGLE_SHEET_ID_365 is not set');
  return id;
}

function columnLetter(n) {
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function ensureSheetExists(tabName, spreadsheetId, sheets) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties && s.properties.title === tabName,
  );
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
}

async function ensureHeader(tabName, header, spreadsheetId, sheets) {
  const colLetter = columnLetter(header.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:${colLetter}1`,
  });
  const existing = res.data.values && res.data.values[0];
  if (existing && existing[0] === header[0]) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1:${colLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header] },
  });
}

async function appendRows(tabName, rows, spreadsheetId, sheets, numCols) {
  if (rows.length === 0) return;
  const endCol = columnLetter(Math.max(numCols, 1));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:${endCol}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GA4 Daily (one row: date range + aggregated metrics)
// ─────────────────────────────────────────────────────────────────────────────

const GA4_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Sessions',
  'Users',
  'New Users',
  'Returning Users',
  'Engaged Sessions',
  'Engagement Rate (%)',
  'Pages per Session',
  'Avg Session Duration (s)',
  'Bounce Rate (%)',
];

async function writeGA4Daily365(data, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'GA4 Daily';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GA4_HEADER_365, spreadsheetId, sheets);

  const row = [
    startDate,
    endDate,
    data.sessions,
    data.users,
    data.newUsers,
    data.returningUsers,
    data.engagedSessions,
    data.engagementRate,
    data.pagesPerSession,
    data.avgSessionDuration,
    data.bounceRate,
  ];

  await appendRows(tabName, [row], spreadsheetId, sheets, GA4_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// GSC Daily Summary (one row)
// ─────────────────────────────────────────────────────────────────────────────

const GSC_SUMMARY_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Total Clicks',
  'Total Impressions',
  'Avg CTR (%)',
  'Avg Position',
];

async function writeGSCSummary365(data, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'GSC Daily Summary';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_SUMMARY_HEADER_365, spreadsheetId, sheets);

  const row = [
    startDate,
    endDate,
    data.totalClicks,
    data.totalImpressions,
    data.avgCtr,
    data.avgPosition,
  ];

  await appendRows(tabName, [row], spreadsheetId, sheets, GSC_SUMMARY_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// GSC Keywords (multiple rows: top keywords over the period)
// ─────────────────────────────────────────────────────────────────────────────

const GSC_KEYWORDS_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Keyword',
  'Rank',
  'Clicks',
  'Impressions',
  'CTR (%)',
];

async function writeGSCKeywords365(keywords, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'GSC Keywords';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_KEYWORDS_HEADER_365, spreadsheetId, sheets);

  const rows = keywords.map((kw) => [
    startDate,
    endDate,
    kw.keyword,
    kw.rank,
    kw.clicks,
    kw.impressions,
    kw.ctr,
  ]);

  await appendRows(tabName, rows, spreadsheetId, sheets, GSC_KEYWORDS_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// GSC Pages (multiple rows: top pages over the period)
// ─────────────────────────────────────────────────────────────────────────────

const GSC_PAGES_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Page URL',
  'Clicks',
  'Impressions',
  'Avg Position',
  'CTR (%)',
];

async function writeGSCPages365(pages, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'GSC Pages';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_PAGES_HEADER_365, spreadsheetId, sheets);

  const rows = pages.map((p) => [
    startDate,
    endDate,
    p.page,
    p.clicks,
    p.impressions,
    p.avgPosition,
    p.ctr,
  ]);

  await appendRows(tabName, rows, spreadsheetId, sheets, GSC_PAGES_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify Daily (multiple rows: one per channel)
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_DAILY_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Channel',
  'Sessions',
  'Orders',
  'Revenue',
  'Conversion Rate (%)',
  'Avg Order Value',
  'New Customers',
  'Returning Customers',
];

async function writeShopifyDaily365(channels, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'Shopify Daily';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, SHOPIFY_DAILY_HEADER_365, spreadsheetId, sheets);

  const rows = channels.map((ch) => [
    startDate,
    endDate,
    ch.channel,
    ch.sessions,
    ch.orders,
    ch.revenue,
    ch.conversionRate,
    ch.avgOrderValue,
    ch.newCustomers,
    ch.returningCustomers,
  ]);

  await appendRows(tabName, rows, spreadsheetId, sheets, SHOPIFY_DAILY_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify Geography (multiple rows: one per country)
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_GEO_HEADER_365 = [
  'Date Range Start',
  'Date Range End',
  'Country',
  'Sessions',
  'Orders',
  'Revenue',
  'Conversion Rate (%)',
];

async function writeShopifyGeography365(countries, startDate, endDate) {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const tabName = 'Shopify Geography';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, SHOPIFY_GEO_HEADER_365, spreadsheetId, sheets);

  const rows = countries.map((c) => [
    startDate,
    endDate,
    c.country,
    c.sessions,
    c.orders,
    c.revenue,
    c.conversionRate,
  ]);

  await appendRows(tabName, rows, spreadsheetId, sheets, SHOPIFY_GEO_HEADER_365.length);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  writeGA4Daily365,
  writeGSCSummary365,
  writeGSCKeywords365,
  writeGSCPages365,
  writeShopifyDaily365,
  writeShopifyGeography365,
};
