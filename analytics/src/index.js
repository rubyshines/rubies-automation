/**
 * index.js
 * Main entry point for the RUBIES daily analytics automation.
 *
 * Run with: npm run fetch-metrics
 *
 * Collects data for the previous calendar day (yesterday).
 * If the job missed one or more days it backfills all missing days.
 * Re-running for a date updates existing rows (never duplicates).
 *
 * Sheets written:
 *   GA4 Daily          - 1 row/day  (organic GA4 metrics)
 *   GSC Daily Summary  - 1 row/day  (site-wide Search Console totals)
 *   GSC Keywords       - up to 50 rows/day (top keywords by clicks)
 *   GSC Pages          - up to 25 rows/day (top pages by clicks)
 *   Shopify Daily      - ~5 rows/day  (per-channel metrics)
 *   Shopify Geography  - ~10 rows/day (per-country metrics)
 */

require('dotenv').config();

const { fetchGoogleAnalyticsData }     = require('./gaClient');
const { fetchGSCSummary, fetchGSCKeywords, fetchGSCPages } = require('./gscClient');
const { fetchShopifyChannels, fetchShopifyGeography }      = require('./shopifyClient');
const {
  getLastRunDate,
  writeGA4Daily,
  writeGSCSummary,
  writeGSCKeywords,
  writeGSCPages,
  writeShopifyDaily,
  writeShopifyGeography,
} = require('./sheetsClient');
const { addDays, getTomorrowDate, getYesterdayDate, isSameDate } = require('./utils');

// ─────────────────────────────────────────────────────────────────────────────
// Date range helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDatesToProcess(lastRunDate, yesterday) {
  if (!lastRunDate) return [yesterday];
  if (isSameDate(lastRunDate, yesterday)) return [yesterday];
  if (lastRunDate >= yesterday) return [yesterday];
  const dates = [];
  let d = addDays(lastRunDate, 1);
  while (d <= yesterday) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const yesterday = getYesterdayDate();
  const tomorrow  = getTomorrowDate();

  // ── Step 1: Determine which dates to process ─────────────────────────────

  console.log('🔍 Checking last run date...');

  let lastRunDate = null;
  try {
    lastRunDate = await getLastRunDate();
    if (!lastRunDate) {
      console.log('  ✓ No previous data — this is the first run');
    } else if (isSameDate(lastRunDate, yesterday)) {
      console.log(`  ✓ Last run: ${lastRunDate} (yesterday) — re-running will update existing rows`);
    } else if (lastRunDate < yesterday) {
      console.log(`  ✓ Last run: ${lastRunDate} — backfilling missing days through ${yesterday}`);
    }
  } catch (err) {
    console.log('  ⚠️  Could not read sheet (may be first run):', err.message);
  }

  const datesToProcess = getDatesToProcess(lastRunDate, yesterday);
  console.log(`\n📅 Processing ${datesToProcess.length} day(s): ${datesToProcess.join(', ')}\n`);

  let anySuccess = false;
  let totalRowsAdded = 0;

  // ── Step 2: Process each date ─────────────────────────────────────────────

  for (const reportDate of datesToProcess) {
    const label = reportDate === yesterday ? '(yesterday)' : '(backfill)';
    console.log(`\n── ${reportDate} ${label} ──`);

    // ── GA4 ────────────────────────────────────────────────────────────────
    console.log('🔍 Fetching Google Analytics data...');
    let gaData = null;
    try {
      gaData = await fetchGoogleAnalyticsData({ date: reportDate });
      console.log(
        `  ✓ GA4: ${gaData.sessions.toLocaleString()} sessions, ` +
        `${gaData.users.toLocaleString()} users, ` +
        `${gaData.engagementRate}% engagement rate`
      );
    } catch (err) {
      console.error('  ✗ GA4 failed:', err.message);
    }

    // ── GSC Summary ────────────────────────────────────────────────────────
    console.log('🔍 Fetching Search Console summary...');
    let gscSummary = null;
    try {
      gscSummary = await fetchGSCSummary({ date: reportDate });
      if (gscSummary) {
        console.log(
          `  ✓ GSC Summary: ${gscSummary.totalClicks} clicks, ` +
          `${gscSummary.totalImpressions} impressions, ` +
          `avg position ${gscSummary.avgPosition}`
        );
      } else {
        console.log('  ⚠️  GSC Summary: no data (data often lags 2–3 days)');
      }
    } catch (err) {
      console.error('  ✗ GSC Summary failed:', err.message);
    }

    // ── GSC Keywords ───────────────────────────────────────────────────────
    console.log('🔍 Fetching Search Console keywords...');
    let gscKeywordResult = { totalFound: 0, keywords: [] };
    try {
      gscKeywordResult = await fetchGSCKeywords({ date: reportDate });
      const { totalFound, keywords } = gscKeywordResult;
      if (totalFound === 0) {
        console.log('  ✓ GSC Keywords: 0 keywords (no data yet — data often lags 2–3 days)');
      } else {
        console.log(`  ✓ GSC Keywords: ${totalFound} total keywords found, saved top ${keywords.length} by clicks`);
      }
    } catch (err) {
      console.error('  ✗ GSC Keywords failed:', err.message);
    }

    // ── GSC Pages ──────────────────────────────────────────────────────────
    console.log('🔍 Fetching Search Console pages...');
    let gscPageResult = { totalFound: 0, pages: [] };
    try {
      gscPageResult = await fetchGSCPages({ date: reportDate });
      const { totalFound, pages } = gscPageResult;
      if (totalFound === 0) {
        console.log('  ✓ GSC Pages: 0 pages (no data yet — data often lags 2–3 days)');
      } else {
        console.log(`  ✓ GSC Pages: ${totalFound} total pages found, saved top ${pages.length} by clicks`);
      }
    } catch (err) {
      console.error('  ✗ GSC Pages failed:', err.message);
    }

    // ── Shopify ────────────────────────────────────────────────────────────
    console.log('🔍 Fetching Shopify analytics...');
    let shopifyChannels  = null;
    let shopifyGeo       = null;
    try {
      [shopifyChannels, shopifyGeo] = await Promise.all([
        fetchShopifyChannels({ date: reportDate }),
        fetchShopifyGeography({ date: reportDate }),
      ]);
      const chCount  = shopifyChannels  ? shopifyChannels.length  : 0;
      const geoCount = shopifyGeo       ? shopifyGeo.length       : 0;
      console.log(`  ✓ Shopify: ${chCount} channels, ${geoCount} countries`);
    } catch (err) {
      console.error('  ✗ Shopify failed:', err.message);
    }

    // ── Write to sheets ────────────────────────────────────────────────────
    console.log('📝 Writing to Google Sheets...');

    if (gaData) {
      try {
        await writeGA4Daily(gaData, reportDate);
        console.log('  ✓ GA4 Daily updated (1 row)');
        anySuccess = true;
        totalRowsAdded += 1;
      } catch (err) {
        console.error('  ✗ Failed to write GA4 Daily:', err.message);
      }
    }

    // Always write GSC Daily Summary (use zeros when no data — GSC often lags 2–3 days)
    try {
      await writeGSCSummary(
        gscSummary || { totalClicks: 0, totalImpressions: 0, avgCtr: 0, avgPosition: 0 },
        reportDate
      );
      console.log('  ✓ GSC Daily Summary updated (1 row)');
      totalRowsAdded += 1;
    } catch (err) {
      console.error('  ✗ Failed to write GSC Daily Summary:', err.message);
    }

    // Always write GSC Keywords (one placeholder row when no data)
    try {
      const keywordsToWrite = gscKeywordResult.keywords.length > 0
        ? gscKeywordResult.keywords
        : [{ keyword: 'No data (GSC lags 2–3 days)', rank: '', clicks: 0, impressions: 0, ctr: 0 }];
      const n = await writeGSCKeywords(keywordsToWrite, reportDate);
      console.log(`  ✓ GSC Keywords updated (${n} rows)`);
      totalRowsAdded += n;
    } catch (err) {
      console.error('  ✗ Failed to write GSC Keywords:', err.message);
    }

    // Always write GSC Pages (one placeholder row when no data)
    try {
      const pagesToWrite = gscPageResult.pages.length > 0
        ? gscPageResult.pages
        : [{ page: 'No data (GSC lags 2–3 days)', clicks: 0, impressions: 0, avgPosition: 0, ctr: 0 }];
      const n = await writeGSCPages(pagesToWrite, reportDate);
      console.log(`  ✓ GSC Pages updated (${n} rows)`);
      totalRowsAdded += n;
    } catch (err) {
      console.error('  ✗ Failed to write GSC Pages:', err.message);
    }

    if (shopifyChannels) {
      try {
        const n = await writeShopifyDaily(shopifyChannels, reportDate);
        console.log(`  ✓ Shopify Daily updated (${n} rows)`);
        totalRowsAdded += n;
      } catch (err) {
        console.error('  ✗ Failed to write Shopify Daily:', err.message);
      }
    }

    if (shopifyGeo) {
      try {
        const n = await writeShopifyGeography(shopifyGeo, reportDate);
        console.log(`  ✓ Shopify Geography updated (${n} rows)`);
        totalRowsAdded += n;
      } catch (err) {
        console.error('  ✗ Failed to write Shopify Geography:', err.message);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}`;

  if (anySuccess) {
    console.log('\n✅ Done! All data collected.');
    console.log(`💡 Total rows added today: ${totalRowsAdded}`);
    console.log(`💡 Next run available: ${tomorrow}`);
    console.log(`\nSheet: ${sheetUrl}`);
    process.exit(0);
  } else {
    console.error('\n❌ Script completed with errors — no data was written. Check the logs above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
