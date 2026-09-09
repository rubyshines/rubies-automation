/**
 * companyLocation.js — where a company is, and what time it is there.
 *
 * One place answers "their timezone" for every surface (the Schedule panel,
 * the calendar sync, the send-window scheduler, the console tools), so they
 * can never disagree. Precedence:
 *   1. a zone the operator SET (timezone_source = 'operator') — never touched
 *      by inference, because the operator knows something the record does not
 *   2. what city / region / country imply, deterministically (meetingTimezone)
 *   3. a zone stored by an earlier inference, if the location has since been
 *      blanked
 * The stored `timezone` column is kept in step with the location by
 * updateCompanyLocation and the backfill, so anything reading the row raw
 * (reports, exports) sees the same answer.
 *
 * No AI anywhere in here. A wrong zone lands verbatim in "1pm your time".
 */
const { timezoneFromLocation, isValidTimeZone, timeZoneLabel } = require('./meetingTimezone');

const MIGRATION = 'customer-service/migrations-2026-09-09-b2b-company-timezone.sql';
const LOCATION_FIELDS = ['city', 'region', 'country'];

/** PostgREST's wording when the column has not been added yet. Pure. */
function isMissingTimezoneColumn(err) {
  const m = String(err?.message || '');
  return /timezone/i.test(m) && /(does not exist|schema cache|could not find)/i.test(m);
}

/**
 * The company's zone and where it came from. Pure.
 * @returns {{ timeZone: string|null, source: string, split: boolean, reason: string|null, stored: boolean }}
 */
function resolveCompanyTimeZone(company = {}) {
  if (company.timezone_source === 'operator' && isValidTimeZone(company.timezone)) {
    return { timeZone: company.timezone, source: 'set by you', split: false, reason: null, stored: true };
  }
  const derived = timezoneFromLocation(company);
  if (derived.timeZone) return { ...derived, stored: false };
  if (isValidTimeZone(company.timezone)) {
    return { timeZone: company.timezone, source: 'inferred earlier', split: false, reason: null, stored: true };
  }
  return { ...derived, stored: false };
}

/** "Waco, TX, US" — or null when the record says nowhere. Pure. */
function placeLine(company = {}) {
  return LOCATION_FIELDS.map(k => company[k]).filter(Boolean).join(', ') || null;
}

/**
 * What the stored timezone columns SHOULD be for this row, given its location
 * and any operator override. Returns null when nothing needs writing. Pure.
 */
function timezonePatchFor(company = {}) {
  if (company.timezone_source === 'operator' && isValidTimeZone(company.timezone)) return null;
  const derived = timezoneFromLocation(company).timeZone || null;
  const source = derived ? 'inferred' : null;
  if ((company.timezone || null) === derived && (company.timezone_source || null) === source) return null;
  return { timezone: derived, timezone_source: source };
}

/**
 * Change where a company is and/or its timezone. Only the fields passed
 * change; `timezone: ''` (or null) clears an operator override and lets the
 * location decide again. The stored inferred zone follows the location.
 *
 * Without the migration applied, the location still saves and the result
 * carries a `warning` naming the SQL to run — the operator's edit is never
 * thrown away because a column is missing.
 */
async function updateCompanyLocation(sb, { company_id, city, region, country, timezone } = {}) {
  if (!company_id) throw new Error('company_id required');
  const { data: company, error } = await sb.from('b2b_companies').select('*').eq('id', company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!company) throw new Error(`No company ${company_id}`);

  const patch = {};
  for (const [k, v] of [['city', city], ['region', region], ['country', country]]) {
    if (v === undefined) continue;
    const clean = v === null ? null : (String(v).trim() || null);
    if (clean !== (company[k] || null)) patch[k] = clean;
  }
  if (timezone !== undefined) {
    const clean = timezone === null ? '' : String(timezone).trim();
    if (clean && !isValidTimeZone(clean)) {
      throw new Error(`'${clean}' is not a timezone Intl recognises — use an IANA name like America/Chicago`);
    }
    if (clean) {
      if (clean !== company.timezone || company.timezone_source !== 'operator') {
        patch.timezone = clean; patch.timezone_source = 'operator';
      }
    } else if (company.timezone_source === 'operator') {
      patch.timezone = null; patch.timezone_source = null;
    }
  }
  const tzPatch = timezonePatchFor({ ...company, ...patch });
  if (tzPatch) Object.assign(patch, tzPatch);

  const changed = Object.keys(patch);
  if (!changed.length) return { company, changed, resolved: resolveCompanyTimeZone(company), warning: null };

  const write = async (p) => sb.from('b2b_companies')
    .update({ ...p, updated_at: new Date().toISOString() }).eq('id', company_id).select('*').maybeSingle();

  let res = await write(patch);
  let warning = null;
  if (res.error && isMissingTimezoneColumn(res.error)) {
    // Save what CAN be saved; say plainly what could not.
    const { timezone: _t, timezone_source: _s, ...rest } = patch;
    warning = `Timezone not stored — b2b_companies has no timezone column yet. Run ${MIGRATION} in the Supabase SQL Editor.`;
    if (!Object.keys(rest).length) throw new Error(warning);
    res = await write(rest);
  }
  if (res.error) throw new Error(res.error.message);
  const updated = res.data || { ...company, ...patch };
  return { company: updated, changed, resolved: resolveCompanyTimeZone(updated), warning };
}

module.exports = {
  resolveCompanyTimeZone,
  updateCompanyLocation,
  timezonePatchFor,
  placeLine,
  isMissingTimezoneColumn,
  timeZoneLabel,
  LOCATION_FIELDS,
  MIGRATION,
};
