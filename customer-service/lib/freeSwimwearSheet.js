/**
 * Free Swimwear — write operational status back to the Google Sheet.
 *
 * TEMPORARY BRIDGE (Jamie's request, 2026-06-26): while the program transitions
 * from the sheet to the dashboard, mirror each decision/lifecycle change back to
 * the original "Form Responses 1" tab so the familiar sheet stays current. The
 * dashboard/Supabase remains the source of truth — this is a one-way mirror.
 *
 * done_when: Jamie trusts the dashboard and no longer wants the sheet updated.
 * Disable by setting env FSW_SHEET_WRITEBACK=0 (no deploy needed), then delete
 * this module + its call sites.
 *
 * Columns F:O of Form Responses 1 are exactly the operational fields, in order:
 *   F status | G resend status | H discount code | I Shopify customer id
 *   J registration date | K order numbers | L order dates | M expiry date
 *   N last acceptance send date | O number of send attempts
 * so a single contiguous range write per row covers all of them.
 */

const { getSheetsClient } = require('../../shared/googleSheetsClient');
const { SHEET_ID } = require('./freeSwimwearSurvey');

const TAB = 'Form Responses 1';
const ENABLED = process.env.FSW_SHEET_WRITEBACK !== '0';

function val(v) {
  return v == null ? '' : v;
}
function list(a) {
  return Array.isArray(a) ? a.join(' | ') : (a || '');
}

/**
 * Mirror a request's operational columns to its sheet row. Fail-soft: never
 * throws (a sheet hiccup must not break an approval). Only current-form rows
 * map to a sheet row.
 * @param {Object} row - a free_swimwear_requests row (post-update state)
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
 */
async function writeBackToSheet(row) {
  if (!ENABLED) return { ok: false, skipped: 'disabled' };
  if (row.source !== 'form' || !row.sheet_row) return { ok: false, skipped: 'no-sheet-row' };
  try {
    const sheets = await getSheetsClient();
    const values = [[
      val(row.status),
      val(row.resend_status),
      val(row.discount_code),
      val(row.shopify_customer_id),
      val(row.registration_date),
      list(row.order_numbers),
      list(row.order_dates),
      val(row.expiry_date),
      val(row.last_acceptance_send_date),
      row.send_attempts == null ? '' : row.send_attempts,
    ]];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${TAB}'!F${row.sheet_row}:O${row.sheet_row}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    return { ok: true };
  } catch (e) {
    console.warn(`[freeSwimwear] sheet writeback failed for row ${row.sheet_row}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { writeBackToSheet, ENABLED };
