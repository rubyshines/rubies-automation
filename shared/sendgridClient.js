let sgMailClient = null;

function getSendgridClient() {
  if (sgMailClient) return sgMailClient;

  let sgMail;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    sgMail = require('@sendgrid/mail');
  } catch (err) {
    return null;
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    return null;
  }

  sgMail.setApiKey(apiKey);
  sgMailClient = sgMail;
  return sgMailClient;
}

module.exports = {
  getSendgridClient,
};

