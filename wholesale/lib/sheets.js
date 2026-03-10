const { google } = require('googleapis');

const SHEET_TAB = 'Prospects';

// Review column is first — user fills this in (Yes / No / Maybe / Contacted)
const COLUMNS = [
  { header: 'Review',           field: null },           // user-filled, always blank on insert
  { header: 'Score',            field: 'score' },
  { header: 'Company Name',     field: 'company_name' },
  { header: 'City',             field: 'city' },
  { header: 'State',            field: 'state' },
  { header: 'Subcategory',      field: 'subcategory' },
  { header: 'Website',          field: 'website' },
  { header: 'Email',            field: 'email' },
  { header: 'Email Type',       field: 'email_type' },
  { header: 'Contact Name',     field: 'contact_name' },
  { header: 'Contact Role',     field: 'contact_role' },
  { header: 'Phone',            field: 'phone' },
  { header: 'Contact Method',   field: 'contact_method' },
  { header: 'Contact Form',     field: 'contact_form_url' },
  { header: 'Outreach Angle',   field: 'outreach_angle' },
  { header: 'Profile',          field: 'raw_profile' },
  { header: 'Trans/Gender',     field: 'mentions_trans' },
  { header: 'LGBTQ',            field: 'mentions_lgbtq' },
  { header: 'Gender Products',  field: 'carries_gender_products' },
  { header: 'Underwear/Swim',   field: 'carries_underwear_swimwear' },
  { header: 'Indie Owned',      field: 'independently_owned' },
  { header: 'Physical Store',   field: 'has_physical_store' },
  { header: 'Online Store',     field: 'has_online_store' },
  { header: 'Address',          field: 'address' },
  { header: 'Found Date',       field: 'found_date' },
  { header: 'Researched Date',  field: 'researched_date' },
  { header: 'DB ID',            field: 'id' },
];

// (DB_ID_COL_INDEX kept for reference but sheet-reading for dedup is replaced by DB flag)
const DB_ID_COL_INDEX = COLUMNS.findIndex(c => c.header === 'DB ID'); // eslint-disable-line no-unused-vars

function getAuthClient() {
  const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function prospectToRow(prospect) {
  return COLUMNS.map(col => col.field ? formatValue(prospect[col.field]) : '');
}


async function boldHeaderRow(sheets, sheetId) {
  const { data: spreadsheet } = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tab = spreadsheet.sheets.find(s => s.properties.title === SHEET_TAB);
  if (!tab) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId: tab.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    },
  });
}

// Insert rows immediately after the header (row index 1) so new prospects appear at the top
async function insertRowsAtTop(sheets, sheetId, rows) {
  const { data: spreadsheet } = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tab = spreadsheet.sheets.find(s => s.properties.title === SHEET_TAB);
  if (!tab) throw new Error(`Tab "${SHEET_TAB}" not found`);
  const tabId = tab.properties.sheetId;

  // Insert blank rows at position 1 (after header)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId: tabId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + rows.length },
          inheritFromBefore: false,
        },
      }],
    },
  });

  // Write data into the newly inserted rows
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A2`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function syncProspectsToSheet(prospects, { verbose = false, fresh = false } = {}) {
  const sheetId = process.env.WHOLESALE_SHEET_ID;
  if (!sheetId) throw new Error('WHOLESALE_SHEET_ID not set in .env');

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const headerRow = COLUMNS.map(c => c.header);

  if (fresh) {
    // Full clear + rewrite sorted by score desc (used for initial load)
    if (verbose) console.log(`[SHEETS] Fresh sync — clearing "${SHEET_TAB}" tab...`);
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${SHEET_TAB}!A:Z` });

    const sorted = [...prospects].sort((a, b) => (b.score || 0) - (a.score || 0));
    const rows = [headerRow, ...sorted.map(prospectToRow)];

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    await boldHeaderRow(sheets, sheetId);
    if (verbose) console.log(`[SHEETS] Done — ${sorted.length} rows written`);
    return sorted.length;
  }

  // Incremental: prospects array is pre-filtered by discover.js using synced_to_sheet flag
  if (prospects.length === 0) {
    if (verbose) console.log(`[SHEETS] No new prospects to add`);
    return 0;
  }

  // Sort by score desc so highest scores appear at top of the new batch
  const sorted = [...prospects].sort((a, b) => (b.score || 0) - (a.score || 0));
  const rows = sorted.map(prospectToRow);

  if (verbose) console.log(`[SHEETS] Inserting ${sorted.length} new prospects at top...`);
  await insertRowsAtTop(sheets, sheetId, rows);

  if (verbose) console.log(`[SHEETS] Done — ${sorted.length} new rows added`);
  return sorted.length;
}

module.exports = { syncProspectsToSheet };
