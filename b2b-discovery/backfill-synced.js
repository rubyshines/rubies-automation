// One-time backfill: mark all prospects already in the sheet as synced_to_sheet = true
require('dotenv').config();
const { google } = require('googleapis');
const { getSupabaseClient } = require('../shared/supabaseClient');

const SHEET_TAB = 'Prospects';
const DB_ID_COL = 'AA'; // Column AA = index 26 (0-based), which is the DB ID column

async function main() {
  const sheetId = process.env.WHOLESALE_SHEET_ID;
  const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read the DB ID column from the sheet (skip header row)
  console.log('Reading DB IDs from sheet...');
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!${DB_ID_COL}2:${DB_ID_COL}10000`,
  });
  const ids = (data.values || []).map(r => r[0]).filter(Boolean);
  console.log(`Found ${ids.length} IDs in sheet`);

  if (ids.length === 0) {
    console.log('Nothing to backfill');
    return;
  }

  // Mark them all as synced in the DB, in batches of 200
  const client = getSupabaseClient();
  let updated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { error } = await client
      .from('retailer_prospects')
      .update({ synced_to_sheet: true })
      .in('id', batch);
    if (error) { console.error('Error:', error.message); continue; }
    updated += batch.length;
  }

  console.log(`Marked ${updated} prospects as synced_to_sheet = true`);
}

main().catch(e => console.error(e.message));
