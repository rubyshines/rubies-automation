/**
 * gscClient.js
 * Google Search Console API wrapper.
 *
 * Exports two functions:
 *   fetchGSCSummary()   - site-wide daily totals (no dimensions)
 *   fetchGSCKeywords()  - top 10 keywords by impressions
 *   fetchGSCPages()     - top 10 pages by clicks
 *
 * All functions accept an optional { date } option (YYYY-MM-DD); default: yesterday.
 * GSC data typically lags 2-3 days — callers should handle empty results gracefully.
 */

const { google } = require('googleapis');
const { getYesterdayDate } = require('./utils');

async function getSearchConsoleClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const authClient = await auth.getClient();
  return google.searchconsole({ version: 'v1', auth: authClient });
}

// ─────────────────────────────────────────────────────────────────────────────
// Site-wide daily summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch site-wide totals for one day or a date range (no dimension grouping).
 *
 * @param {{ date?: string, startDate?: string, endDate?: string }} options
 * @returns {Promise<{ totalClicks: number, totalImpressions: number, avgCtr: number, avgPosition: number } | null>}
 */
async function fetchGSCSummary(options = {}) {
  const startDate = options.startDate != null && options.endDate != null
    ? options.startDate
    : (options.date || getYesterdayDate());
  const endDate = options.startDate != null && options.endDate != null
    ? options.endDate
    : (options.date || getYesterdayDate());
  const searchconsole = await getSearchConsoleClient();

  const response = await searchconsole.searchanalytics.query({
    siteUrl: process.env.SEARCH_CONSOLE_SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions: [],   // no dimensions = one aggregated row for the whole site
      type: 'web',      // web search only (default)
      dataState: 'all', // include fresh/partial data so recent days match the GSC UI
    },
  });

  const rows = response.data.rows || [];
  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    totalClicks:      r.clicks      || 0,
    totalImpressions: r.impressions || 0,
    avgCtr:           Math.round((r.ctr      || 0) * 100 * 100) / 100,
    avgPosition:      Math.round((r.position || 0) * 10) / 10,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top keywords by clicks (fetch up to 1,000, save top 50)
// ─────────────────────────────────────────────────────────────────────────────

const GSC_KEYWORDS_FETCH_LIMIT = 1000;
const GSC_KEYWORDS_SAVE_TOP = 50;

/**
 * Fetch up to 1,000 keywords from Search Console, ordered by clicks (traffic drivers).
 * Returns the top 50 by clicks for writing to the sheet (~80–90% of click coverage).
 * Supports a date range for 365-day aggregation.
 *
 * @param {{ date?: string, startDate?: string, endDate?: string }} options
 * @returns {Promise<{ totalFound: number, keywords: Array<{ keyword: string, rank: number, clicks: number, impressions: number, ctr: number }> }>}
 */
async function fetchGSCKeywords(options = {}) {
  const startDate = options.startDate != null && options.endDate != null
    ? options.startDate
    : (options.date || getYesterdayDate());
  const endDate = options.startDate != null && options.endDate != null
    ? options.endDate
    : (options.date || getYesterdayDate());
  const searchconsole = await getSearchConsoleClient();

  const response = await searchconsole.searchanalytics.query({
    siteUrl: process.env.SEARCH_CONSOLE_SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],
      type: 'web',
      dataState: 'all',
      rowLimit: GSC_KEYWORDS_FETCH_LIMIT,
      orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
    },
  });

  const rows = response.data.rows || [];
  const mapped = rows.map((row) => ({
    keyword:     row.keys[0],
    rank:        Math.round((row.position    || 0) * 10)       / 10,
    clicks:      row.clicks      || 0,
    impressions: row.impressions || 0,
    ctr:         Math.round((row.ctr         || 0) * 100 * 100) / 100,
  }));

  const top50 = mapped.slice(0, GSC_KEYWORDS_SAVE_TOP);
  return { totalFound: rows.length, keywords: top50 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top pages by clicks (fetch up to 100, save top 25)
// ─────────────────────────────────────────────────────────────────────────────

const GSC_PAGES_FETCH_LIMIT = 100;
const GSC_PAGES_SAVE_TOP = 25;

/**
 * Fetch up to 100 landing pages from Search Console, ordered by clicks descending.
 * Returns the top 25 by clicks for writing to the sheet (~99%+ click coverage).
 * Supports a date range for 365-day aggregation.
 *
 * @param {{ date?: string, startDate?: string, endDate?: string }} options
 * @returns {Promise<{ totalFound: number, pages: Array<{ page: string, clicks: number, impressions: number, avgPosition: number, ctr: number }> }>}
 */
async function fetchGSCPages(options = {}) {
  const startDate = options.startDate != null && options.endDate != null
    ? options.startDate
    : (options.date || getYesterdayDate());
  const endDate = options.startDate != null && options.endDate != null
    ? options.endDate
    : (options.date || getYesterdayDate());
  const searchconsole = await getSearchConsoleClient();

  const response = await searchconsole.searchanalytics.query({
    siteUrl: process.env.SEARCH_CONSOLE_SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      type: 'web',
      dataState: 'all',
      rowLimit: GSC_PAGES_FETCH_LIMIT,
      orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
    },
  });

  const rows = response.data.rows || [];
  const mapped = rows.map((row) => ({
    page:        row.keys[0],
    clicks:      row.clicks      || 0,
    impressions: row.impressions || 0,
    avgPosition: Math.round((row.position || 0) * 10)        / 10,
    ctr:         Math.round((row.ctr      || 0) * 100 * 100) / 100,
  }));

  const top25 = mapped.slice(0, GSC_PAGES_SAVE_TOP);
  return { totalFound: rows.length, pages: top25 };
}

module.exports = { fetchGSCSummary, fetchGSCKeywords, fetchGSCPages };
