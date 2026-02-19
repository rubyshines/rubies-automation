/**
 * sheetsClient.js
 * Google Sheets API wrapper.
 *
 * Handles three operations:
 *   1. getLastRunDate()      - Read when the script last ran (for duplicate check)
 *   2. appendDailyMetrics()  - Add a new row to the "Daily Metrics" tab
 *   3. updateKeywordRankings() - Add new columns for today in "Keyword Rankings" tab
 */

const { google } = require('googleapis');
const { getTodayDate } = require('./utils');

/**
 * Build and return an authenticated Google Sheets client.
 * Shared by all three functions below.
 */
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// ─────────────────────────────────────────────────────────────────────────────
// getLastRunDate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the "Daily Metrics" sheet and return the date from the most recent row.
 *
 * The sheet is expected to have a header row (row 1) and then one row per day.
 * Column A of each data row contains the date in YYYY-MM-DD format.
 *
 * @returns {Promise<string|null>} Date string like "2026-02-18", or null if no data exists yet
 */
async function getLastRunDate() {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  // We use a simple fixed tab name so setup in Google Sheets is easy:
  // just create a tab called "Daily Metrics".
  const range = `'Daily Metrics'!A:A`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = response.data.values;

  // Sheet is empty or only has a header row
  if (!values || values.length <= 1) {
    return null;
  }

  // The last row with data is the most recent run
  // values is an array of rows; each row is an array of cell values
  const lastRow = values[values.length - 1];
  const lastDate = lastRow[0];

  // Sanity check: make sure it looks like a date string
  if (!lastDate || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate.trim())) {
    return null;
  }

  return lastDate.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// appendDailyMetrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a new row to the "Daily Metrics" sheet.
 *
 * If the sheet is completely empty, this will also write a header row first.
 *
 * @param {{ sessions: number, users: number, conversionRate: number }} data
 * @param {boolean} isFirstRun - When true, adds "(baseline)" note in the Notes column
 */
async function appendDailyMetrics(data, isFirstRun = false) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'Daily Metrics';

  // Check whether we need to add a header row
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:E1`,
  });

  const hasHeader = existingData.data.values && existingData.data.values.length > 0;

  if (!hasHeader) {
    // Write the header row first
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Date', 'Organic Sessions', 'Organic Users', 'Conversion Rate (%)', 'Notes']],
      },
    });
  }

  const today = getTodayDate();
  const notes = isFirstRun ? 'Baseline (first run)' : '';

  // Append the new data row at the end of the sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        today,
        data.sessions,
        data.users,
        data.conversionRate,
        notes,
      ]],
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// updateKeywordRankings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the "Keyword Rankings" sheet with today's data.
 *
 * Sheet structure:
 *   - Column A: Keyword (static, grows as new keywords are discovered)
 *   - Columns B onward: Groups of 3 columns per day → "[Date] Rank", "[Date] Clicks", "[Date] Impressions"
 *
 * Logic:
 *   1. Read the entire sheet to understand current state
 *   2. Add new column headers for today's date (if not already present)
 *   3. For each keyword in today's data:
 *      - If keyword already exists in column A, update its row
 *      - If keyword is new, add it as a new row
 *
 * @param {Array<{ query: string, impressions: number, clicks: number, position: number, ctr: number }>} keywords
 */
async function updateKeywordRankings(keywords) {
  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = 'Keyword Rankings';
  const today = getTodayDate();

  // Read the entire sheet so we can see all existing keywords and column headers
  const existingResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A:ZZ`,
  });

  let existingValues = existingResponse.data.values || [];

  // ── Step 1: Ensure the header row exists ──────────────────────────────────

  if (existingValues.length === 0) {
    // Sheet is completely empty — create header row
    existingValues = [['Keyword']];
  }

  const headerRow = existingValues[0];

  // ── Step 2: Find or create columns for today's date ──────────────────────

  const rankHeader = `${today} Rank`;
  const clicksHeader = `${today} Clicks`;
  const impressionsHeader = `${today} Impressions`;

  let rankColIndex = headerRow.indexOf(rankHeader);
  let clicksColIndex = headerRow.indexOf(clicksHeader);
  let impressionsColIndex = headerRow.indexOf(impressionsHeader);

  if (rankColIndex === -1) {
    // Today's columns don't exist yet — append them to the header row
    rankColIndex = headerRow.length;
    clicksColIndex = rankColIndex + 1;
    impressionsColIndex = rankColIndex + 2;

    headerRow[rankColIndex] = rankHeader;
    headerRow[clicksColIndex] = clicksHeader;
    headerRow[impressionsColIndex] = impressionsHeader;
  }

  // ── Step 3: Build a map of keyword → row index for quick lookup ───────────

  // existingValues[0] is the header, data rows start at index 1
  const keywordRowMap = {};
  for (let i = 1; i < existingValues.length; i++) {
    const keyword = existingValues[i][0];
    if (keyword) {
      keywordRowMap[keyword.toLowerCase()] = i;
    }
  }

  // ── Step 4: Merge today's keyword data into the grid ─────────────────────

  for (const kw of keywords) {
    const key = kw.query.toLowerCase();
    let rowIndex = keywordRowMap[key];

    if (rowIndex === undefined) {
      // New keyword — add a new row
      rowIndex = existingValues.length;
      existingValues[rowIndex] = [kw.query];
      keywordRowMap[key] = rowIndex;
    }

    // Make sure the row array is long enough to hold today's columns
    while (existingValues[rowIndex].length <= impressionsColIndex) {
      existingValues[rowIndex].push('');
    }

    // Write position (rank), clicks, and impressions into today's columns
    existingValues[rowIndex][rankColIndex] = kw.position;
    existingValues[rowIndex][clicksColIndex] = kw.clicks;
    existingValues[rowIndex][impressionsColIndex] = kw.impressions;
  }

  // ── Step 5: Write the entire updated grid back to the sheet ───────────────

  // Make sure all rows are the same length (pad with empty strings)
  const maxCols = Math.max(...existingValues.map((r) => r.length));
  const paddedValues = existingValues.map((row) => {
    while (row.length < maxCols) row.push('');
    return row;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: paddedValues,
    },
  });
}

module.exports = {
  getLastRunDate,
  appendDailyMetrics,
  updateKeywordRankings,
};
