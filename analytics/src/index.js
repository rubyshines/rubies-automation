/**
 * index.js
 * Main entry point for the RUBIES daily SEO tracking automation.
 *
 * Run with: npm run fetch-metrics
 *
 * What this script does:
 *   1. Check if it already ran today (exit gracefully if so)
 *   2. Fetch organic traffic data from Google Analytics 4
 *   3. Fetch top keyword rankings from Google Search Console
 *   4. Write everything to the Google Sheet
 */

// Load environment variables from .env file before anything else
require('dotenv').config();

const { fetchGoogleAnalyticsData } = require('./gaClient');
const { fetchSearchConsoleData } = require('./gscClient');
const { getLastRunDate, appendDailyMetrics, updateKeywordRankings } = require('./sheetsClient');
const { getTodayDate, getTomorrowDate, isSameDate } = require('./utils');

async function main() {
  const today = getTodayDate();
  const tomorrow = getTomorrowDate();

  // ── Step 1: Duplicate run check ────────────────────────────────────────────

  console.log('🔍 Checking last run date...');

  let lastRunDate = null;
  let isFirstRun = false;

  try {
    lastRunDate = await getLastRunDate();
  } catch (err) {
    // If we can't read the sheet (e.g. first-ever run, sheet tabs don't exist yet),
    // treat it as a first run rather than crashing
    console.log('  ⚠️  Could not read sheet (may be first run):', err.message);
    lastRunDate = null;
  }

  // Already ran today — exit gracefully without doing any work
  if (isSameDate(lastRunDate, today)) {
    console.log('\n⚠️  Already ran today');
    console.log(`Last run: ${lastRunDate}`);
    console.log(`Next run available: ${tomorrow}`);
    console.log('\nTip: Run this script once per day for consistent tracking.');
    process.exit(0);
  }

  if (!lastRunDate) {
    console.log('  ✓ No previous runs found - this is the first run');
    isFirstRun = true;
  } else {
    console.log(`  ✓ Last run: ${lastRunDate}`);
    console.log(`  ✓ Proceeding with data collection for ${today}`);
  }

  // ── Step 2: Fetch Google Analytics data ───────────────────────────────────

  console.log('\n🔍 Fetching Google Analytics data...');

  let gaData = null;
  try {
    gaData = await fetchGoogleAnalyticsData();
    const { sessions, users, conversionRate } = gaData;
    console.log(
      `  ✓ GA4 data retrieved: ${sessions.toLocaleString()} sessions, ` +
      `${users.toLocaleString()} users, ${conversionRate}% conversion rate`
    );
  } catch (err) {
    console.error('  ✗ Failed to fetch GA4 data:', err.message);
    // Use zeros so the sheet still gets a row for today even if GA fails
    gaData = { sessions: 0, users: 0, conversionRate: 0 };
  }

  // ── Step 3: Fetch Search Console data ─────────────────────────────────────

  console.log('\n🔍 Fetching Search Console data...');

  let keywords = [];
  try {
    keywords = await fetchSearchConsoleData();
    console.log(`  ✓ Retrieved ${keywords.length} keyword${keywords.length !== 1 ? 's' : ''}`);
  } catch (err) {
    console.error('  ✗ Failed to fetch Search Console data:', err.message);
    // Continue without keyword data — daily metrics will still be written
  }

  // ── Step 4: Write to Google Sheets ────────────────────────────────────────

  console.log('\n📝 Writing to Google Sheets...');

  let metricsWritten = false;
  let keywordsWritten = false;

  try {
    await appendDailyMetrics(gaData, isFirstRun);
    const baselineNote = isFirstRun ? ' (baseline)' : '';
    console.log(`  ✓ Daily metrics added for ${today}${baselineNote}`);
    metricsWritten = true;
  } catch (err) {
    console.error('  ✗ Failed to write daily metrics:', err.message);
  }

  if (keywords.length > 0) {
    try {
      await updateKeywordRankings(keywords);
      console.log('  ✓ Keyword rankings updated');
      keywordsWritten = true;
    } catch (err) {
      console.error('  ✗ Failed to update keyword rankings:', err.message);
    }
  } else {
    console.log('  ⚠️  Skipping keyword rankings (no data)');
  }

  // ── Step 5: Summary ───────────────────────────────────────────────────────

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;

  // Only declare full success if both writes succeeded
  if (metricsWritten) {
    console.log(`\n✅ Done! Check your sheet: ${sheetUrl}`);
    console.log(`💡 Next run available: ${tomorrow}`);
    process.exit(0);
  } else {
    console.error('\n❌ Script completed with errors. Check the logs above.');
    process.exit(1);
  }
}

// Run the main function and handle any unexpected top-level errors
main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
