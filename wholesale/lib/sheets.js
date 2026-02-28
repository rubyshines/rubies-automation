const { google } = require('googleapis');

const SHEET_TAB = 'Prospects';

const COLUMNS = [
  { header: 'Score',              field: 'score' },
  { header: 'Company Name',       field: 'company_name' },
  { header: 'City',               field: 'city' },
  { header: 'State',              field: 'state' },
  { header: 'Website',            field: 'website' },
  { header: 'Subcategory',        field: 'subcategory' },
  { header: 'Email',              field: 'email' },
  { header: 'Email Type',         field: 'email_type' },
  { header: 'Phone',              field: 'phone' },
  { header: 'Contact Method',     field: 'contact_method' },
  { header: 'Contact Name',       field: 'contact_name' },
  { header: 'Contact Role',       field: 'contact_role' },
  { header: 'Contact Form',       field: 'contact_form_url' },
  { header: 'Outreach Angle',     field: 'outreach_angle' },
  { header: 'Profile',            field: 'raw_profile' },
  { header: 'Trans/Gender',       field: 'mentions_trans' },
  { header: 'LGBTQ',              field: 'mentions_lgbtq' },
  { header: 'Inclusivity',        field: 'mentions_inclusivity' },
  { header: 'Gender Products',    field: 'carries_gender_products' },
  { header: 'Underwear/Swim',     field: 'carries_underwear_swimwear' },
  { header: 'Indie Owned',        field: 'independently_owned' },
  { header: 'Physical Store',     field: 'has_physical_store' },
  { header: 'Online Store',       field: 'has_online_store' },
  { header: 'Address',            field: 'address' },
  { header: 'Source',             field: 'source' },
  { header: 'Found Date',         field: 'found_date' },
  { header: 'Researched Date',    field: 'researched_date' },
  { header: 'DB ID',              field: 'id' },
];

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
  return COLUMNS.map(col => formatValue(prospect[col.field]));
}

async function syncProspectsToSheet(prospects, { verbose = false } = {}) {
  const sheetId = process.env.WHOLESALE_SHEET_ID;
  if (!sheetId) throw new Error('WHOLESALE_SHEET_ID not set in .env');

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // Build rows: header + data sorted by score desc
  const sorted = [...prospects].sort((a, b) => (b.score || 0) - (a.score || 0));
  const rows = [
    COLUMNS.map(c => c.header),
    ...sorted.map(prospectToRow),
  ];

  // Clear existing content then write fresh
  if (verbose) console.log(`[SHEETS] Clearing "${SHEET_TAB}" tab...`);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:Z`,
  });

  if (verbose) console.log(`[SHEETS] Writing ${sorted.length} prospects...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  // Bold the header row
  const { data: spreadsheet } = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tab = spreadsheet.sheets.find(s => s.properties.title === SHEET_TAB);
  if (tab) {
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

  if (verbose) console.log(`[SHEETS] Done — ${sorted.length} rows written to "${SHEET_TAB}"`);
  return sorted.length;
}

module.exports = { syncProspectsToSheet };
