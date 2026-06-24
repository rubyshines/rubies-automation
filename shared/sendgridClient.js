require('dotenv').config();

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

/**
 * Send a SendGrid dynamic-template email from RUBIES (jamie@rubyshines.com).
 * Thin wrapper so callers don't reassemble the from/personalizations envelope.
 *
 * @param {Object} opts
 * @param {string} opts.to - recipient email
 * @param {string} opts.templateId - SendGrid dynamic template id (d-...)
 * @param {Object} [opts.data] - dynamic_template_data for the template
 * @param {string} [opts.fromName='RUBIES']
 * @param {string} [opts.fromEmail='jamie@rubyshines.com']
 * @returns {Promise<boolean>} true if sent; false if SendGrid isn't configured
 */
async function sendTemplate({ to, templateId, data = {}, fromName = 'RUBIES', fromEmail = 'jamie@rubyshines.com' }) {
  const sgMail = getSendgridClient();
  if (!sgMail) return false;
  await sgMail.send({
    to,
    from: { email: fromEmail, name: fromName },
    templateId,
    dynamicTemplateData: data,
  });
  return true;
}

module.exports = {
  getSendgridClient,
  sendTemplate,
};

