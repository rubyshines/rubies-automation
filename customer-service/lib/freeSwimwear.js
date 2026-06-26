/**
 * Free Swimwear program — core business logic (shared by the MCP tools and the
 * lifecycle job). Faithfully replicates the legacy Apps Script
 * (process-approved-for-free-swimwear.js): issue a unique code under the
 * existing "Free RUBIES Program" price rule, send the SendGrid acceptance
 * email, then poll Shopify to advance accepted → registered → ordered and
 * expire / resend on the 30-day / 7-day / 3-attempt cadence.
 */

const { addCodeToPriceRule } = require('./shopify');
const { sendTemplate } = require('../../shared/sendgridClient');

// The "Free RUBIES Program" price rule (a $X-off code on the rubies-free-donation
// collection, usage limit 1) — owns the definition of what's free. Approved
// families just get a fresh code under it.
const PRICE_RULE_ID = '1577372680470';

// SendGrid dynamic templates (copy lives in SendGrid, reused verbatim).
const TEMPLATES = {
  acceptance: 'd-397594792d9340da976c6eefbe94ab9e', // {firstName, discountCode, daysLeft}
  resend: 'd-14e6618cbe9d4a9ab092426b42545988',     // {firstName, daysLeft, discountCode}
};

const EXPIRY_DAYS = 30;
const RESEND_DAYS = 7;
const MAX_SEND_ATTEMPTS = 3;

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || '';
}

function randomCodeSuffix(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const crypto = require('crypto');
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out.toUpperCase();
}

/** Build a code in the legacy FIRSTNAME-<16 random alnum upper> shape. */
function generateDiscountCode(name) {
  return `${firstName(name).toUpperCase()}-${randomCodeSuffix(16)}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function daysBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Issue acceptance: create a unique code under the price rule and send the
 * acceptance email. Returns the patch to persist on the request row.
 * Side effects only (Shopify + SendGrid); the caller persists the patch.
 *
 * @param {Object} row - a free_swimwear_requests row ({email, applicant_name})
 * @param {Date} [now]
 * @returns {Promise<{patch:Object, code:string}>}
 */
async function issueAcceptance(row, now = new Date()) {
  const code = generateDiscountCode(row.applicant_name);
  await addCodeToPriceRule(PRICE_RULE_ID, code);
  await sendTemplate({
    to: row.email,
    templateId: TEMPLATES.acceptance,
    data: { firstName: firstName(row.applicant_name), discountCode: code, daysLeft: EXPIRY_DAYS },
  });
  return {
    code,
    patch: {
      status: 'accepted',
      discount_code: code,
      expiry_date: addDays(now, EXPIRY_DAYS).toISOString(),
      last_acceptance_send_date: now.toISOString(),
      send_attempts: 1,
      decided_at: now.toISOString(),
    },
  };
}

/**
 * Resend the acceptance email for an unredeemed code. Returns the patch.
 * @param {Object} row
 * @param {number} daysLeft
 * @param {Date} [now]
 */
async function sendResend(row, daysLeft, now = new Date()) {
  await sendTemplate({
    to: row.email,
    templateId: TEMPLATES.resend,
    data: { firstName: firstName(row.applicant_name), discountCode: row.discount_code, daysLeft },
  });
  return {
    patch: {
      send_attempts: (row.send_attempts || 0) + 1,
      last_acceptance_send_date: now.toISOString(),
      resend_status: 'recontacted',
    },
  };
}

/**
 * Pure lifecycle decision for one row, given Shopify lookups + clock.
 * Mirrors the Apps Script: register when a Shopify customer exists for the
 * email, mark ordered when that customer has any order, expire past the
 * window, otherwise flag a resend on the 7-day / <3-attempt cadence.
 *
 * @param {Object} row - request row (status, expiry_date, last_acceptance_send_date, send_attempts)
 * @param {Object} ctx
 * @param {?{id:string, createdAt:string}} ctx.customer - matched Shopify customer, or null
 * @param {Array<{name:string, createdAt:string}>} ctx.orders - that customer's orders
 * @param {Date} ctx.now
 * @returns {{action:string, patch:Object}} action ∈ registered|ordered|expired|resend|none
 */
function decideLifecycle(row, { customer = null, orders = [], now = new Date() } = {}) {
  const patch = {};
  let status = row.status;

  // Registration: an accepted row whose email now has a Shopify customer.
  if (status === 'accepted' && customer) {
    status = 'registered';
    patch.status = 'registered';
    patch.shopify_customer_id = String(customer.id);
    if (customer.createdAt) patch.registration_date = new Date(customer.createdAt).toISOString();
  }

  // Order: a registered row whose customer has placed any order.
  if ((status === 'registered') && orders.length > 0) {
    patch.status = 'ordered';
    patch.order_numbers = orders.map(o => String(o.name || '').replace(/^#/, '')).filter(Boolean);
    patch.order_dates = orders.map(o => o.createdAt).filter(Boolean);
    return { action: 'ordered', patch };
  }

  if (patch.status === 'registered') {
    return { action: 'registered', patch };
  }

  // Expire / resend only apply to still-open accepted/registered rows.
  if (status === 'accepted' || status === 'registered') {
    const expiry = row.expiry_date ? new Date(row.expiry_date) : null;
    const daysLeft = expiry ? daysBetween(expiry, now) : null;
    if (daysLeft !== null && daysLeft <= 0) {
      patch.status = 'expired';
      return { action: 'expired', patch };
    }
    const lastSend = row.last_acceptance_send_date ? new Date(row.last_acceptance_send_date) : null;
    if (daysLeft !== null && daysLeft > 0 && lastSend && (row.send_attempts || 0) < MAX_SEND_ATTEMPTS) {
      if (daysBetween(now, lastSend) >= RESEND_DAYS) {
        return { action: 'resend', patch: { _daysLeft: daysLeft } };
      }
    }
  }

  return { action: 'none', patch };
}

module.exports = {
  PRICE_RULE_ID,
  TEMPLATES,
  EXPIRY_DAYS,
  RESEND_DAYS,
  MAX_SEND_ATTEMPTS,
  firstName,
  generateDiscountCode,
  issueAcceptance,
  sendResend,
  decideLifecycle,
};
