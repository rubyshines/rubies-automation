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
const { resolveSurveyColumns } = require('./surveyColumns');

const SHEET_ID = '1IKaX5lKarqCdsqK766NpUCvwQb7fC4RcWG71VliWHiU';
const TAB = 'Form Responses 1';
// Wide enough that a question added tomorrow is read rather than truncated. The
// old A1:J stopped exactly at the last question that existed when it was written,
// so the three questions added on 2026-09-11 were invisible to this reader.
const RANGE = `'${TAB}'!A1:AZ`;

const looksLikeEmail = (v) => v.includes('@') && v.includes('.');
const looksLikeUrl = (v) => /^(https?:\/\/|www\.)/i.test(v) || /\.[a-z]{2,}(\/|$)/i.test(v);

/**
 * How each field is found. `match` keys on the fragment that carries the
 * meaning, so a reworded, re-punctuated or typo-fixed question still resolves;
 * `verify` checks the resolved column actually holds that kind of value, which
 * is what stops a rewording drifting onto the wrong column. See surveyColumns.js.
 *
 * Only the fields the ingest genuinely cannot work without are `required`. A
 * question that has not been asked yet, or was retired, must not break the read.
 */
const FIELDS = {
  timestamp: {
    label: 'submission time', required: true,
    match: (h) => h === 'timestamp' || h.startsWith('timestamp'),
    verify: (v) => !Number.isNaN(Date.parse(v)),
  },
  submitter_email: {
    label: 'submitter address', required: true,
    match: (h) => h === 'email address' || /^email address/.test(h),
    verify: looksLikeEmail,
  },
  name: {
    label: 'organisation name', required: true,
    match: (h) => /name of (your|the) organi/.test(h),
  },
  website: {
    label: 'organisation website', required: true,
    // "website of you organization" (sic) — the typo is on the live form, which
    // is exactly why this keys on `website` and not the sentence.
    match: (h) => /website/.test(h) && /organi/.test(h),
    verify: looksLikeUrl,
  },
  contact_name: {
    label: 'primary contact name', required: true,
    match: (h) => /name and title/.test(h),
  },
  contact_email: {
    label: 'primary contact address', required: true,
    match: (h) => /email address of the primary/.test(h),
    verify: looksLikeEmail,
  },
  description: {
    label: 'programme write-up', required: true,
    match: (h) => /describe the program/.test(h),
  },
  program_url: {
    label: 'programme page link',
    match: (h) => /include a link to the program/.test(h),
    verify: (v) => looksLikeUrl(v),
  },
  raw_address: {
    label: 'returns address', required: true,
    match: (h) => /address info/.test(h) || (/address/.test(h) && /return/.test(h)),
  },
  size_range: {
    label: 'size ranges accepted', required: true,
    match: (h) => /size range/.test(h),
  },
  // Added 2026-09-11. Optional by design: every partner on file predates them,
  // so a blank is the normal case and must never fail the read.
  distribution: {
    label: 'how people get items',
    match: (h) => /how do people get/.test(h),
  },
  makes_purchases: {
    label: 'buys gear occasionally',
    match: (h) => /occasional purchases/.test(h),
  },
  affiliate_interest: {
    label: 'affiliate interest',
    match: (h) => /affiliate program/.test(h),
  },
};

/**
 * The options on "How do people get gender affirming items from you?" as they
 * read on the live form (2026-09-11), each with the programme type it implies.
 *
 * Pinned deliberately. The house rule for anything parsed out of a Google Form
 * is to key on the meaning and pin the current option strings in a test, so an
 * edit fails loudly at build rather than silently at ingest — see the test.
 *
 * Order here is the form's order, which is also the collapse order: most open
 * door first. The first selected option decides the type.
 */
const DISTRIBUTION_OPTIONS = [
  { text: 'We have a closet they visit during open hours', type: 'standing_closet' },
  { text: 'They ask us, and we hand it over or mail it', type: 'by_request' },
  { text: 'Our staff pass items on privately', type: 'by_request' },
  { text: 'We take items to events', type: 'events' },
];

/** Collapse whitespace and case so a re-typed option still matches. Pure. */
const flatten = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Split a checkbox answer into the options that were ticked. PURE.
 *
 * NOT by splitting on commas, which is the obvious approach and is wrong here:
 * Google Forms joins checkbox selections with ", " and the second option
 * CONTAINS a comma ("They ask us, and we hand it over or mail it"). Splitting
 * naively turns two ticks into three fragments and mangles the sentence.
 *
 * So the known options are matched against the answer and removed; whatever
 * survives is free text the operator typed as "Other" (or a reworded option
 * this list has not caught up with), and it is kept rather than discarded.
 */
function parseDistribution(answer) {
  const raw = String(answer || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { selected: [], other: null };
  // Matched case-insensitively but removed from the ORIGINAL string, so an
  // "Other" answer keeps the capitalisation the org typed. Lowercasing their
  // words to make matching easier and then showing the result is a small lie
  // about what they wrote.
  let rest = raw;
  const selected = [];
  for (const opt of DISTRIBUTION_OPTIONS) {
    const at = flatten(rest).indexOf(flatten(opt.text));
    if (at < 0) continue;
    selected.push(opt);
    const re = new RegExp(opt.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i');
    rest = rest.replace(re, ' ');
  }
  // Whatever is left once the known options are gone: strip the separators
  // they were joined with, and keep anything of substance.
  const other = rest.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { selected, other: other.length > 2 ? other : null };
}

/**
 * The programme type a multi-select answer implies. PURE.
 *
 * Exact first, keywords second. A ticked option is an exact, certain answer;
 * the keyword pass exists for "Other" free text and for an option reworded
 * before this file catches up, so a rewording degrades to a good guess rather
 * than to nothing. An answer neither recognises is `unknown`, never a guess,
 * and the raw text is kept on the row either way.
 *
 * Collapse rule when several are ticked: HIGHEST STANDING CAPACITY WINS. Orgs
 * routinely do two (hands gear out on request AND runs a closet event each
 * October), and a type is one value, so it reports the most open door they
 * have and the line beside it carries the rest.
 */
const TYPE_RANK = { standing_closet: 0, by_request: 1, events: 2 };

function typeFromKeywords(text) {
  const a = String(text || '').toLowerCase();
  if (/(visit|drop[ -]?in|walk[ -]?in|open hours|come to|in person|on site|our space|closet)/.test(a)) return 'standing_closet';
  if (/(ask|request|appointment|hand it over|mail|post it|ship|staff|counsell?or|case ?worker|privately|order form)/.test(a)) return 'by_request';
  if (/(event|pop[ -]?up|drive|tabl|pride|fair|market|camp)/.test(a)) return 'events';
  return null;
}

function programTypeFromDistribution(answer) {
  if (!answer) return null;
  const { selected, other } = parseDistribution(answer);
  // BOTH halves count. An answer can tick a known option AND add free text, and
  // reading only the ticks would ignore an "Other" that describes a wider door
  // than anything ticked ("we take items to events" + "…and folks drop in on
  // Fridays" is a closet, not an events-only org).
  const types = [...selected.map(o => o.type), typeFromKeywords(other)].filter(Boolean);
  if (types.length) return types.sort((a, b) => TYPE_RANK[a] - TYPE_RANK[b])[0];
  return 'unknown';
}

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

// Short in-memory cache so back-to-back tool calls (e.g. list_submissions
// then create_from_survey) share a single Google Sheets fetch. The sheet
// only updates when a new form is submitted, so a few seconds of staleness
// is fine. Saves ~2-5s per redundant call on a slow Sheets day.
const SURVEY_CACHE_TTL_MS = 30_000;
let _surveyCache = { at: 0, rows: null };

async function readSurveyRows({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && _surveyCache.rows && (now - _surveyCache.at) < SURVEY_CACHE_TTL_MS) {
    return _surveyCache.rows;
  }
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  // Resolved per read, against this sheet's actual headers, rather than baked in
  // as positions. Throws loudly if a required question cannot be found or the
  // column it matched holds the wrong kind of value.
  const { index: COL, unmapped } = resolveSurveyColumns(rows[0], FIELDS, rows.slice(1));
  const at = (r, field) => (COL[field] === undefined ? null : (r[COL[field]] || '').trim() || null);

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[COL.name] || '').trim();
    if (!name) continue;
    const rawAddress = (r[COL.raw_address] || '').trim();
    out.push({
      sheet_row: i + 1, // 1-indexed sheet row (header is row 1)
      timestamp: (r[COL.timestamp] || '').trim(),
      submitter_email: at(r, 'submitter_email'),
      name,
      website: at(r, 'website'),
      contact_name: at(r, 'contact_name'),
      contact_email: at(r, 'contact_email'),
      description: at(r, 'description'),
      program_url: at(r, 'program_url'),
      raw_address: rawAddress,
      mailing_address: buildMailingAddress(name, rawAddress),
      size_range: at(r, 'size_range'),
      distribution: at(r, 'distribution'),
      makes_purchases: at(r, 'makes_purchases'),
      affiliate_interest: at(r, 'affiliate_interest'),
      // Derived, not stored on the row: the programme type the ticks imply.
      program_type: programTypeFromDistribution(at(r, 'distribution')),
      unmapped_columns: unmapped.map(u => u.header),
    });
  }
  _surveyCache = { at: now, rows: out };
  return out;
}

function invalidateSurveyCache() {
  _surveyCache = { at: 0, rows: null };
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

module.exports = {
  programTypeFromDistribution, parseDistribution, DISTRIBUTION_OPTIONS, FIELDS, readSurveyRows, findSurveyRowByName, buildMailingAddress, ensureRubiesReturnsPrefix, invalidateSurveyCache, SHEET_ID, TAB };
