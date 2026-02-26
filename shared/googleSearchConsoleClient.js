const { google } = require('googleapis');

async function getSearchConsoleClient() {
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH;

  if (!keyFile) {
    throw new Error('SERVICE_ACCOUNT_KEY_PATH must be set for Google Search Console');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const authClient = await auth.getClient();
  return google.searchconsole({ version: 'v1', auth: authClient });
}

module.exports = {
  getSearchConsoleClient,
};

