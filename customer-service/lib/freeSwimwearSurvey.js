/**
 * Read the RUBIES Free Swimwear application responses (Google Form → the
 * "Free Swimwear Applications" sheet) and normalize them into the unified
 * free_swimwear_requests shape. Mirrors donationPartnerSurvey.js.
 *
 * Sheet:
 *   https://docs.google.com/spreadsheets/d/1CT5k2y9K4fhFM2fIbX9TMUl1ZmGfXjr-jpZcYkGJNC8
 *
 * Two response tabs are read for backfill:
 *   - "Form Responses 1" — the current form (has the trans/non-binary question
 *     and a split age/region). 1400+ rows.
 *   - "Sheet5" — a legacy form version (no trans/non-binary column, single
 *     "where do you live" field).
 *
 * Columns are mapped by header text (not fixed index) because the two tabs
 * differ. The append-only response columns plus the operational columns the
 * old Apps Script wrote back (status, discount code, Shopify customer id,
 * registration/order/expiry dates, send attempts) are all carried through so
 * the full history backfills losslessly.
 */

const { getSheetsClient } = require('../../shared/googleSheetsClient');

const SHEET_ID = '1CT5k2y9K4fhFM2fIbX9TMUl1ZmGfXjr-jpZcYkGJNC8';
const RESPONSE_TABS = ['Form Responses 1', 'Sheet5'];

// Regions we cannot ship a free item to. Editable; promotable to a config row
// later. Matched case/diacritic-insensitively as a substring of the raw
// "state/province and country" free text.
const EXCLUDED_REGIONS = ['brazil', 'brasil'];

// Header-text → canonical field. First header that matches a predicate (and
// isn't already claimed) wins, so order is significant where headers overlap
// (e.g. exact "size" before the longer "what size bottoms…" question).
const FIELD_MATCHERS = [
  ['submitted_at', h => h.includes('timestamp')],
  ['status', h => h === 'status'],
  ['resend_status', h => h.includes('resend')],
  ['discount_code', h => h.includes('discount code')],
  ['shopify_customer_id', h => h.includes('shopify customer')],
  ['registration_date', h => h.includes('registration')],
  ['order_numbers', h => h.includes('order number')],
  ['order_dates', h => h.includes('order date')],
  ['expiry_date', h => h.includes('expiry')],
  ['last_acceptance_send_date', h => h.includes('last acceptance')],
  ['send_attempts', h => h.includes('number of send')],
  ['email', h => h.includes('email')],
  ['applicant_name', h => h.includes('your name')],
  ['is_trans_nonbinary', h => h.includes('identify as trans')],
  ['recipient_age', h => h.includes('age')],
  ['region', h => h.includes('state/province') || h.includes('where do you live')],
  ['situation', h => h.includes('situation')],
  ['why', h => h.includes('why would you like')],
  ['where_heard', h => h.includes('find out')],
  ['first_reaction', h => h.includes('first reaction')],
  ['product_want', h => h.includes('what product would')],
  ['color_pattern', h => h.includes('colour') && h.includes('pattern')],
  ['suggestions', h => h.includes('suggestions')],
  ['size', h => h === 'size'],
  ['final_response', h => h.includes('final response')],
];

function buildColumnMap(headerRow) {
  const headers = headerRow.map(h => (h || '').trim().toLowerCase());
  const map = {};
  const used = new Set();
  for (const [field, pred] of FIELD_MATCHERS) {
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      if (pred(headers[i])) {
        map[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return map;
}

function cell(row, idx) {
  if (idx == null) return '';
  return (row[idx] || '').toString().trim();
}

function parseYesNo(v) {
  const s = (v || '').toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true') return true;
  if (s === 'no' || s === 'n' || s === 'false') return false;
  return null;
}

// The Google Form Timestamp column is a naive wall-clock string ("M/D/YYYY
// H:MM:SS") in the sheet's timezone — it carries NO offset. `new Date(str)`
// therefore interprets it in the HOST's timezone, so the same cell parses to a
// different instant on a Mac (Eastern) vs Railway (UTC). That made identities
// (email, submitted_at) mismatch across machines — duplicating every applicant
// on the cron run and breaking the sheet write-back lookup. Parse it explicitly
// in the sheet's timezone instead, so every host agrees.
const SHEET_TZ = 'America/Toronto';

// Minutes east of UTC for a timezone at a given UTC instant (DST-aware, and
// host-timezone-independent because Intl does the conversion).
function tzOffsetMinutes(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return (asUTC - utcMs) / 60000;
}

// Interpret naive wall-clock components as SHEET_TZ → UTC ISO. Two iterations
// settle the offset around DST boundaries.
function wallTimeToISO(y, mo, d, h, mi, s) {
  let utc = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const next = Date.UTC(y, mo - 1, d, h, mi, s) - tzOffsetMinutes(utc, SHEET_TZ) * 60000;
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc).toISOString();
}

function parseTimestamp(v) {
  if (!v) return null;
  const str = String(v).trim();
  // Form Timestamp: "M/D/YYYY H:MM[:SS]" with no offset → interpret in SHEET_TZ.
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return wallTimeToISO(+m[3], +m[1], +m[2], +m[4], +m[5], +(m[6] || 0));
  // Already-offset values (ISO from the operational columns) parse unambiguously.
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The old script joined multiple order numbers/dates with " | " (deliberately
// not "," so Sheets wouldn't reformat them as one big number).
function parseList(v) {
  if (!v) return [];
  return v.split('|').map(s => s.trim()).filter(Boolean);
}

/**
 * Deterministic eligibility gate (NO AI). Only meaningful for NEW (blank-status)
 * submissions. Ineligible → silently rejected (no email), still stored/listed.
 * Exported for unit testing.
 */
function computeEligibility({ region, is_trans_nonbinary }) {
  const r = (region || '').toLowerCase();
  const hit = EXCLUDED_REGIONS.find(x => r.includes(x));
  if (hit) {
    return { status: 'rejected', eligibility_reason: `excluded region: ${(region || '').trim()}` };
  }
  if (is_trans_nonbinary === false) {
    return { status: 'rejected', eligibility_reason: 'not trans/non-binary' };
  }
  return { status: 'new', eligibility_reason: 'eligible' };
}

function normalizeRow(row, map, { tab, sheetRow, isLegacy }) {
  const email = cell(row, map.email);
  if (!email) return null;

  const is_trans_nonbinary = parseYesNo(cell(row, map.is_trans_nonbinary));
  const region = cell(row, map.region) || null;
  const rawStatus = cell(row, map.status).toLowerCase();

  // Blank status = a fresh submission → run the deterministic eligibility gate.
  // Any existing status = historical; preserve it verbatim.
  let status = rawStatus;
  let eligibility_reason = null;
  if (!rawStatus) {
    ({ status, eligibility_reason } = computeEligibility({ region, is_trans_nonbinary }));
  }

  return {
    source: isLegacy ? 'legacy' : 'form',
    sheet_row: sheetRow,
    submitted_at: parseTimestamp(cell(row, map.submitted_at)),
    email,
    applicant_name: cell(row, map.applicant_name) || null,
    recipient_age: cell(row, map.recipient_age) || null,
    is_trans_nonbinary,
    region,
    situation: cell(row, map.situation) || null,
    why: cell(row, map.why) || null,
    where_heard: cell(row, map.where_heard) || null,
    first_reaction: cell(row, map.first_reaction) || null,
    product_want: cell(row, map.product_want) || null,
    color_pattern: cell(row, map.color_pattern) || null,
    suggestions: cell(row, map.suggestions) || null,
    size: cell(row, map.size) || null,
    final_response: cell(row, map.final_response) || null,

    status,
    eligibility_reason,

    discount_code: cell(row, map.discount_code) || null,
    shopify_customer_id: cell(row, map.shopify_customer_id) || null,
    registration_date: parseTimestamp(cell(row, map.registration_date)),
    expiry_date: parseTimestamp(cell(row, map.expiry_date)),
    order_numbers: parseList(cell(row, map.order_numbers)),
    order_dates: parseList(cell(row, map.order_dates)),
    last_acceptance_send_date: parseTimestamp(cell(row, map.last_acceptance_send_date)),
    send_attempts: parseInt(cell(row, map.send_attempts), 10) || 0,
    resend_status: cell(row, map.resend_status) || null,
  };
}

async function readTab(sheets, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tab}'!A1:AD`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const map = buildColumnMap(rows[0]);
  const isLegacy = tab !== 'Form Responses 1';
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const norm = normalizeRow(rows[i], map, { tab, sheetRow: i + 1, isLegacy });
    if (norm) out.push(norm);
  }
  return out;
}

const dedupeKey = r => `${(r.email || '').toLowerCase()}|${r.submitted_at || ''}`;

/**
 * Read application rows.
 * @param {Object} opts
 * @param {boolean} opts.legacy - include the legacy "Sheet5" tab (backfill).
 * @returns {Promise<Array>} normalized free_swimwear_requests rows.
 *
 * "Sheet5" is a stale snapshot that overlaps Form Responses 1 almost entirely,
 * so legacy rows that match a current-form row (same email + submission time)
 * are dropped — only genuinely legacy-only applicants are kept.
 */
async function readApplications({ legacy = false } = {}) {
  const sheets = await getSheetsClient();
  const form = await readTab(sheets, 'Form Responses 1');
  if (!legacy) return form;

  const formKeys = new Set(form.map(dedupeKey));
  const legacyOnly = (await readTab(sheets, 'Sheet5')).filter(r => !formKeys.has(dedupeKey(r)));
  return form.concat(legacyOnly);
}

// Stable identity of a form submission = (email, submitted_at). The sheet's row
// position is NOT stable (the sheet gets re-sorted), so never use sheet_row as
// an identity key — it's informational only.
//
// Canonicalize submitted_at through Date so the two representations of the same
// instant compare equal: PostgREST returns "...+00:00" while the sheet parse
// yields "...000Z". Without this, every applicant looks "new" every sync.
const identityKey = (r) => {
  let ts = '';
  if (r.submitted_at) {
    const d = new Date(r.submitted_at);
    ts = isNaN(d.getTime()) ? r.submitted_at : d.toISOString();
  }
  return `${(r.email || '').toLowerCase()}|${ts}`;
};

module.exports = {
  readApplications,
  computeEligibility,
  buildColumnMap,
  normalizeRow,
  parseTimestamp,
  identityKey,
  EXCLUDED_REGIONS,
  SHEET_ID,
  RESPONSE_TABS,
};
