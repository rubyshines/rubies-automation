/**
 * passportImportFreshness.js — is the Passport master file overdue for import?
 *
 * The Passport customs import is the one cost pipeline with no scheduler: Nitro
 * emails a master .xlsx and someone runs importPassportInvoices.js by hand. It
 * has no voice when it doesn't happen, and landed margin just quietly reads low
 * — every international order in the un-imported window carries $0 customs and
 * looks more profitable than it is.
 *
 * That is not hypothetical. On 2026-08-11 five consecutive invoices (82317,
 * 82785, 83145, 83543, 83856 — invoice dates Jul 1 through Jul 29, 150 rows,
 * $3,562.65 of customs) had never been imported, and nothing anywhere said so.
 * They surfaced only because someone hand-reconciled the file against the table
 * while chasing an unrelated question.
 *
 * So: compare the newest invoice_date in passport_invoices against today and
 * raise a decision-queue item once it's older than a fortnight. Nitro invoices
 * weekly, so 14 days means two have been missed — comfortably past noise, well
 * short of a month of drift.
 *
 * Deliberately keyed on invoice_date, not import time: a re-import of an old
 * file must not reset the clock, and the question being asked is "has the
 * newest invoice Nitro issued reached the table?"
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');

// Nitro issues a Passport invoice weekly, but the master file itself runs a
// week or two behind: the copy pulled on 2026-08-11 topped out at the 2026-07-29
// invoice, fully current yet already 13 days old. So a fortnight is normal lag,
// not a signal. Three missed cycles is the point where the file has genuinely
// moved on without us — it still catches the real 48-day gap four weeks sooner
// than the hand-reconcile did, without nagging when we're up to date. A check
// the operator learns to ignore is worse than no check.
const STALE_DAYS = 21;
// Five weeks is a real hole in landed margin, not a late file.
const URGENT_DAYS = 35;

const DAY_MS = 86400000;

/**
 * Pure: newest invoice date + reference clock -> decision item (or null).
 * `latest` is { invoice_number, invoice_date } or null when the table is empty.
 */
function buildFreshnessItem(latest, now = Date.now()) {
  if (!latest?.invoice_date) return null;
  const ageDays = Math.floor((now - Date.parse(`${latest.invoice_date}T00:00:00Z`)) / DAY_MS);
  if (ageDays < STALE_DAYS) return null;

  return {
    kind: 'passport_import_stale',
    urgent: ageDays >= URGENT_DAYS,
    text: `Passport customs import is ${ageDays}d behind — newest invoice in the table is `
      + `${latest.invoice_number} dated ${latest.invoice_date}. International landed margin `
      + `reads high until the missing invoices are imported.`,
    action: 'Download the latest "New Master Passport Invoice File" from Nitro, then run '
      + 'node finance/importPassportInvoices.js <path>. The import audits before it writes; '
      + 'if it blocks, resolve with Nitro and record it in finance/config/passport-audit-acknowledged.json '
      + 'rather than reaching for --force.',
  };
}

/** Query the newest invoice and turn it into decision-queue items. Fail-soft. */
async function collectPassportFreshnessItems(sb = getSupabaseClient()) {
  const { data, error } = await sb
    .from('passport_invoices')
    .select('invoice_number, invoice_date')
    .not('invoice_date', 'is', null)
    .order('invoice_date', { ascending: false })
    .limit(1);
  if (error || !data?.length) return [];
  const item = buildFreshnessItem(data[0]);
  return item ? [item] : [];
}

module.exports = {
  buildFreshnessItem,
  collectPassportFreshnessItems,
  STALE_DAYS,
  URGENT_DAYS,
};
