/**
 * gaClient.js
 * Google Analytics 4 API wrapper.
 *
 * Fetches organic search traffic metrics for a single day (default: yesterday).
 * Filters to sessionDefaultChannelGroup == "Organic Search" only.
 *
 * Returns:
 *   sessions, users, newUsers, returningUsers, engagedSessions,
 *   engagementRate, pagesPerSession, avgSessionDuration, bounceRate
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { getYesterdayDate } = require('./utils');

/**
 * @param {{ date?: string, startDate?: string, endDate?: string }} options
 *   - date = YYYY-MM-DD for a single day (default: yesterday).
 *   - startDate + endDate = range (overrides date when both provided).
 * @returns {Promise<{
 *   sessions: number,
 *   users: number,
 *   newUsers: number,
 *   returningUsers: number,
 *   engagedSessions: number,
 *   engagementRate: number,
 *   pagesPerSession: number,
 *   avgSessionDuration: number,
 *   bounceRate: number,
 * }>}
 */
async function fetchGoogleAnalyticsData(options = {}) {
  let startDate;
  let endDate;
  if (options.startDate != null && options.endDate != null) {
    startDate = options.startDate;
    endDate = options.endDate;
  } else {
    const date = options.date || getYesterdayDate();
    startDate = date;
    endDate = date;
  }

  const analyticsDataClient = new BetaAnalyticsDataClient({
    keyFile: process.env.SERVICE_ACCOUNT_KEY_PATH,
  });

  const [response] = await analyticsDataClient.runReport({
    property: `properties/${process.env.GA4_PROPERTY_ID}`,

    dateRanges: [{ startDate, endDate }],

    metrics: [
      { name: 'sessions' },
      { name: 'activeUsers' },
      { name: 'newUsers' },
      { name: 'engagedSessions' },
      { name: 'engagementRate' },
      { name: 'screenPageViewsPerSession' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],

    // Organic search traffic only
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

  const empty = {
    sessions: 0,
    users: 0,
    newUsers: 0,
    returningUsers: 0,
    engagedSessions: 0,
    engagementRate: 0,
    pagesPerSession: 0,
    avgSessionDuration: 0,
    bounceRate: 0,
  };

  if (!response.rows || response.rows.length === 0) {
    console.log(`  ⚠️  No organic traffic data found in GA4 for ${startDate}–${endDate}`);
    return empty;
  }

  const row = response.rows[0];
  const v = (i) => row.metricValues[i]?.value || '0';

  const sessions        = parseInt(v(0), 10)                                    || 0;
  const users           = parseInt(v(1), 10)                                    || 0;
  const newUsers        = parseInt(v(2), 10)                                    || 0;
  const engagedSessions = parseInt(v(3), 10)                                    || 0;
  // engagementRate comes back as a decimal (e.g. 0.742); convert to %
  const engagementRate  = Math.round(parseFloat(v(4)) * 100 * 100) / 100       || 0;
  const pagesPerSession = Math.round(parseFloat(v(5)) * 100) / 100             || 0;
  // averageSessionDuration is in seconds as a float; round to whole seconds
  const avgSessionDuration = Math.round(parseFloat(v(6)))                      || 0;
  // bounceRate comes back as a decimal (e.g. 0.258); convert to %
  const bounceRate      = Math.round(parseFloat(v(7)) * 100 * 100) / 100       || 0;

  const returningUsers  = Math.max(0, users - newUsers);

  return {
    sessions,
    users,
    newUsers,
    returningUsers,
    engagedSessions,
    engagementRate,
    pagesPerSession,
    avgSessionDuration,
    bounceRate,
  };
}

module.exports = { fetchGoogleAnalyticsData };
