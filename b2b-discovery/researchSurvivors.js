#!/usr/bin/env node
/**
 * researchSurvivors.js — Design #2 phase 1, step 2: full research of the rows
 * that survived the Haiku pre-filter (prefilter.js).
 *
 * Pipeline per row (reuses lib/researcher.js — same flow as discover.js
 * --research): Place Details website lookup → domain dedup/merge → scrape →
 * contact finder → AI analysis (component=b2b_analyzer, Haiku) → score →
 * route. Routing per the locked design: community-org + LGBTQ/trans-relevant
 * → status='community-partner' (LGBTQ+ pipeline, NOT dismissed); relevant +
 * score >= threshold → 'qualified'; otherwise → 'dismissed' with reason.
 *
 * Selection: analysis_status='prefilter_passed' AND status='found' AND
 * researched_date IS NULL AND scrape_status != 'failed'.
 * Idempotent: researched rows get researched_date + a new analysis_status, so
 * re-runs skip them. Scrape failures are written with scrape_status='failed'
 * (no researched_date, analysis skipped) and excluded from future default runs.
 *
 * Usage: node b2b-discovery/researchSurvivors.js [--execute] [--limit N] [--concurrency N]
 *   Dry-run (default): lists what would be processed — no scrapes, no AI, no writes.
 */
require('dotenv').config();

const { closePuppeteer } = require('./lib/scraper');
const { researchProspect } = require('./lib/researcher');
const { saveProspect } = require('./lib/db');
const { getSupabaseClient } = require('../shared/supabaseClient');

async function fetchSurvivors(sb, limit) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('retailer_prospects')
      .select('*')
      .eq('analysis_status', 'prefilter_passed')
      .eq('status', 'found')
      .is('researched_date', null)
      .or('scrape_status.is.null,scrape_status.neq.failed')
      .order('found_date', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000 || (limit && rows.length >= limit)) break;
    from += 1000;
  }
  return limit ? rows.slice(0, limit) : rows;
}

async function main() {
  const argv = process.argv;
  const EXECUTE = argv.includes('--execute');
  const li = argv.indexOf('--limit');
  const LIMIT = li > -1 ? Number(argv[li + 1]) : null;
  const ci = argv.indexOf('--concurrency');
  const CONCURRENCY = ci > -1 ? Number(argv[ci + 1]) : 3;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }
  const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!mapsApiKey) {
    console.error('Error: GOOGLE_MAPS_API_KEY not set in .env (needed for website lookup — most survivors have no website yet)');
    process.exit(1);
  }

  const sb = getSupabaseClient();
  const rows = await fetchSurvivors(sb, LIMIT);
  console.log(
    `${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — prefilter survivors to research: ${rows.length}` +
    `${LIMIT ? ` (limit ${LIMIT})` : ''} — concurrency ${CONCURRENCY}`
  );
  if (!rows.length) return;

  if (!EXECUTE) {
    const sample = rows.slice(0, 25);
    for (const r of sample) {
      console.log(
        `  ${String(r.company_name).slice(0, 45).padEnd(45)} ${[r.city, r.state].filter(Boolean).join(', ').padEnd(22)} ` +
        `${r.website ? r.website : '(website via Place Details)'}`
      );
    }
    if (rows.length > sample.length) console.log(`  …and ${rows.length - sample.length} more`);
    console.log('\nDry run: nothing scraped, analyzed, or written. Re-run with --execute.');
    return;
  }

  const counts = {
    researched: 0,        // analysis_status='success'
    qualified: 0,
    communityPartner: 0,
    dismissed: 0,
    analysisFailed: 0,    // analysis_status='failed' (researched_date set, status stays 'found')
    scrapeFailed: 0,      // scrape_status='failed' — analysis skipped, retryable
    skippedNoDomain: 0,   // no website found even via Place Details
    merged: 0,            // domain duplicate of an existing prospect
    errors: 0,
  };
  const total = rows.length;

  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const i = idx++;
      const p = rows[i];
      const started = Date.now();
      const tag = () => `(${i + 1}/${total}) ${p.company_name}`;
      const secs = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;

      try {
        const updated = await researchProspect(p, {
          mapsApiKey,
          skipIfNoContent: true,
          skipNamePreFilter: true, // survivors already passed the Haiku pre-filter
        });
        delete updated._timings;

        if (updated._merged) {
          await saveProspect({
            ...p,
            status: 'dismissed',
            irrelevant_reason: `domain-duplicate of ${updated._mergedInto}`,
            analysis_status: 'merged',
            researched_date: new Date().toISOString(),
          });
          counts.merged++;
          console.log(`${tag()} → merged into ${updated._mergedInto} ${secs()}`);
          continue;
        }

        if (updated._skippedNoContent) {
          delete updated._skippedNoContent;
          await saveProspect(updated);
          if (updated.scrape_error === 'No website URL') {
            counts.skippedNoDomain++;
            console.log(`${tag()} → no website found, skipped ${secs()}`);
          } else {
            counts.scrapeFailed++;
            console.log(`${tag()} → scrape failed (${updated.scrape_error}), skipped ${secs()}`);
          }
          continue;
        }

        try {
          await saveProspect(updated);
        } catch (saveErr) {
          // Domain or place_id collision from concurrent workers — dismiss this record
          if (saveErr.message && (saveErr.message.includes('idx_retailer_prospects_domain') || saveErr.message.includes('idx_retailer_prospects_place_id'))) {
            await saveProspect({
              ...p,
              status: 'dismissed',
              irrelevant_reason: 'constraint-collision',
              analysis_status: 'merged',
              researched_date: new Date().toISOString(),
            });
            counts.merged++;
            console.log(`${tag()} → constraint collision, dismissed ${secs()}`);
            continue;
          }
          throw saveErr;
        }

        if (updated.analysis_status === 'failed') {
          counts.analysisFailed++;
          console.log(`${tag()} → ANALYSIS FAILED (${updated.irrelevant_reason || 'unknown'}) ${secs()}`);
          continue;
        }

        counts.researched++;
        if (updated.status === 'qualified') counts.qualified++;
        else if (updated.status === 'community-partner') counts.communityPartner++;
        else counts.dismissed++;
        console.log(`${tag()} → score ${updated.score ?? 'n/a'}, ${String(updated.status).toUpperCase()} ${secs()}`);
      } catch (err) {
        counts.errors++;
        console.log(`${tag()} → ERROR: ${err.message} ${secs()}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  console.log(
    `\nDone. researched=${counts.researched} (qualified=${counts.qualified}, ` +
    `community-partner=${counts.communityPartner}, dismissed=${counts.dismissed}) | ` +
    `analysis-failed=${counts.analysisFailed} | scrape-failed=${counts.scrapeFailed} | ` +
    `skipped-no-domain=${counts.skippedNoDomain} | merged=${counts.merged} | errors=${counts.errors}`
  );

  const remaining = await fetchSurvivors(sb, null);
  console.log(`Remaining survivors awaiting research: ${remaining.length}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[FATAL]', err.message);
      process.exitCode = 1;
    })
    .finally(() => closePuppeteer());
}
