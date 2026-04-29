require('dotenv').config();
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

let ga4Client = null;

function getGa4Client() {
  if (ga4Client) return ga4Client;

  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH;

  if (!keyFile) {
    throw new Error('SERVICE_ACCOUNT_KEY_PATH must be set for GA4');
  }

  ga4Client = new BetaAnalyticsDataClient({ keyFile });
  return ga4Client;
}

module.exports = {
  getGa4Client,
};

