/**
 * run365.js
 * One-time (or occasional) script: summarizes the last 365 days of analytics
 * into a separate Google Sheet. Same data sources as the daily script, but
 * one row (or one block) per sheet with date range + aggregated metrics.
 *
 * Run with: npm run fetch-365
 *
 * Requires GOOGLE_SHEET_ID_365 in .env (the 365-day summary spreadsheet).
 */

require('dotenv').config();

const { fetchGoogleAnalyticsData } = require('./gaClient');
const { fetchGSCSummary, fetchGSCKeywords, fetchGSCPages } = require('./gscClient');
const { fetchShopifyChannels, fetchShopifyGeography } = require('./shopifyClient');
const {
  writeGA4Daily365,
  writeGSCSummary365,
  writeGSCKeywords365,
  writeGSCPages365,
  writeShopifyDaily365,
  writeShopifyGeography365,
} = require('./sheetsClient365');
const { getDateRangeLast365 } = require('./utils');

async function main() {
  const { startDate, endDate } = getDateRangeLast365();
  console.log(`\n📅 365-day summary: ${startDate} → ${endDate}\n`);

  if (!process.env.GOOGLE_SHEET_ID_365) {
    console.error('❌ GOOGLE_SHEET_ID_365 is not set in .env');
    process.exit(1);
  }

  // ── Fetch all data for the 365-day range ───────────────────────────────────

  const range = { startDate, endDate };

  console.log('🔍 Fetching GA4 (organic, last 365 days)...');
  let gaData = null;
  try {
    gaData = await fetchGoogleAnalyticsData(range);
    console.log(`  ✓ Sessions: ${gaData.sessions.toLocaleString()}, Users: ${gaData.users.toLocaleString()}`);
  } catch (err) {
    console.error('  ✗ GA4 failed:', err.message);
  }

  console.log('🔍 Fetching GSC summary (last 365 days)...');
  let gscSummary = null;
  try {
    gscSummary = await fetchGSCSummary(range);
    if (gscSummary) {
      console.log(`  ✓ Clicks: ${gscSummary.totalClicks.toLocaleString()}, Impressions: ${gscSummary.totalImpressions.toLocaleString()}`);
    } else {
      console.log('  ⚠️ No GSC summary data');
    }
  } catch (err) {
    console.error('  ✗ GSC Summary failed:', err.message);
  }

  console.log('🔍 Fetching GSC keywords (top by clicks, last 365 days)...');
  let gscKeywordResult = { totalFound: 0, keywords: [] };
  try {
    gscKeywordResult = await fetchGSCKeywords(range);
    console.log(`  ✓ ${gscKeywordResult.keywords.length} keywords`);
  } catch (err) {
    console.error('  ✗ GSC Keywords failed:', err.message);
  }

  console.log('🔍 Fetching GSC pages (top by clicks, last 365 days)...');
  let gscPageResult = { totalFound: 0, pages: [] };
  try {
    gscPageResult = await fetchGSCPages(range);
    console.log(`  ✓ ${gscPageResult.pages.length} pages`);
  } catch (err) {
    console.error('  ✗ GSC Pages failed:', err.message);
  }

  console.log('🔍 Fetching Shopify channels & geography (last 365 days)...');
  let shopifyChannels = null;
  let shopifyGeo = null;
  try {
    [shopifyChannels, shopifyGeo] = await Promise.all([
      fetchShopifyChannels(range),
      fetchShopifyGeography(range),
    ]);
    console.log(`  ✓ ${shopifyChannels ? shopifyChannels.length : 0} channels, ${shopifyGeo ? shopifyGeo.length : 0} countries`);
  } catch (err) {
    console.error('  ✗ Shopify failed:', err.message);
  }

  // ── Write to 365-day spreadsheet ────────────────────────────────────────────

  console.log('\n📝 Writing to 365-day Google Sheet...');

  if (gaData) {
    try {
      await writeGA4Daily365(gaData, startDate, endDate);
      console.log('  ✓ GA4 Daily');
    } catch (err) {
      console.error('  ✗ GA4 Daily:', err.message);
    }
  }

  try {
    await writeGSCSummary365(
      gscSummary || { totalClicks: 0, totalImpressions: 0, avgCtr: 0, avgPosition: 0 },
      startDate,
      endDate
    );
    console.log('  ✓ GSC Daily Summary');
  } catch (err) {
    console.error('  ✗ GSC Daily Summary:', err.message);
  }

  try {
    const keywordsToWrite = gscKeywordResult.keywords.length > 0
      ? gscKeywordResult.keywords
      : [{ keyword: 'No data', rank: '', clicks: 0, impressions: 0, ctr: 0 }];
    await writeGSCKeywords365(keywordsToWrite, startDate, endDate);
    console.log(`  ✓ GSC Keywords (${keywordsToWrite.length} rows)`);
  } catch (err) {
    console.error('  ✗ GSC Keywords:', err.message);
  }

  try {
    const pagesToWrite = gscPageResult.pages.length > 0
      ? gscPageResult.pages
      : [{ page: 'No data', clicks: 0, impressions: 0, avgPosition: 0, ctr: 0 }];
    await writeGSCPages365(pagesToWrite, startDate, endDate);
    console.log(`  ✓ GSC Pages (${pagesToWrite.length} rows)`);
  } catch (err) {
    console.error('  ✗ GSC Pages:', err.message);
  }

  if (shopifyChannels && shopifyChannels.length > 0) {
    try {
      await writeShopifyDaily365(shopifyChannels, startDate, endDate);
      console.log(`  ✓ Shopify Daily (${shopifyChannels.length} rows)`);
    } catch (err) {
      console.error('  ✗ Shopify Daily:', err.message);
    }
  }

  if (shopifyGeo && shopifyGeo.length > 0) {
    try {
      await writeShopifyGeography365(shopifyGeo, startDate, endDate);
      console.log(`  ✓ Shopify Geography (${shopifyGeo.length} rows)`);
    } catch (err) {
      console.error('  ✗ Shopify Geography:', err.message);
    }
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID_365}`;
  console.log('\n✅ 365-day summary complete.');
  console.log(`Sheet: ${sheetUrl}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Unexpected error:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
