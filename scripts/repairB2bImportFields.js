#!/usr/bin/env node
/**
 * repairB2bImportFields.js — undo the column shift in the sheet-imported
 * b2b_companies rows.
 *
 * The Main Contacts sheet import landed one column off on a subset of rows.
 * The signature is unmistakable and consistent:
 *
 *   website  ← the street address        ("56 JFK Street, Cambridge, MA 02138")
 *   city     ← the country               ("United States")
 *   country  ← the phone, or the literal status word "lead"
 *   address  ← the actual city/region    ("Cambridge, MA")
 *   region, phone ← null
 *
 * Repair (per row, reading all originals before writing any field):
 *   address        = street address recovered from `website` (else unchanged)
 *   website        = kept only when it really is a URL
 *   country        = the country name recovered from `city`
 *   phone          = the phone recovered from `country` (status words dropped —
 *                    `status` already holds them)
 *   city, region   = parsed from the OLD `address` value ("Brooklyn, NY")
 *
 * Applied ONLY to rows matching the shift signature, so correctly-imported rows
 * are never touched. Rows outside the signature still get safe normalization of
 * a whitespace-padded or multi-domain `website`.
 *
 * Usage: node scripts/repairB2bImportFields.js [--execute]
 *   Default is print-only.
 */
require('dotenv').config();

const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const COUNTRY_NAMES = new Set([
  'united states', 'usa', 'us', 'canada', 'united kingdom', 'uk', 'australia',
  'sweden', 'denmark', 'spain', 'germany', 'puerto rico', 'ireland', 'france',
  'netherlands', 'new zealand', 'norway', 'finland', 'italy', 'belgium',
]);

// Status values that leaked into `country` from the sheet's status column.
const STATUS_WORDS = new Set(['lead', 'qualified_lead', 'customer', 'active_partner', 'prospect']);

const STREET_WORDS = /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pl|place|ct|court|hwy|highway|pkwy|parkway|suite|ste|unit|floor|fl)\b\.?/i;
const US_ZIP = /\b\d{5}(-\d{4})?\b/;
const CA_POSTAL = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;

/** Street address, not a URL: leading number + street word, or a postal code. Pure. */
function isStreetAddress(v) {
  if (!v || typeof v !== 'string') return false;
  const s = v.trim();
  if (!/\s/.test(s)) return false;                       // no spaces → domain-ish
  if (/^https?:\/\//i.test(s)) return false;
  return (/^\d+\s/.test(s) && STREET_WORDS.test(s)) || US_ZIP.test(s) || CA_POSTAL.test(s);
}

/** A phone number: 7+ digits and nothing but phone punctuation. Pure. */
function isPhone(v) {
  if (!v || typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^[\d\s()+.\-x]+$/i.test(s)) return false;
  return (s.match(/\d/g) || []).length >= 7;
}

function isCountryName(v) {
  return !!v && COUNTRY_NAMES.has(String(v).trim().toLowerCase());
}

function isStatusWord(v) {
  return !!v && STATUS_WORDS.has(String(v).trim().toLowerCase());
}

/**
 * First usable URL out of a messy website cell. Handles trailing whitespace,
 * a missing scheme, and "a.ca and b.ca" multi-domain answers. The path is
 * always preserved — dropping it turns a link like "bit.ly/m/mactrans" into a
 * useless bare domain. Returns null when there's no domain. Pure.
 */
function normalizeWebsite(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const m = s.match(/(https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s]*)?/i);
  if (!m) return null;
  const domain = m[2].toLowerCase();
  if (!/\.[a-z]{2,}$/.test(domain)) return null;
  const scheme = m[1] ? m[1].toLowerCase() : 'https://';
  const path = (m[3] || '').replace(/\/$/, '');
  return `${scheme}${domain}${path}`;
}

// Real state/province codes, because a two-letter-uppercase heuristic can't
// tell "NY" (state) from "SF" (how the sheet abbreviated San Francisco).
const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR',
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

/** "Brooklyn, NY" → { city: 'Brooklyn', region: 'NY' }; "NY" → region only. Pure. */
function parseCityRegion(v) {
  if (!v || typeof v !== 'string') return { city: null, region: null };
  const parts = v.split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { city: null, region: null };
  if (parts.length === 1) {
    return STATE_CODES.has(parts[0].toUpperCase()) && parts[0].length === 2
      ? { city: null, region: parts[0].toUpperCase() }
      : { city: parts[0], region: null };
  }
  return { city: parts[0], region: parts[1] };
}

/**
 * Some sheet-imported rows stored `metadata` as a JSON *string* scalar inside
 * the jsonb column, so it reads back as `'{"campaign":"sample",...}'` rather
 * than an object. syncB2bCompanyState parses it defensively on every read;
 * this writes the real object back once so nothing downstream has to.
 * Returns null when metadata is already an object or is unparseable. Pure.
 */
function normalizeMetadata(meta) {
  if (typeof meta !== 'string' || !meta.trim()) return null;
  try {
    const parsed = JSON.parse(meta);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The shift signature: the country name is sitting in `city`, and `country`
 * holds something that is definitively not a country (a phone or a status word).
 * Both halves required — either alone is too weak to act on. Pure.
 */
function hasShiftSignature(c) {
  return isCountryName(c.city) && (isPhone(c.country) || isStatusWord(c.country));
}

/**
 * Compute the field updates for one company, or null when nothing changes.
 * Pure — the entire repair decision is testable without Supabase.
 */
function computeFieldRepair(c) {
  const upd = {};

  // Independent of the column shift — a row can have either problem or both.
  const fixedMeta = normalizeMetadata(c.metadata);
  if (fixedMeta) upd.metadata = fixedMeta;

  if (hasShiftSignature(c)) {
    const streetInWebsite = isStreetAddress(c.website);
    const { city, region } = parseCityRegion(c.address);

    // address: the street address recovered from `website`. When `website` held
    // no street address, the old `address` was only a city — don't keep it here.
    const nextAddress = streetInWebsite ? c.website.trim() : null;
    if (nextAddress !== (c.address || null)) upd.address = nextAddress;

    const nextWebsite = streetInWebsite ? null : normalizeWebsite(c.website);
    if (nextWebsite !== (c.website || null)) upd.website = nextWebsite;

    const nextCountry = String(c.city).trim();
    if (nextCountry !== c.country) upd.country = nextCountry;

    const nextPhone = isPhone(c.country) ? c.country.trim() : (c.phone || null);
    if (nextPhone !== (c.phone || null)) upd.phone = nextPhone;

    if (city !== (c.city || null)) upd.city = city;
    if (region !== (c.region || null)) upd.region = region;

    return Object.keys(upd).length ? upd : null;
  }

  // Outside the signature: only safe normalization of a messy website cell.
  // Never touch a row's location fields on a guess.
  if (c.website) {
    const next = normalizeWebsite(c.website);
    if (next && next !== c.website) upd.website = next;
    // A street address in `website` with no shift signature: move it, but only
    // when `address` is free — never overwrite an address already on file.
    if (!next && isStreetAddress(c.website) && !c.address) {
      upd.address = c.website.trim();
      upd.website = null;
    }
  }
  return Object.keys(upd).length ? upd : null;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, website, city, region, country, phone, address, source, metadata'));

  const repairs = [];
  for (const c of companies) {
    const upd = computeFieldRepair(c);
    if (upd) repairs.push({ company: c, upd });
  }

  if (!repairs.length) {
    console.log('Nothing to repair — no row matches the shift signature or needs website normalization.');
    return;
  }

  const counts = {
    shifted: repairs.filter(r => hasShiftSignature(r.company)).length,
    metadata: repairs.filter(r => r.upd.metadata).length,
    website: repairs.filter(r => 'website' in r.upd && !hasShiftSignature(r.company)).length,
  };
  console.log(`${repairs.length} rows to repair — ${counts.shifted} column-shifted, `
    + `${counts.metadata} stringified metadata, ${counts.website} website normalization`
    + `${execute ? '' : ' (print-only, pass --execute to apply)'}:\n`);
  for (const { company, upd } of repairs) {
    const fields = Object.entries(upd).filter(([k]) => k !== 'metadata');
    // Metadata blobs are long and identical in shape — summarize, don't dump.
    const metaNote = upd.metadata ? `metadata: string → object (${Object.keys(upd.metadata).length} keys)` : null;
    if (!fields.length) { console.log(`  ${company.name} — ${metaNote}`); continue; }
    console.log(`  ${company.name}${metaNote ? ` — ${metaNote}` : ''}`);
    for (const [k, v] of fields) {
      console.log(`      ${k}: ${JSON.stringify(company[k] ?? null)} → ${JSON.stringify(v)}`);
    }
  }

  if (!execute) return;

  let applied = 0;
  for (const { company, upd } of repairs) {
    const { error } = await sb.from('b2b_companies')
      .update({ ...upd, updated_at: new Date().toISOString() }).eq('id', company.id);
    if (error) throw new Error(`update ${company.id} (${company.name}): ${error.message}`);
    applied++;
  }
  console.log(`\nApplied ${applied}/${repairs.length}.`);
}

module.exports = {
  computeFieldRepair, hasShiftSignature, isStreetAddress, isPhone,
  isCountryName, isStatusWord, normalizeWebsite, parseCityRegion, normalizeMetadata,
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
