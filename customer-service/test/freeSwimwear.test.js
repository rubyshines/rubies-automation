/**
 * Unit tests for lib/freeSwimwear.js — code generation, acceptance/resend
 * side effects (stubbed Shopify + SendGrid), and the pure lifecycle decision.
 *
 * Run: node --test customer-service/test/freeSwimwear.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// --- Stub shopify + sendgrid BEFORE requiring the module under test ---
const shopifyPath = require.resolve('../lib/shopify');
const sgPath = require.resolve('../../shared/sendgridClient');

const addCodeCalls = [];
const sendCalls = [];
const plainSendCalls = [];
let sendResult = { ok: true, statusCode: 202 }; // mutable so tests can simulate a failed send

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: { addCodeToPriceRule: async (priceRuleId, code) => { addCodeCalls.push({ priceRuleId, code }); return { code }; } },
};
require.cache[sgPath] = {
  id: sgPath, filename: sgPath, loaded: true,
  exports: {
    sendTemplate: async (args) => { sendCalls.push(args); return sendResult; },
    sendEmail: async (args) => { plainSendCalls.push(args); return sendResult; },
  },
};

const fs = require('../lib/freeSwimwear');

describe('generateDiscountCode', () => {
  it('uses FIRSTNAME-<16 alnum upper>', () => {
    assert.match(fs.generateDiscountCode('Sarah Everly'), /^SARAH-[A-Z0-9]{16}$/);
  });
  it('handles empty name', () => {
    assert.match(fs.generateDiscountCode(''), /^-[A-Z0-9]{16}$/);
  });
});

describe('issueAcceptance', () => {
  it('adds a code to the price rule, sends the acceptance template, returns the patch', async () => {
    addCodeCalls.length = 0; sendCalls.length = 0;
    const now = new Date('2026-06-24T12:00:00Z');
    const { code, patch } = await fs.issueAcceptance({ email: 'fam@example.com', applicant_name: 'Sarah Everly' }, now);

    assert.match(code, /^SARAH-/);
    assert.equal(addCodeCalls.length, 1);
    assert.equal(addCodeCalls[0].priceRuleId, fs.PRICE_RULE_ID);
    assert.equal(addCodeCalls[0].code, code);

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].templateId, fs.TEMPLATES.acceptance);
    assert.equal(sendCalls[0].to, 'fam@example.com');
    assert.equal(sendCalls[0].data.discountCode, code);
    assert.equal(sendCalls[0].data.daysLeft, 30);

    assert.equal(patch.status, 'accepted');
    assert.equal(patch.send_attempts, 1);
    assert.equal(patch.discount_code, code);
    assert.equal(patch.expiry_date, new Date('2026-07-24T12:00:00Z').toISOString());
  });

  it('on a successful send, reports emailSent and stamps the send date', async () => {
    sendResult = { ok: true, statusCode: 202 };
    const now = new Date('2026-06-24T12:00:00Z');
    const { patch, emailSent } = await fs.issueAcceptance({ email: 'fam@example.com', applicant_name: 'Sarah' }, now);
    assert.equal(emailSent, true);
    assert.equal(patch.last_acceptance_send_date, now.toISOString());
  });

  it('on a failed send, still issues the code but flags emailSent=false and leaves the send date unset', async () => {
    sendResult = { ok: false, statusCode: 401, error: 'bad key' };
    const now = new Date('2026-06-24T12:00:00Z');
    const { code, patch, emailSent } = await fs.issueAcceptance({ email: 'fam@example.com', applicant_name: 'Sarah' }, now);
    assert.match(code, /^SARAH-/);          // code was still created
    assert.equal(patch.status, 'accepted');
    assert.equal(emailSent, false);
    assert.equal(patch.last_acceptance_send_date, undefined); // not stamped → "not delivered"
    sendResult = { ok: true, statusCode: 202 }; // reset for other tests
  });
});

describe('sendResend', () => {
  it('sends the resend template and bumps the attempt counter', async () => {
    sendCalls.length = 0;
    const now = new Date('2026-06-24T12:00:00Z');
    const { patch } = await fs.sendResend({ email: 'fam@example.com', applicant_name: 'Sarah', discount_code: 'SARAH-X', send_attempts: 1 }, 12, now);
    assert.equal(sendCalls[0].templateId, fs.TEMPLATES.resend);
    assert.equal(sendCalls[0].data.daysLeft, 12);
    assert.equal(patch.send_attempts, 2);
    assert.equal(patch.resend_status, 'recontacted');
  });
});

describe('sendRepeatNotice', () => {
  it('sends a plain reapply email with the reapply date and stamps the send', async () => {
    plainSendCalls.length = 0;
    sendResult = { ok: true, statusCode: 202 };
    const now = new Date('2026-06-28T12:00:00Z');
    const reapplyAfter = '2027-03-01T12:00:00.000Z';
    const { patch, emailSent } = await fs.sendRepeatNotice(
      { email: 'fam@example.com', applicant_name: 'Sarah Everly' }, reapplyAfter, now);

    assert.equal(plainSendCalls.length, 1);
    const sent = plainSendCalls[0];
    assert.equal(sent.to, 'fam@example.com');
    assert.match(sent.text, /Hi Sarah,/);
    assert.match(sent.text, /March 1, 2027/);   // reapply date, program timezone
    assert.doesNotMatch(sent.text, /—/);         // no em dashes in customer copy
    assert.equal(emailSent, true);
    assert.equal(patch.repeat_notice_sent_at, now.toISOString());
  });

  it('does not stamp the send date when SendGrid fails (visible, retryable)', async () => {
    sendResult = { ok: false, statusCode: 500, error: 'boom' };
    const { patch, emailSent } = await fs.sendRepeatNotice(
      { email: 'fam@example.com', applicant_name: 'Sarah' }, '2027-03-01T12:00:00.000Z');
    assert.equal(emailSent, false);
    assert.equal(patch.repeat_notice_sent_at, undefined);
    sendResult = { ok: true, statusCode: 202 }; // reset for other tests
  });
});

describe('decideLifecycle', () => {
  const now = new Date('2026-06-24T12:00:00Z');

  it('accepted + matching customer (no orders) → registered', () => {
    const { action, patch } = fs.decideLifecycle(
      { status: 'accepted' },
      { customer: { id: 555, createdAt: '2026-06-10T00:00:00Z' }, orders: [], now }
    );
    assert.equal(action, 'registered');
    assert.equal(patch.status, 'registered');
    assert.equal(patch.shopify_customer_id, '555');
    assert.equal(patch.registration_date, new Date('2026-06-10T00:00:00Z').toISOString());
  });

  it('registered + customer has an order → ordered, capturing numbers/dates', () => {
    const { action, patch } = fs.decideLifecycle(
      { status: 'registered' },
      { customer: { id: 555 }, orders: [{ name: '#31093', createdAt: '2026-06-20T00:00:00Z' }], now }
    );
    assert.equal(action, 'ordered');
    assert.deepEqual(patch.order_numbers, ['31093']);
    assert.deepEqual(patch.order_dates, ['2026-06-20T00:00:00Z']);
  });

  it('accepted + customer + order in one pass → ordered', () => {
    const { action, patch } = fs.decideLifecycle(
      { status: 'accepted' },
      { customer: { id: 7, createdAt: '2026-06-01T00:00:00Z' }, orders: [{ name: '#900', createdAt: '2026-06-22T00:00:00Z' }], now }
    );
    assert.equal(action, 'ordered');
    assert.equal(patch.shopify_customer_id, '7');
    assert.deepEqual(patch.order_numbers, ['900']);
  });

  it('past expiry, unredeemed → expired', () => {
    const { action, patch } = fs.decideLifecycle(
      { status: 'accepted', expiry_date: '2026-06-20T00:00:00Z' },
      { customer: null, orders: [], now }
    );
    assert.equal(action, 'expired');
    assert.equal(patch.status, 'expired');
  });

  it('within window, last send >= 7d ago, < 3 attempts → resend', () => {
    const { action, patch } = fs.decideLifecycle(
      { status: 'accepted', expiry_date: '2026-07-10T00:00:00Z', last_acceptance_send_date: '2026-06-16T00:00:00Z', send_attempts: 1 },
      { customer: null, orders: [], now }
    );
    assert.equal(action, 'resend');
    assert.ok(patch._daysLeft > 0);
  });

  it('last send too recent → none', () => {
    const { action } = fs.decideLifecycle(
      { status: 'accepted', expiry_date: '2026-07-10T00:00:00Z', last_acceptance_send_date: '2026-06-22T00:00:00Z', send_attempts: 1 },
      { customer: null, orders: [], now }
    );
    assert.equal(action, 'none');
  });

  it('max attempts reached → none', () => {
    const { action } = fs.decideLifecycle(
      { status: 'accepted', expiry_date: '2026-07-10T00:00:00Z', last_acceptance_send_date: '2026-06-01T00:00:00Z', send_attempts: 3 },
      { customer: null, orders: [], now }
    );
    assert.equal(action, 'none');
  });
});
