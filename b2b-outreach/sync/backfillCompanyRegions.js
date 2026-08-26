/**
 * backfillCompanyRegions.js — fill in `region` (and `country` where missing) for
 * companies we can locate but cannot place in a timezone.
 *
 * `timezoneFromLocation` refuses to guess: a multi-zone country with no region
 * answers nothing, which is right (a wrong zone lands verbatim in "…, 1pm your
 * time" when scheduling a call). But 104 of 222 live companies land there, and
 * for most of them it is not genuinely unknowable — the row has a city, or a
 * street address, and simply never had the structured fields filled in. LGBT
 * Center of Raleigh carries `city: 'Raleigh'` and no country at all.
 *
 * So this is a DATA repair, not a new inference layer. It writes the same
 * structured fields an operator would have typed, from Google's answer, and the
 * timezone stays derived from them exactly as before. Nothing here weakens the
 * no-match-means-no-facts rule; it just stops us discarding facts we already had.
 *
 * Print-only by default:
 *   node b2b-outreach/sync/backfillCompanyRegions.js           # what it would write
 *   node b2b-outreach/sync/backfillCompanyRegions.js --write   # write it
 *   node b2b-outreach/sync/backfillCompanyRegions.js --write --limit 20
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { fetchAllPaginated } = require('../../shared/supabaseClient');
const { geocode } = require('../../customer-service/lib/geocoder');
const { timezoneFromLocation } = require('../lib/meetingTimezone');

/** The string we hand Google. Null when the row says nothing locatable. */
function locationQuery(c) {
  const parts = [c.address, c.city, c.region, c.country].filter(Boolean);
  if (!parts.length) return null;
  // A bare country is not worth a call: it is exactly what we already know, and
  // Google will happily return the country centroid, which would let us write a
  // region we did not learn.
  if (!c.address && !c.city && !c.region) return null;
  // Company name included when we have only a city, so "Raleigh" resolves to the
  // org rather than to whichever Raleigh Google prefers.
  return (!c.address && c.city && c.name ? [c.name, ...parts] : parts).join(', ');
}

async function run({ write = false, limit = 200 } = {}) {
  const sb = getSupabaseClient();
  const companies = await fetchAllPaginated(() =>
    sb.from('b2b_companies').select('id, name, address, city, region, country, relationship_state'));

  const candidates = companies.filter(c => {
    if (c.relationship_state === 'lost') return false;
    if (timezoneFromLocation({ region: c.region, country: c.country, address: c.address }).timeZone) return false;
    return !!locationQuery(c);
  }).slice(0, limit);

  console.log(`${companies.length} companies, ${candidates.length} locatable but unplaced${write ? '' : ' (DRY RUN)'}\n`);

  let fixed = 0, unresolved = 0, failed = 0;
  for (const c of candidates) {
    const q = locationQuery(c);
    let hit;
    try {
      hit = await geocode(q);
    } catch (err) {
      console.error(`  ✗ ${c.name}: ${err.message}`);
      failed++;
      continue;
    }
    if (!hit) { console.log(`  · ${c.name}: no match for "${q}"`); unresolved++; continue; }

    const patch = {};
    if (!c.region && hit.region) patch.region = hit.region;
    if (!c.country && hit.country_code) patch.country = hit.country_code;
    if (!Object.keys(patch).length) { console.log(`  · ${c.name}: nothing new`); unresolved++; continue; }

    // Only accept the write if it actually buys a timezone. Google will resolve
    // almost anything to something; a patch that leaves the company just as
    // unplaceable is churn on the record for no gain.
    const after = timezoneFromLocation({
      region: patch.region || c.region,
      country: patch.country || c.country,
      address: c.address,
    });
    if (!after.timeZone) {
      console.log(`  · ${c.name}: ${JSON.stringify(patch)} still yields no zone — skipped`);
      unresolved++;
      continue;
    }

    console.log(`  ✓ ${c.name}: ${JSON.stringify(patch)} → ${after.timeZone}${after.split ? '  (SPLIT — worth confirming)' : ''}`);
    fixed++;
    if (write) {
      const { error } = await sb.from('b2b_companies')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', c.id);
      if (error) { console.error(`    write failed: ${error.message}`); failed++; fixed--; }
    }
  }

  console.log(`\n${write ? 'wrote' : 'would write'}: ${fixed}   no gain: ${unresolved}   failed: ${failed}`);
  return { fixed, unresolved, failed };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  run({
    write: argv.includes('--write'),
    limit: limitIdx > -1 ? Number(argv[limitIdx + 1]) : 200,
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, locationQuery };
