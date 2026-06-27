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
 * @param {string} [opts.fromEmail='care@rubyshines.com'] - any @rubyshines.com
 *   address works (the domain is authenticated in SendGrid). Replies route here.
 * @returns {Promise<{ok:boolean, statusCode:?number, error?:string}>}
 *   ok=true only when SendGrid accepts the message (2xx, normally 202). Never
 *   throws — callers record the outcome so a failed send is visible, not silent.
 */
async function sendTemplate({ to, templateId, data = {}, fromName = 'RUBIES', fromEmail = 'care@rubyshines.com' }) {
  const sgMail = getSendgridClient();
  if (!sgMail) return { ok: false, statusCode: null, error: 'SendGrid not configured (SENDGRID_API_KEY missing)' };
  try {
    const [resp] = await sgMail.send({
      to,
      from: { email: fromEmail, name: fromName },
      templateId,
      dynamicTemplateData: data,
    });
    const statusCode = resp?.statusCode ?? null;
    return { ok: statusCode >= 200 && statusCode < 300, statusCode };
  } catch (err) {
    const detail = err?.response?.body ? JSON.stringify(err.response.body).slice(0, 300) : err.message;
    return { ok: false, statusCode: err?.code ?? null, error: detail };
  }
}

module.exports = {
  getSendgridClient,
  sendTemplate,
};

