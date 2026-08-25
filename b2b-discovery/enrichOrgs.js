#!/usr/bin/env node
/**
 * enrichOrgs.js — give the LGBTQ+ org rows in `b2b_companies` a real location.
 *
 * WHY: the CenterLink cohort came in from Klaviyo carrying IP-geolocated
 * "locations" — the datacenter that served the profile, not the org.
 * metrotampabay.org (Tampa Bay, Florida) is filed as Des Moines, Iowa;
 * norcaloutreach.org as Ashburn, Virginia, which is AWS us-east-1;
 * thecenteroc.org and rogueactioncenter.org both as Mountain View, California.
 * The apparent Iowa and Virginia clusters in the data are server racks. So the
 * region column cannot be used to admit orgs by area, which is what blocks
 * filling the middle-state gap in the donation partner network.
 *
 * Names are domain slugs for the same reason ("Waf", "Outcenter"), and not one
 * row in the cohort has an email address.
 *
 * WHAT IT DOES, per row: scrape the org's own site (Puppeteer, homepage +
 * about/contact subpages) → pull contact details → ask Sonnet to transcribe the
 * address the org publishes → geocode it → write the structured result back.
 *
 * It deliberately does NOT set `vetted_at`. Admission to the Tier-4 first-touch
 * queue stays a `b2b_triage` decision per the standing rule that supply is let
 * in cohort by cohort; this only supplies the facts that decision needs.
 *
 * Usage:
 *   node b2b-discovery/enrichOrgs.js [--execute] [--limit N] [--concurrency N]
 *                                    [--source S] [--company ID] [--retry-failed]
 *   Dry run is the default: it lists what would be processed and writes nothing.
 */
require('dotenv').config();

const { scrapeProspect, closePuppeteer } = require('./lib/scraper');
const { findContacts } = require('./lib/contactFinder');
const { analyzeOrg } = require('./lib/orgAnalyzer');
const { identifyingDomain } = require('../b2b-outreach/lib/emailDomains');
const { geocode } = require('../customer-service/lib/geocoder');
const { getSupabaseClient } = require('../shared/supabaseClient');

// Below this, a "scrape" returned a splash page, a cookie wall, or a JS shell
// rather than the site. inclusivekc.org came back as 408 characters, and an
// analyzer handed that will truthfully report no address — which then gets
// stored as the fact "this org publishes no address". That is a wrong fact
// derived from our own failure, and unlike a scrape error it looks settled and
// never gets retried. Thin content is therefore its own outcome.
const MIN_CONTENT_CHARS = 800;

// States with real RUBIES order volume and no donation partner. Used only to
// make the run's closing report answer the question the run exists to answer.
const UNCOVERED_PRIORITY = [
  'Illinois', 'Pennsylvania', 'Colorado', 'Minnesota', 'Texas', 'Virginia',
  'Maryland', 'Michigan', 'Ohio', 'New Jersey', 'Florida', 'Georgia',
  'Wisconsin', 'Connecticut', 'Missouri', 'Indiana',
];

/**
 * Does the current name look like it was derived from the domain rather than
 * written by a human? The cohort's names are single CamelCase runs of the
 * domain's second-level label ("Metrotampabay" from metrotampabay.org). Pure.
 */
function nameLooksLikeDomainSlug(name, website) {
  if (!name || !website) return false;
  const domain = identifyingDomain(website);
  if (!domain) return false;
  const label = domain.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const flat = String(name).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!label || !flat) return false;
  // A slug name has no internal spaces and collapses onto the domain label.
  return !/\s/.test(String(name).trim()) && flat === label;
}

/**
 * Build the b2b_companies update for one enriched row. Pure — no I/O — so the
 * write rules are testable without a network or a database.
 *
 * The rules, and why each one is the way it is:
 * - Location is overwritten from the geocode. The existing values are known to
 *   be datacenter geolocation, so preserving them preserves a wrong answer.
 *   No geocode means the location columns are left completely alone.
 * - Contact details only ever FILL A HOLE. An address already on the row was
 *   put there by a person or by correlated inbound mail, and a scraper's guess
 *   must not displace it.
 * - The name is replaced only when the current one is a domain slug, so a
 *   human-entered name always wins.
 * - `ai_summary` is never touched: for orgs whose history was never imported it
 *   is the only relationship knowledge we hold.
 * - `vetted_at` is never set: triage owns admission.
 */
function buildCompanyUpdate({ company, analysis, contacts, geo, geoApprox }) {
  const update = { enriched_at: new Date().toISOString() };
  const a = analysis || {};
  const c = contacts || {};
  const located = geo || geoApprox;

  if (located) {
    update.city = located.city || null;
    update.region = located.region || null;
    update.country = located.country_code || null;
    update.latitude = located.lat;
    update.longitude = located.lng;
    // Only a real transcribed address goes in `address`. A service area
    // resolves to a county centroid, which is good enough to filter a prospect
    // by state and nowhere near good enough to post a parcel to — and `address`
    // is exactly the field someone would later reach for to do that.
    update.address = geo ? (geo.formatted_address || a.addressText || null) : null;
    update.enrich_status = geo ? 'located' : 'located_approx';
  }

  if (a.orgName && nameLooksLikeDomainSlug(company.name, company.website)) {
    update.name = a.orgName;
  }

  if (!company.general_email && c.email) update.general_email = c.email;
  if (!company.contact_form_url && c.contactFormUrl) update.contact_form_url = c.contactFormUrl;
  if (!company.phone && c.phone) update.phone = c.phone;
  if (!company.description && a.descriptionShort) update.description = a.descriptionShort;

  // What triage needs to rank a row, kept alongside the row rather than in a
  // separate store so the panel and the console tools see the same facts.
  const flags = { ...(company.program_flags || {}) };
  if (a.analysisStatus === 'success') {
    flags.runs_clothing_program = !!a.runsClothingProgram;
    flags.serves_trans_community = !!a.servesTransCommunity;
    flags.site_appears_active = a.appearsActive !== false;
    update.program_flags = flags;
  }

  return update;
}

/** One-line human summary of what a pass found, stored on the row. Pure. */
function buildEnrichNotes({ analysis, geo, geoApprox, scrapeError, thinContent }) {
  if (scrapeError) return `scrape: ${scrapeError}`.slice(0, 400);
  const a = analysis || {};
  if (a.analysisStatus === 'failed') return `analysis: ${a.failureReason || 'unknown'}`.slice(0, 400);
  const parts = [];
  if (geo) parts.push(`geocoded to ${[geo.city, geo.region, geo.country_code].filter(Boolean).join(', ')}`);
  else if (geoApprox) parts.push(`approx from service area "${a.serviceAreaText}" → ${[geoApprox.city, geoApprox.region, geoApprox.country_code].filter(Boolean).join(', ')}`);
  else if (thinContent) parts.push(`only ${thinContent} chars scraped — too thin to conclude anything, retry`);
  else if (a.addressText) parts.push(`address "${a.addressText}" did not geocode`);
  else if (a.serviceAreaText) parts.push(`no address; service area "${a.serviceAreaText}" did not geocode`);
  else parts.push('no address published on site');
  if (a.addressRejected) parts.push(`rejected ungrounded address "${a.addressRejected}"`);
  if (a.appearsActive === false) parts.push(`site may be inactive (${a.appearsActiveReason || 'no reason given'})`);
  if (a.confidence) parts.push(`confidence ${a.confidence}`);
  return parts.join(' | ').slice(0, 400);
}

async function fetchTargets(sb, { limit, source, companyId, retryFailed }) {
  let q = sb.from('b2b_companies')
    .select('id,name,website,general_email,contact_form_url,phone,description,program_flags,city,region,country,source,enrich_status')
    .eq('relationship_type', 'lgbtq_org');

  if (companyId) {
    q = q.eq('id', companyId);
  } else if (retryFailed) {
    q = q.not('enrich_status', 'is', null).neq('enrich_status', 'located');
  } else {
    q = q.is('enriched_at', null);
  }
  if (source) q = q.eq('source', source);

  const { data, error } = await q.order('name');
  if (error) throw new Error(error.message);
  const rows = data || [];
  return limit ? rows.slice(0, limit) : rows;
}

async function main() {
  const argv = process.argv;
  const EXECUTE = argv.includes('--execute');
  const RETRY_FAILED = argv.includes('--retry-failed');
  const arg = (flag) => { const i = argv.indexOf(flag); return i > -1 ? argv[i + 1] : null; };
  const LIMIT = arg('--limit') ? Number(arg('--limit')) : null;
  const CONCURRENCY = arg('--concurrency') ? Number(arg('--concurrency')) : 3;
  const SOURCE = arg('--source');
  const COMPANY = arg('--company');

  if (!process.env.ANTHROPIC_API_KEY) { console.error('Error: ANTHROPIC_API_KEY not set in .env'); process.exit(1); }
  if (!process.env.GOOGLE_MAPS_API_KEY) { console.error('Error: GOOGLE_MAPS_API_KEY not set in .env (needed to geocode addresses)'); process.exit(1); }

  const sb = getSupabaseClient();
  const rows = await fetchTargets(sb, { limit: LIMIT, source: SOURCE, companyId: COMPANY, retryFailed: RETRY_FAILED });

  console.log(
    `${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — org rows to enrich: ${rows.length}` +
    `${SOURCE ? ` (source=${SOURCE})` : ''}${RETRY_FAILED ? ' (retrying prior failures)' : ''}` +
    `${LIMIT ? ` (limit ${LIMIT})` : ''} — concurrency ${CONCURRENCY}\n`
  );
  if (!rows.length) return;

  if (!EXECUTE) {
    const withSite = rows.filter((r) => r.website).length;
    rows.slice(0, 25).forEach((r) => {
      console.log(
        `  ${String(r.name).slice(0, 34).padEnd(34)} ` +
        `${[r.city, r.region].filter(Boolean).join(', ').slice(0, 24).padEnd(24)} ` +
        `${r.website || '(no website — will be skipped)'}`
      );
    });
    if (rows.length > 25) console.log(`  …and ${rows.length - 25} more`);
    console.log(`\n${withSite} of ${rows.length} have a website to scrape.`);
    console.log('Dry run: nothing scraped, analyzed, geocoded, or written. Re-run with --execute.');
    return;
  }

  const counts = {
    located: 0, located_approx: 0, no_address: 0, scrape_thin: 0,
    scrape_failed: 0, no_website: 0, analysis_failed: 0, errors: 0,
  };
  const foundStates = {};
  const total = rows.length;
  let idx = 0;

  async function worker() {
    while (idx < rows.length) {
      const i = idx++;
      const row = rows[i];
      const started = Date.now();
      const tag = `(${i + 1}/${total}) ${String(row.name).slice(0, 34)}`;
      const secs = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;

      try {
        if (!row.website || !identifyingDomain(row.website)) {
          await sb.from('b2b_companies').update({
            enriched_at: new Date().toISOString(),
            enrich_status: 'no_website',
            enrich_notes: row.website ? `website is a non-identifying domain: ${row.website}` : 'no website on record',
          }).eq('id', row.id);
          counts.no_website++;
          console.log(`${tag} → no usable website ${secs()}`);
          continue;
        }

        const scrape = await scrapeProspect(row.website);
        if (scrape.error || !scrape.content) {
          const notes = buildEnrichNotes({ scrapeError: scrape.error || 'no content extracted' });
          await sb.from('b2b_companies').update({
            enriched_at: new Date().toISOString(), enrich_status: 'scrape_failed', enrich_notes: notes,
          }).eq('id', row.id);
          counts.scrape_failed++;
          console.log(`${tag} → scrape failed (${scrape.error || 'no content'}) ${secs()}`);
          continue;
        }

        const contacts = findContacts(scrape.rawHtmlByPage || {});
        const analysis = await analyzeOrg({ orgName: row.name, website: row.website, content: scrape.content });

        if (analysis.analysisStatus === 'failed') {
          await sb.from('b2b_companies').update({
            enriched_at: new Date().toISOString(), enrich_status: 'analysis_failed',
            enrich_notes: buildEnrichNotes({ analysis }),
          }).eq('id', row.id);
          counts.analysis_failed++;
          console.log(`${tag} → ANALYSIS FAILED (${analysis.failureReason}) ${secs()}`);
          continue;
        }

        // A stated street address is the answer we want. Failing that, many
        // orgs publish only a service area ("serving the Greater Kansas City
        // area"), and for the question this run exists to answer — which state
        // is this org in — that is a perfectly good answer. It is kept
        // strictly separate from a real address; see buildCompanyUpdate.
        let geo = null;
        let geoApprox = null;
        try {
          if (analysis.addressText) geo = await geocode(analysis.addressText);
          if (!geo && analysis.serviceAreaText) geoApprox = await geocode(analysis.serviceAreaText);
        } catch (geoErr) {
          console.log(`${tag} → geocode error: ${geoErr.message}`);
        }

        const thin = scrape.content.length < MIN_CONTENT_CHARS ? scrape.content.length : null;

        const update = buildCompanyUpdate({ company: row, analysis, contacts, geo, geoApprox });
        if (!geo && !geoApprox) {
          update.enrich_status = thin ? 'scrape_thin' : 'no_address';
        }
        update.enrich_notes = buildEnrichNotes({ analysis, geo, geoApprox, thinContent: thin });

        const { error: upErr } = await sb.from('b2b_companies').update(update).eq('id', row.id);
        if (upErr) throw new Error(upErr.message);

        const hit = geo || geoApprox;
        if (hit) {
          if (geo) counts.located++; else counts.located_approx++;
          if (hit.region) foundStates[hit.region] = (foundStates[hit.region] || 0) + 1;
          const moved = row.region && row.region !== hit.region ? ` (was ${row.region})` : '';
          console.log(
            `${tag} → ${[hit.city, hit.region, hit.country_code].filter(Boolean).join(', ')}${geoApprox ? ' ~approx' : ''}${moved}` +
            `${update.general_email ? ` | ${update.general_email}` : ''}` +
            `${analysis.runsClothingProgram ? ' | CLOTHING PROGRAM' : ''} ${secs()}`
          );
        } else if (thin) {
          counts.scrape_thin++;
          console.log(`${tag} → only ${thin} chars scraped, inconclusive ${secs()}`);
        } else {
          counts.no_address++;
          console.log(`${tag} → no address or service area on site ${secs()}`);
        }
      } catch (err) {
        counts.errors++;
        console.log(`${tag} → ERROR: ${err.message} ${secs()}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  console.log(
    `\nDone. located=${counts.located} (+${counts.located_approx} approx from service area) | ` +
    `no-address=${counts.no_address} | scrape-thin=${counts.scrape_thin} | ` +
    `scrape-failed=${counts.scrape_failed} | no-website=${counts.no_website} | ` +
    `analysis-failed=${counts.analysis_failed} | errors=${counts.errors}`
  );
  const retryable = counts.scrape_thin + counts.scrape_failed + counts.analysis_failed;
  if (retryable) console.log(`${retryable} row(s) are retryable: node b2b-discovery/enrichOrgs.js --retry-failed --execute`);

  const ranked = Object.entries(foundStates).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    console.log('\nOrgs located, by state/region:');
    ranked.forEach(([s, n]) => {
      const flag = UNCOVERED_PRIORITY.includes(s) ? '  ← no partner, real order volume' : '';
      console.log(`  ${String(n).padStart(3)}  ${s}${flag}`);
    });
    const priority = ranked.filter(([s]) => UNCOVERED_PRIORITY.includes(s)).reduce((a, [, n]) => a + n, 0);
    console.log(`\n${priority} org(s) landed in states with order volume and no donation partner.`);
    console.log('Next: review them with b2b_triage to admit a cohort into the Tier-4 queue.');
  }
}

if (require.main === module) {
  main()
    .catch((err) => { console.error('[FATAL]', err.message); process.exitCode = 1; })
    .finally(() => closePuppeteer());
}

module.exports = { buildCompanyUpdate, buildEnrichNotes, nameLooksLikeDomainSlug, UNCOVERED_PRIORITY };
