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
 * The target row is found LIVE by matching (submitted_at, email) — the sheet
 * gets re-sorted, so the stored sheet_row is not a safe write target. Columns
 * F:O of Form Responses 1 are exactly the operational fields, in order:
 *   F status | G resend status | H discount code | I Shopify customer id
 *   J registration date | K order numbers | L order dates | M expiry date
 *   N last acceptance send date | O number of send attempts
 */

const { getSheetsClient } = require('../../shared/googleSheetsClient');
const { SHEET_ID, parseTimestamp } = require('./freeSwimwearSurvey');

const TAB = 'Form Responses 1';
const ENABLED = process.env.FSW_SHEET_WRITEBACK !== '0';

function val(v) {
  return v == null ? '' : v;
}
function list(a) {
  return Array.isArray(a) ? a.join(' | ') : (a || '');
}

/**
 * Find the 1-indexed sheet row whose timestamp+email match a request. Pure, so
 * it's unit-testable. Returns { row } on a unique match, or { error } when there
 * are zero or multiple matches (we never write to a guessed row).
 * @param {Array<Array<string>>} abRows - values from columns A:B (A=timestamp, B=email), incl. header
 * @param {{submitted_at:?string, email:string}} target
 */
function findSheetRow(abRows, target) {
  const email = (target.email || '').toLowerCase();
  const matches = [];
  for (let i = 1; i < abRows.length; i++) { // i=0 is the header row
    const r = abRows[i] || [];
    if ((r[1] || '').toLowerCase() !== email) continue;
    if (parseTimestamp(r[0]) !== target.submitted_at) continue;
    matches.push(i + 1); // 1-indexed sheet row
  }
  if (matches.length === 1) return { row: matches[0] };
  return { error: `${matches.length} sheet rows matched (${target.email} @ ${target.submitted_at})` };
}

/**
 * Mirror a request's operational columns to its sheet row. Fail-soft: never
 * throws (a sheet hiccup must not break an approval). Only current-form rows
 * map to a sheet row, and only via a live (submitted_at, email) lookup.
 * @param {Object} row - a free_swimwear_requests row (post-update state)
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, row?:number}>}
 */
async function writeBackToSheet(row) {
  if (!ENABLED) return { ok: false, skipped: 'disabled' };
  if (row.source !== 'form' || !row.submitted_at) return { ok: false, skipped: 'not-a-form-row' };
  try {
    const sheets = await getSheetsClient();
    const ab = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A:B` })).data.values || [];
    const found = findSheetRow(ab, row);
    if (found.error) {
      console.warn(`[freeSwimwear] sheet writeback skipped: ${found.error}`);
      return { ok: false, error: found.error };
    }
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
      range: `'${TAB}'!F${found.row}:O${found.row}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
    return { ok: true, row: found.row };
  } catch (e) {
    console.warn(`[freeSwimwear] sheet writeback failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { writeBackToSheet, findSheetRow, ENABLED };
