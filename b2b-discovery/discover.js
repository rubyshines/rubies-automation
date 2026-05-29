#!/usr/bin/env node
require('dotenv').config();

const { scrapeProspect, closePuppeteer } = require('./lib/scraper');
const { findContacts } = require('./lib/contactFinder');
const { searchCityTerm } = require('./lib/maps');
const { TIER1_TERMS, TIER2_TERMS, TIER1_CITIES, TIER2_CITIES } = require('./lib/searchTerms');
const { isExcluded } = require('./lib/excludeList');
const {
  generateId,
  saveProspect,
  getProspectByPlaceId,
  mergeProspect,
  markProgressComplete,
  isProgressComplete,
} = require('./lib/db');
const { researchProspect } = require('./lib/researcher');
const { syncProspectsToSheet } = require('./lib/sheets');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { MODELS } = require('../shared/aiPricing');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ─── Step 1: Scrape test ────────────────────────────────────────────────────

async function runScrapeTest(url) {
  console.log(`\n=== Scrape Test: ${url} ===`);
  const result = await scrapeProspect(url, true);
  if (result.error) console.log(`[ERROR] ${result.error}`);
  console.log('=== Done ===\n');
}

async function runContactTest(url) {
  console.log(`\n=== Contact Test: ${url} ===`);
  const result = await scrapeProspect(url, true);

  if (result.error) {
    console.log(`[ERROR] ${result.error}`);
    console.log('=== Done ===\n');
    return;
  }

  console.log('[CONTACTS] Scanning for contact info...');
  const contacts = findContacts(result.rawHtmlByPage);

  if (contacts.email) {
    const emailPage = Object.keys(result.rawHtmlByPage).find(
      (u) => result.rawHtmlByPage[u]?.toLowerCase().includes(contacts.email)
    );
    console.log(
      `  → Emails found: ${contacts.email} (${contacts.emailType}${emailPage ? ', ' + new URL(emailPage).pathname + ' page' : ''})`
    );
  } else {
    console.log('  → Emails found: (none)');
  }

  if (contacts.additionalEmails.length > 0) {
    console.log(`  → Additional emails: ${contacts.additionalEmails.join(', ')}`);
  }
  if (contacts.contactFormUrl) {
    console.log(`  → Contact form: ${contacts.contactFormUrl}`);
  }
  if (contacts.contactPageUrl && contacts.contactPageUrl !== contacts.contactFormUrl) {
    console.log(`  → Contact page: ${contacts.contactPageUrl}`);
  }
  console.log(`  → Phone: ${contacts.phone || '(none found)'}`);
  console.log(`  → Best email: ${contacts.email || '(none)'}`);
  console.log(`  → Contact method: ${contacts.contactMethod}`);
  console.log('=== Done ===\n');
}

// ─── Step 2: Google Maps test (dry run, no DB write) ────────────────────────

async function runMapsTest(args) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('Error: GOOGLE_MAPS_API_KEY not set in .env');
    process.exit(1);
  }

  const term = args.term;
  const city = args.city;
  if (!term || !city) {
    console.error(
      'Usage: node wholesale/discover.js --maps-test --term "LGBTQ friendly store" --city "Portland OR"'
    );
    process.exit(1);
  }

  console.log(`\n=== Maps Test: "${term}" in "${city}" ===\n`);

  const results = await searchCityTerm({ term, cityStr: city, apiKey, verbose: true });

  console.log(`\n${results.length} result${results.length !== 1 ? 's' : ''}:\n`);
  results.forEach((r, i) => {
    const types = r.types.filter((t) => t !== 'point_of_interest' && t !== 'establishment').slice(0, 3);
    console.log(`  ${i + 1}. ${r.company_name}`);
    console.log(`     ${r.address}`);
    console.log(`     Place ID: ${r.google_place_id}${types.length ? ' | ' + types.join(', ') : ''}`);
    if (i < results.length - 1) console.log('');
  });

  console.log(
    `\n=== Done — run --source google-maps --tier 1 --city "${city}" to discover and save ===\n`
  );
}

// ─── Step 2: Full Google Maps discovery ─────────────────────────────────────

async function runGoogleMapsDiscovery(args) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('Error: GOOGLE_MAPS_API_KEY not set in .env');
    process.exit(1);
  }

  const tier = parseInt(args.tier || '1', 10);
  if (tier !== 1 && tier !== 2) {
    console.error('--tier must be 1 or 2 (Tier 3 requires --confirm and is not yet implemented)');
    process.exit(1);
  }

  const cityFilter = args.city || null;
  const cities = tier === 1 ? TIER1_CITIES : TIER2_CITIES;
  const terms = tier === 1 ? TIER1_TERMS : TIER2_TERMS;

  const filteredCities = cityFilter
    ? cities.filter((c) => c.toLowerCase().includes(cityFilter.toLowerCase()))
    : cities;

  if (filteredCities.length === 0) {
    console.error(`No Tier ${tier} cities matched "${cityFilter}"`);
    console.error(`Available cities: ${cities.join(', ')}`);
    process.exit(1);
  }

  const total = filteredCities.length * terms.length;
  console.log(
    `\n[MAPS] Tier ${tier} — ${filteredCities.length} ${filteredCities.length === 1 ? 'city' : 'cities'} × ${terms.length} terms = ${total} searches\n`
  );

  let searchNum = 0;
  let totalNew = 0;
  let totalMerged = 0;

  for (const cityStr of filteredCities) {
    for (const term of terms) {
      searchNum++;
      const progressId = `google-maps:tier${tier}:${cityStr}:${term}`;

      if (await isProgressComplete(progressId)) {
        console.log(`(${searchNum}/${total}) ${cityStr} × "${term}": skipped (done)`);
        continue;
      }

      process.stdout.write(`(${searchNum}/${total}) ${cityStr} × "${term}": `);

      let rawResults;
      try {
        rawResults = await searchCityTerm({ term, cityStr, apiKey });
      } catch (err) {
        // Fatal API errors — halt immediately
        if (
          err.message.includes('REQUEST_DENIED') ||
          err.message.includes('INVALID_REQUEST')
        ) {
          console.log(`\n[MAPS] Fatal API error: ${err.message}`);
          process.exit(1);
        }
        console.log(`ERROR — ${err.message}`);
        await sleep(1000);
        continue;
      }

      process.stdout.write(`${rawResults.length} results`);

      let newCount = 0;
      let mergedCount = 0;

      for (const r of rawResults) {
        if (isExcluded(r.company_name)) continue;

        try {
          // Dedup by place_id (no API call needed)
          const existingByPlaceId = await getProspectByPlaceId(r.google_place_id);
          if (existingByPlaceId) {
            await mergeProspect(existingByPlaceId.id, { sources: ['google-maps'] });
            mergedCount++;
            continue;
          }

          // Save now without website — Place Details fetched lazily in Step 3 before scraping
          await saveProspect({
            id: generateId(),
            status: 'found',
            company_name: r.company_name,
            address: r.address,
            city: r.city,
            state: r.state,
            google_place_id: r.google_place_id,
            discovery_tier: String(tier),
            source: 'google-maps',
            sources: ['google-maps'],
            found_date: new Date().toISOString(),
          });

          newCount++;
        } catch (dbErr) {
          // Transient DB error — log and skip this result, don't crash the run
          process.stdout.write(` [DB ERR: ${r.company_name}]`);
        }
      }

      totalNew += newCount;
      totalMerged += mergedCount;

      const suffix =
        newCount || mergedCount ? ` → ${newCount} new, ${mergedCount} merged` : '';
      console.log(suffix);

      await markProgressComplete(progressId, rawResults.length);

      // 1s rate limit between searches
      await sleep(1000);
    }
  }

  console.log(
    `\n[MAPS] Done. ${totalNew} new prospects saved, ${totalMerged} duplicates merged.\n`
  );
}

// ─── Step 3: Research ────────────────────────────────────────────────────────

// Dry-run research against a single URL (no DB write by default)
async function runResearchUrl(args) {
  const url = args.url || args['research-url'];
  if (!url) {
    console.error('Usage: node wholesale/discover.js --research-url <url> [--model sonnet] [--save]');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const model = args.model
    ? (args.model === 'sonnet' ? MODELS.SONNET : args.model)
    : undefined;

  console.log(`\n=== Research: ${url} ===\n`);

  const fakePropect = {
    id: 'test',
    company_name: url,
    website: url,
    city: '',
    state: '',
    google_place_id: null,
  };

  const result = await researchProspect(fakePropect, {
    model,
    verbose: true,
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  });

  if (args.save) {
    console.log('\n[SAVE] --save not supported with --research-url (no place_id to key on)');
  }

  console.log(`\n=== Done. Score: ${result.score ?? 'n/a'} | Status: ${result.status} ===\n`);
}

// Batch research all unresearched prospects from DB
async function runResearch(args) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const model = args.model
    ? (args.model === 'sonnet' ? MODELS.SONNET : args.model)
    : undefined;
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  const retryFailed = !!args['retry-failed'];
  const verbose = !!args.verbose;
  const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 5;

  const client = getSupabaseClient();

  let query = client
    .from('retailer_prospects')
    .select('*')
    .order('found_date', { ascending: true });

  if (retryFailed) {
    query = query.eq('scrape_status', 'failed');
  } else {
    query = query.eq('status', 'found');
  }

  if (limit) query = query.limit(limit);

  const { data: prospects, error } = await query;
  if (error) { console.error('DB error:', error.message); process.exit(1); }

  const total = prospects.length;
  console.log(`\n[RESEARCH] ${total} prospects to research${limit ? ` (limit: ${limit})` : ''} — concurrency: ${concurrency}\n`);

  let qualified = 0, dismissed = 0, failed = 0, merged = 0, communityPartners = 0;
  let completed = 0;
  const timings = []; // { name, totalMs, placeDetailsMs, scrapeMs, analyzeMs, method }

  // Worker pool — each worker pulls the next prospect until exhausted
  let idx = 0;
  async function worker() {
    while (idx < prospects.length) {
      const i = idx++;
      const p = prospects[i];
      const prospectStart = Date.now();

      try {
        const updated = await researchProspect(p, {
          model,
          verbose,
          mapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
        });

        const totalMs = Date.now() - prospectStart;
        completed++;

        if (updated._merged) {
          // Dismiss the 'found' record so it's not picked up in future batches
          await saveProspect({
            ...p,
            status: 'dismissed',
            irrelevant_reason: `domain-duplicate of ${updated._mergedInto}`,
            analysis_status: 'merged',
            researched_date: new Date().toISOString(),
          });
          console.log(`(${i + 1}/${total}) ${p.company_name} → merged into ${updated._mergedInto} [${(totalMs/1000).toFixed(1)}s]`);
          merged++;
          continue;
        }

        const timingsData = updated._timings;
        delete updated._timings;
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
            console.log(`(${i + 1}/${total}) ${p.company_name} → constraint collision, dismissed [${(totalMs/1000).toFixed(1)}s]`);
            dismissed++;
            continue;
          }
          throw saveErr;
        }

        const scoreStr = updated.score != null ? `score ${updated.score}` : 'no score';
        const timingStr = timingsData
          ? ` [${(totalMs/1000).toFixed(1)}s: details=${timingsData.placeDetailsMs}ms scrape=${timingsData.scrapeMs}ms ai=${timingsData.analyzeMs}ms method=${timingsData.scrapeMethod}]`
          : ` [${(totalMs/1000).toFixed(1)}s]`;
        console.log(`(${i + 1}/${total}) ${p.company_name} → ${scoreStr}, ${updated.status.toUpperCase()}${timingStr}`);

        if (timingsData) timings.push({ name: p.company_name, totalMs, ...timingsData });

        if (updated.status === 'qualified') qualified++;
        else if (updated.status === 'community-partner') communityPartners++;
        else if (updated.status === 'dismissed') dismissed++;
        else failed++;

      } catch (err) {
        const totalMs = Date.now() - prospectStart;
        console.log(`(${i + 1}/${total}) ${p.company_name} → ERROR: ${err.message} [${(totalMs/1000).toFixed(1)}s]`);
        failed++;
      }
    }
  }

  // Launch N workers in parallel
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

  // Timing summary
  if (timings.length > 0) {
    const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length / 1000).toFixed(1);
    const totals = timings.map(t => t.totalMs);
    const slowest = timings.sort((a, b) => b.totalMs - a.totalMs).slice(0, 3);
    console.log(`\n[TIMING] avg ${avg(totals)}s/prospect | slowest:`);
    slowest.forEach(t =>
      console.log(`  ${t.name}: ${(t.totalMs/1000).toFixed(1)}s (details=${t.placeDetailsMs}ms scrape=${t.scrapeMs}ms ai=${t.analyzeMs}ms method=${t.scrapeMethod})`)
    );
  }

  console.log(`\n[RESEARCH] Done. ${qualified} qualified, ${dismissed} dismissed, ${communityPartners} community-partner, ${failed} failed, ${merged} merged.\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Step 1: scrape tests
  if (args['scrape-test']) {
    if (!args.url) {
      console.error('Usage: node wholesale/discover.js --scrape-test --url <url>');
      process.exit(1);
    }
    try {
      await runScrapeTest(args.url);
    } finally {
      await closePuppeteer();
    }
    return;
  }

  if (args['contact-test']) {
    if (!args.url) {
      console.error('Usage: node wholesale/discover.js --contact-test --url <url>');
      process.exit(1);
    }
    try {
      await runContactTest(args.url);
    } finally {
      await closePuppeteer();
    }
    return;
  }

  // Step 2: Google Maps
  if (args['maps-test']) {
    await runMapsTest(args);
    return;
  }

  if (args.source === 'google-maps') {
    await runGoogleMapsDiscovery(args);
    return;
  }

  // Step 3: Research
  if (args['research-url']) {
    try {
      await runResearchUrl({ ...args, url: args['research-url'] });
    } finally {
      await closePuppeteer();
    }
    return;
  }

  if (args.research) {
    try {
      await runResearch(args);
    } finally {
      await closePuppeteer();
    }
    return;
  }

  // Step 4: Sheets sync
  if (args['sync-sheets']) {
    const client = getSupabaseClient();
    const minScore = args['min-score'] ? parseInt(args['min-score'], 10) : 4;
    const fresh = !!args.fresh;

    if (fresh) {
      // Fresh: fetch all qualifying prospects and rewrite the sheet
      console.log(`\n[SHEETS] Fresh sync — fetching all prospects with score >= ${minScore}...`);
      const { data: prospects, error } = await client
        .from('retailer_prospects')
        .select('*')
        .gte('score', minScore)
        .not('status', 'eq', 'found')
        .order('score', { ascending: false });
      if (error) { console.error('DB error:', error.message); process.exit(1); }
      console.log(`[SHEETS] Found ${prospects.length} prospects`);
      const added = await syncProspectsToSheet(prospects, { verbose: true, fresh: true });
      // Mark all as synced
      const ids = prospects.map(p => p.id);
      for (let i = 0; i < ids.length; i += 200) {
        await client.from('retailer_prospects').update({ synced_to_sheet: true }).in('id', ids.slice(i, i + 200));
      }
      console.log(`[SHEETS] ${added} rows written, all marked as synced`);
    } else {
      // Incremental: only fetch prospects not yet synced
      console.log(`\n[SHEETS] Fetching new prospects with score >= ${minScore} not yet in sheet...`);
      const { data: prospects, error } = await client
        .from('retailer_prospects')
        .select('*')
        .gte('score', minScore)
        .not('status', 'eq', 'found')
        .eq('synced_to_sheet', false);
      if (error) { console.error('DB error:', error.message); process.exit(1); }
      console.log(`[SHEETS] Found ${prospects.length} new prospects to add`);
      const added = await syncProspectsToSheet(prospects, { verbose: true, fresh: false });
      if (added > 0) {
        // Mark synced
        const ids = prospects.map(p => p.id);
        for (let i = 0; i < ids.length; i += 200) {
          await client.from('retailer_prospects').update({ synced_to_sheet: true }).in('id', ids.slice(i, i + 200));
        }
        console.log(`[SHEETS] ${added} new rows added and marked as synced`);
      }
    }
    return;
  }

  // Future steps
  if (args.source) {
    console.log(`--source ${args.source}: Coming in a future step.`);
    process.exit(0);
  }

  const FUTURE_FLAGS = ['report', 'validate', 'compare-models'];
  const futureFlag = FUTURE_FLAGS.find((f) => args[f]);
  if (futureFlag) {
    console.log(`--${futureFlag}: Coming in a future step.`);
    process.exit(0);
  }

  // Help
  console.log('RUBIES Retailer Lead Gen\n');
  console.log('Step 1 — Scrape & Contact:');
  console.log('  --scrape-test --url <url>              Scrape a URL and print content summary');
  console.log('  --contact-test --url <url>             Scrape + extract contacts\n');
  console.log('Step 2 — Google Maps Discovery:');
  console.log('  --maps-test --term <t> --city <c>      Dry-run a single Maps query (no DB write)');
  console.log('  --source google-maps --tier 1          Discover all Tier 1 cities');
  console.log('  --source google-maps --tier 1 --city <c>  Single city, all Tier 1 terms');
  console.log('  --source google-maps --tier 2          Discover all Tier 2 cities\n');
  console.log('Step 3 — Research:');
  console.log('  --research-url <url>                   Test full pipeline on one URL (no DB write)');
  console.log('  --research --limit 10                  Research first 10 unresearched prospects');
  console.log('  --research                             Research all unresearched prospects');
  console.log('  --research --retry-failed              Re-research failed scrapes');
  console.log('  --research --model sonnet              Use Claude Sonnet instead of Haiku\n');
  console.log('Coming in future steps:');
  console.log('  --source directory                     Scrape curated directories');
  console.log('  --source reddit                        Mine Reddit recommendations');
  console.log('  --sync-sheets                          Push qualified leads to Google Sheets');
  console.log('  --report                               Summary report');
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
