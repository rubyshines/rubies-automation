/**
 * gaClient.js
 * Google Analytics 4 API wrapper.
 * Fetches organic traffic data for the last 7 days.
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

/**
 * Fetch organic sessions, users, and conversion rate from GA4.
 *
 * Uses the Google Analytics Data API with a filter for "Organic Search" channel
 * so we only see traffic that came from search engines (not direct, paid, social, etc).
 *
 * @returns {Promise<{ sessions: number, users: number, conversionRate: number }>}
 */
async function fetchGoogleAnalyticsData() {
  // Initialize the GA4 client using the service account key file
  const analyticsDataClient = new BetaAnalyticsDataClient({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
  });

  const propertyId = process.env.GA4_PROPERTY_ID;

  // Run the report request against the GA4 API
  const [response] = await analyticsDataClient.runReport({
    property: `properties/${propertyId}`,

    // Last 7 days window (today counted as "0daysAgo")
    dateRanges: [
      {
        startDate: '7daysAgo',
        endDate: 'today',
      },
    ],

    // The numbers we want back
    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'conversions' },
    ],

    // Only include rows where traffic channel is organic search
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: {
          matchType: 'EXACT',
          value: 'Organic Search',
        },
      },
    },
  });

  // If no rows came back, organic traffic is zero
  if (!response.rows || response.rows.length === 0) {
    console.log('  ⚠️  No organic traffic data found in GA4 for the last 7 days');
    return { sessions: 0, users: 0, conversionRate: 0 };
  }

  // GA4 returns metric values as strings, so parse them to numbers
  const row = response.rows[0];
  const sessions = parseInt(row.metricValues[0].value, 10) || 0;
  const users = parseInt(row.metricValues[1].value, 10) || 0;
  const conversions = parseFloat(row.metricValues[2].value) || 0;

  // Conversion rate = (conversions ÷ sessions) × 100, rounded to 1 decimal place
  const conversionRate = sessions > 0
    ? Math.round((conversions / sessions) * 100 * 10) / 10
    : 0;

  return { sessions, users, conversionRate };
}

module.exports = { fetchGoogleAnalyticsData };
