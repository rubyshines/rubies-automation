/**
 * gscClient.js
 * Google Search Console API wrapper.
 * Fetches the top 10 keywords by impressions for the last 7 days.
 */

const { google } = require('googleapis');
const { getDaysAgoDate } = require('./utils');

/**
 * Fetch the top 10 search queries from Google Search Console.
 *
 * Results are sorted by impressions descending so we always see
 * the keywords getting the most visibility, not just the most clicks.
 *
 * @returns {Promise<Array<{ query: string, impressions: number, clicks: number, position: number, ctr: number }>>}
 */
async function fetchSearchConsoleData() {
  // Authenticate using the service account key file
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const authClient = await auth.getClient();
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  // Build a 7-day date range (Search Console uses inclusive start/end dates)
  const endDate = getDaysAgoDate(0);    // today
  const startDate = getDaysAgoDate(7);  // 7 days ago

  const siteUrl = process.env.SEARCH_CONSOLE_SITE_URL;

  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],        // Group results by search keyword
      searchType: 'web',            // Web results only (not image, video, etc.)
      rowLimit: 10,                 // Top 10 keywords
      orderBy: [
        {
          fieldName: 'impressions',
          sortOrder: 'DESCENDING',  // Highest impressions first
        },
      ],
    },
  });

  const rows = response.data.rows || [];

  if (rows.length === 0) {
    console.log('  ⚠️  No Search Console data found for the last 7 days');
    return [];
  }

  // Map the raw API response into a clean, readable format
  return rows.map((row) => ({
    query: row.keys[0],
    impressions: row.impressions || 0,
    clicks: row.clicks || 0,
    // Position is the average rank (1 = top of page 1). Round to 1 decimal.
    position: Math.round((row.position || 0) * 10) / 10,
    // CTR comes back as a decimal (e.g. 0.036 = 3.6%), convert to percentage
    ctr: Math.round((row.ctr || 0) * 100 * 10) / 10,
  }));
}

module.exports = { fetchSearchConsoleData };
