const { google } = require('googleapis');

async function getSheetsClient() {
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH;

  if (!keyFile) {
    throw new Error('SERVICE_ACCOUNT_KEY_PATH must be set for Google Sheets');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

module.exports = {
  getSheetsClient,
};

