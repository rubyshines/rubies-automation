/**
 * Read the RUBIES LGBTQ+ Organization Donation Onboarding survey responses
 * (Google Form → "Form Responses 1" tab) so we can ingest new submissions
 * into donation_partners.
 *
 * Sheet:
 *   https://docs.google.com/spreadsheets/d/1IKaX5lKarqCdsqK766NpUCvwQb7fC4RcWG71VliWHiU
 *
 * "Form Responses 1" is the append-only raw form responses tab. Columns:
 *   [0] Timestamp
 *   [1] Email Address (submitter)
 *   [2] org name
 *   [3] org website
 *   [4] primary contact name/title
 *   [5] primary contact email
 *   [6] description (program write-up — verbatim-safe for the website)
 *   [7] program page URL (optional)
 *   [8] address (multi-line raw; orgs usually submit just street/city/zip,
 *       sometimes with their own "c/o" line)
 *   [9] size range (comma-joined multi-select)
 *
 * Orgs submit just the bare street address, not a pre-formatted "RUBIES
 * Returns / c/o ORG" block — buildMailingAddress() wraps it for storage.
 */

const { getSheetsClient } = require('../../shared/googleSheetsClient');

const SHEET_ID = '1IKaX5lKarqCdsqK766NpUCvwQb7fC4RcWG71VliWHiU';
const TAB = 'Form Responses 1';
const RANGE = `'${TAB}'!A1:J`;

const COL = {
  timestamp: 0,
  submitter_email: 1,
  name: 2,
  website: 3,
  contact_name: 4,
  contact_email: 5,
  description: 6,
  program_url: 7,
  raw_address: 8,
  size_range: 9,
};

/**
 * Wrap a bare submitted address in the "RUBIES Returns / c/o ORG / ..." block
 * the donation page expects. If the org already prefixed it themselves (some
 * do), preserve their formatting and just ensure "RUBIES Returns" is on top.
 */
function buildMailingAddress(orgName, rawAddress) {
  const lines = (rawAddress || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  const hasRubiesPrefix = /^rubies returns/i.test(lines[0]);
  const hasCoLine = lines.some(l => /^c\/o\s/i.test(l));
  const hasOrgNameLine = lines.some(l => l.toLowerCase() === orgName.toLowerCase());

  const out = [];
  if (!hasRubiesPrefix) out.push('RUBIES Returns');
  if (!hasCoLine && !hasOrgNameLine) out.push(`c/o ${orgName}`);
  out.push(...lines);
  return out.join('\n');
}

async function readSurveyRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[COL.name] || '').trim();
    if (!name) continue;
    const rawAddress = (r[COL.raw_address] || '').trim();
    out.push({
      sheet_row: i + 1, // 1-indexed sheet row (header is row 1)
      timestamp: (r[COL.timestamp] || '').trim(),
      submitter_email: (r[COL.submitter_email] || '').trim() || null,
      name,
      website: (r[COL.website] || '').trim() || null,
      contact_name: (r[COL.contact_name] || '').trim() || null,
      contact_email: (r[COL.contact_email] || '').trim() || null,
      description: (r[COL.description] || '').trim() || null,
      program_url: (r[COL.program_url] || '').trim() || null,
      raw_address: rawAddress,
      mailing_address: buildMailingAddress(name, rawAddress),
      size_range: (r[COL.size_range] || '').trim() || null,
    });
  }
  return out;
}

/**
 * Find a single survey row by org name (case-insensitive, flexible).
 * Returns null if none match. If multiple match, returns the most recent.
 */
async function findSurveyRowByName(name) {
  const all = await readSurveyRows();
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(name);

  const exact = all.filter(r => norm(r.name) === target);
  if (exact.length) return exact[exact.length - 1];

  const partial = all.filter(r => norm(r.name).includes(target) || target.includes(norm(r.name)));
  if (partial.length) return partial[partial.length - 1];

  return null;
}

/**
 * Ensure a `mailing_address` starts with the canonical "RUBIES Returns" line.
 * Idempotent — re-running on an already-prefixed string is a no-op.
 * Used by both survey-ingest and direct create/update so every partner's
 * mailing block has a consistent first line on the donation page.
 */
function ensureRubiesReturnsPrefix(mailingAddress) {
  if (!mailingAddress) return mailingAddress;
  const lines = mailingAddress.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return mailingAddress;
  if (/^rubies returns/i.test(lines[0])) return lines.join('\n');
  return ['RUBIES Returns', ...lines].join('\n');
}

module.exports = { readSurveyRows, findSurveyRowByName, buildMailingAddress, ensureRubiesReturnsPrefix, SHEET_ID, TAB };
