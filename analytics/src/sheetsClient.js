/**
 * sheetsClient.js
 * Google Sheets API wrapper — time-series format (dates as rows).
 *
 * Sheets managed:
 *   1. "GA4 Daily"          - one row/day: organic GA4 metrics
 *   2. "GSC Daily Summary"  - one row/day: site-wide Search Console totals
 *   3. "GSC Keywords"       - ~10 rows/day: top keywords by impressions
 *   4. "GSC Pages"          - ~10 rows/day: top pages by clicks
 *   5. "Shopify Daily"      - ~5 rows/day: per-channel Shopify metrics
 *   6. "Shopify Geography"  - ~10 rows/day: per-country Shopify metrics
 *
 * All sheets use the same pattern:
 *   - Column A always contains the date (YYYY-MM-DD)
 *   - Header row is row 1; newest data is inserted at row 2 (newest at top)
 *   - On re-run: existing rows for that date are removed and replaced
 */

const { google } = require('googleapis');
const { getTodayDate } = require('./utils');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Ensure a named tab exists; create it if missing.
 */
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

/**
 * Return the numeric sheetId for a tab (for dimension insert/delete).
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {object} sheets - sheets API client
 * @returns {Promise<number>}
 */
async function getSheetIdByTitle(spreadsheetId, tabName, sheets) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find(
    (s) => s.properties && s.properties.title === tabName,
  );
  if (!sheet || sheet.properties.sheetId == null) {
    throw new Error(`Sheet "${tabName}" not found`);
  }
  return sheet.properties.sheetId;
}

/**
 * Write (or overwrite) the header row in column A:? if it is not already present.
 * Checks cell A1 — if it already contains the first header value, skips the write.
 */
async function ensureHeader(tabName, header, spreadsheetId, sheets) {
  const colLetter = columnLetter(header.length);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:${colLetter}1`,
  });
  const existing = res.data.values && res.data.values[0];
  if (existing && existing[0] === header[0]) return; // already written

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1:${colLetter}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header] },
  });
}

/**
 * Convert a 1-based column index to a letter (1→A, 2→B … 26→Z, 27→AA …).
 */
function columnLetter(n) {
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Read all values from a sheet and return the array-of-arrays.
 */
async function readAllValues(tabName, spreadsheetId, sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A:ZZ`,
  });
  return res.data.values || [];
}

/**
 * Overwrite a tab's entire content (used after removing date rows).
 */
async function writeAllValues(tabName, values, spreadsheetId, sheets) {
  if (values.length === 0) return;
  const cols = columnLetter(Math.max(...values.map((r) => r.length)));
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1:${cols}${values.length}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * Append one or more rows to a tab.
 * Uses a range spanning all data columns so the API finds the table correctly.
 * @param {number} numCols - Number of columns (e.g. header length) so range is A:? not just A:A
 */
async function appendRows(tabName, rows, spreadsheetId, sheets, numCols = 1) {
  const endCol = columnLetter(Math.max(numCols, 1));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:${endCol}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * For single-row-per-day sheets: find the 1-based row number for a date, or null.
 */
function findDateRow(allValues, date) {
  const target = String(date).trim();
  for (let i = 1; i < allValues.length; i++) {
    if (allValues[i][0] && String(allValues[i][0]).trim() === target) {
      return i + 1; // 1-based
    }
  }
  return null;
}

/** Chunk size when scanning column A for a date block (keeps memory bounded on huge sheets). */
const COLUMN_A_CHUNK_SIZE = 5000;

/**
 * For multi-row-per-day sheets: insert new rows at row 2 (newest at top).
 * Reads column A in chunks to find existing block for this date (bounded memory); only writes the new rows.
 */
async function replaceDateRows(tabName, date, newRows, header, spreadsheetId, sheets) {
  const target = String(date).trim();
  const numNew = newRows.length;
  const endCol = columnLetter(Math.max(header.length, ...newRows.map((r) => r.length)));

  // Read column A in chunks so we don't load 100k+ rows into memory
  let startRow0 = null;
  let endRow0Exclusive = null;
  let startRow1Based = 2;

  while (true) {
    const endRow1Based = startRow1Based + COLUMN_A_CHUNK_SIZE - 1;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A${startRow1Based}:A${endRow1Based}`,
    });
    const chunk = res.data.values || [];
    if (chunk.length === 0) break;

    const chunkStart0 = startRow1Based - 2;
    let firstInChunk = null;
    let lastInChunk = null;
    for (let i = 0; i < chunk.length; i++) {
      if (String(chunk[i][0] || '').trim() !== target) continue;
      if (firstInChunk == null) firstInChunk = i;
      lastInChunk = i;
    }
    if (firstInChunk != null && lastInChunk != null) {
      const blockStart = chunkStart0 + firstInChunk;
      const blockEndExcl = chunkStart0 + lastInChunk + 1;
      if (startRow0 == null) startRow0 = blockStart;
      endRow0Exclusive = blockEndExcl;
    } else if (startRow0 != null) {
      break; // left the block (no match in this chunk)
    }
    if (chunk.length < COLUMN_A_CHUNK_SIZE) break;
    startRow1Based = endRow1Based + 1;
  }

  const sheetId = await getSheetIdByTitle(spreadsheetId, tabName, sheets);
  const requests = [];

  // startRow0/endRow0Exclusive are data-relative (0 = first data row = row 2). Convert to sheet 0-based (row 1 = index 0).
  if (startRow0 != null && endRow0Exclusive != null) {
    const sheetStart = startRow0 + 1;
    const sheetEnd = endRow0Exclusive + 1;
    requests.push({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: sheetStart,
          endIndex: sheetEnd,
        },
      },
    });
  }

  requests.push({
    insertDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: 1,
        endIndex: 1 + numNew,
      },
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A2:${endCol}${1 + numNew}`,
    valueInputOption: 'RAW',
    requestBody: { values: newRows },
  });
  return numNew;
}

// ─────────────────────────────────────────────────────────────────────────────
// getLastRunDate  (reads from "GA4 Daily" — the source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the most recent date in the "GA4 Daily" sheet (column A), or null.
 * Data is newest-first (row 2 = most recent). Only reads one cell (A2) — constant memory.
 * @returns {Promise<string|null>}
 */
async function getLastRunDate() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'GA4 Daily'!A2:A2`,
    });
    const values = res.data.values || [];
    if (!values.length || !values[0] || !values[0][0]) return null;
    const firstDataRow = values[0][0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(firstDataRow).trim())) return null;
    return String(firstDataRow).trim();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 1: GA4 Daily
// ─────────────────────────────────────────────────────────────────────────────

const GA4_HEADER = [
  'Date',
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

/**
 * Write one GA4 row for the given date. Newest at top (row 2).
 * Only reads column A; updates one row in place or inserts one row (no full-sheet rewrite).
 */
async function writeGA4Daily(data, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'GA4 Daily';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GA4_HEADER, spreadsheetId, sheets);

  const row = [
    date,
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

  const colEnd = columnLetter(GA4_HEADER.length);

  // Read only column A to see if this date already exists
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A2:A`,
  });
  const colA = res.data.values || [];
  const target = String(date).trim();
  let existingRow1Based = null;
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || '').trim() === target) {
      existingRow1Based = i + 2;
      break;
    }
  }

  if (existingRow1Based) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A${existingRow1Based}:${colEnd}${existingRow1Based}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } else {
    const sheetId = await getSheetIdByTitle(spreadsheetId, tabName, sheets);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
          },
        }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A2:${colEnd}2`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 2: GSC Daily Summary
// ─────────────────────────────────────────────────────────────────────────────

const GSC_SUMMARY_HEADER = [
  'Date',
  'Total Clicks',
  'Total Impressions',
  'Avg CTR (%)',
  'Avg Position',
];

/**
 * Write one GSC summary row for the given date. Newest at top (row 2).
 * Only reads column A; updates one row in place or inserts one row (no full-sheet rewrite).
 */
async function writeGSCSummary(data, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'GSC Daily Summary';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_SUMMARY_HEADER, spreadsheetId, sheets);

  const row = [
    date,
    data.totalClicks,
    data.totalImpressions,
    data.avgCtr,
    data.avgPosition,
  ];

  const colEnd = columnLetter(GSC_SUMMARY_HEADER.length);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A2:A`,
  });
  const colA = res.data.values || [];
  const target = String(date).trim();
  let existingRow1Based = null;
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || '').trim() === target) {
      existingRow1Based = i + 2;
      break;
    }
  }

  if (existingRow1Based) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A${existingRow1Based}:${colEnd}${existingRow1Based}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } else {
    const sheetId = await getSheetIdByTitle(spreadsheetId, tabName, sheets);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
          },
        }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A2:${colEnd}2`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 3: GSC Keywords
// ─────────────────────────────────────────────────────────────────────────────

const GSC_KEYWORDS_HEADER = [
  'Date',
  'Keyword',
  'Rank',
  'Clicks',
  'Impressions',
  'CTR (%)',
];

/**
 * Write keyword rows for the given date.
 * All existing rows for that date are replaced.
 *
 * @param {Array} keywords - Output of fetchGSCKeywords()
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>} rows written
 */
async function writeGSCKeywords(keywords, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'GSC Keywords';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_KEYWORDS_HEADER, spreadsheetId, sheets);

  const rows = keywords.map((kw) => [
    date,
    kw.keyword,
    kw.rank,
    kw.clicks,
    kw.impressions,
    kw.ctr,
  ]);

  return replaceDateRows(tabName, date, rows, GSC_KEYWORDS_HEADER, spreadsheetId, sheets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 4: GSC Pages
// ─────────────────────────────────────────────────────────────────────────────

const GSC_PAGES_HEADER = [
  'Date',
  'Page URL',
  'Clicks',
  'Impressions',
  'Avg Position',
  'CTR (%)',
];

/**
 * Write page rows for the given date.
 * All existing rows for that date are replaced.
 *
 * @param {Array} pages - Output of fetchGSCPages()
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>} rows written
 */
async function writeGSCPages(pages, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'GSC Pages';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, GSC_PAGES_HEADER, spreadsheetId, sheets);

  const rows = pages.map((p) => [
    date,
    p.page,
    p.clicks,
    p.impressions,
    p.avgPosition,
    p.ctr,
  ]);

  return replaceDateRows(tabName, date, rows, GSC_PAGES_HEADER, spreadsheetId, sheets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 5: Shopify Daily
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_DAILY_HEADER = [
  'Date',
  'Channel',
  'Sessions',
  'Orders',
  'Revenue',
  'Conversion Rate (%)',
  'Avg Order Value',
  'New Customers',
  'Returning Customers',
];

/**
 * Write per-channel Shopify rows for the given date.
 * All existing rows for that date are replaced.
 *
 * @param {Array} channels - Output of fetchShopifyChannels()
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>} rows written
 */
async function writeShopifyDaily(channels, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'Shopify Daily';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, SHOPIFY_DAILY_HEADER, spreadsheetId, sheets);

  const rows = channels.map((ch) => [
    date,
    ch.channel,
    ch.sessions,
    ch.orders,
    ch.revenue,
    ch.conversionRate,
    ch.avgOrderValue,
    ch.newCustomers,
    ch.returningCustomers,
  ]);

  return replaceDateRows(tabName, date, rows, SHOPIFY_DAILY_HEADER, spreadsheetId, sheets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 6: Shopify Geography
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_GEO_HEADER = [
  'Date',
  'Country',
  'Sessions',
  'Orders',
  'Revenue',
  'Conversion Rate (%)',
];

/**
 * Write per-country Shopify rows for the given date.
 * All existing rows for that date are replaced.
 *
 * @param {Array} countries - Output of fetchShopifyGeography()
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>} rows written
 */
async function writeShopifyGeography(countries, date) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'Shopify Geography';

  await ensureSheetExists(tabName, spreadsheetId, sheets);
  await ensureHeader(tabName, SHOPIFY_GEO_HEADER, spreadsheetId, sheets);

  const rows = countries.map((c) => [
    date,
    c.country,
    c.sessions,
    c.orders,
    c.revenue,
    c.conversionRate,
  ]);

  return replaceDateRows(tabName, date, rows, SHOPIFY_GEO_HEADER, spreadsheetId, sheets);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getLastRunDate,
  writeGA4Daily,
  writeGSCSummary,
  writeGSCKeywords,
  writeGSCPages,
  writeShopifyDaily,
  writeShopifyGeography,
};
