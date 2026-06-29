/**
 * Unit tests for the forwarded-from-internal customer resolver in
 * intake/processGorgiasTickets.js.
 *
 * When RUBIES staff forward a customer email to us, Gorgias makes the forwarder the
 * ticket requester. The advisor detects the original external sender; these helpers
 * gate the mechanical redirect that re-points the ticket to the real customer.
 *
 * Run: node --test customer-service/test/forwardedCustomer.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isInternalRubiesAddress, resolveForwardedCustomer } = require('../intake/processGorgiasTickets');

describe('isInternalRubiesAddress', () => {
  it('matches @rubyshines.com addresses (any mailbox, any case, with whitespace)', () => {
    assert.equal(isInternalRubiesAddress('support@rubyshines.com'), true);
    assert.equal(isInternalRubiesAddress('care@rubyshines.com'), true);
    assert.equal(isInternalRubiesAddress('Jamie@RubyShines.com'), true);
    assert.equal(isInternalRubiesAddress('  jamie@rubyshines.com  '), true);
  });

  it('does not match external addresses or non-suffix matches', () => {
    assert.equal(isInternalRubiesAddress('christian.treubert@posteo.de'), false);
    assert.equal(isInternalRubiesAddress('someone@rubyshines.com.evil.com'), false);
    assert.equal(isInternalRubiesAddress('rubyshines.com@gmail.com'), false);
    assert.equal(isInternalRubiesAddress(''), false);
    assert.equal(isInternalRubiesAddress(null), false);
    assert.equal(isInternalRubiesAddress(undefined), false);
  });
});

describe('resolveForwardedCustomer', () => {
  it('redirects when an internal requester forwarded an external customer email', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'support@rubyshines.com',
      forwardedSenderEmail: 'christian.treubert@posteo.de',
      forwardedSenderName: 'Christian',
    });
    assert.deepEqual(r, { redirect: true, email: 'christian.treubert@posteo.de', name: 'Christian' });
  });

  it('trims the originator email and tolerates a null name', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'care@rubyshines.com',
      forwardedSenderEmail: '  jane@example.com  ',
      forwardedSenderName: undefined,
    });
    assert.deepEqual(r, { redirect: true, email: 'jane@example.com', name: null });
  });

  it('does NOT redirect when the requester is a real external customer', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'christian.treubert@posteo.de',
      forwardedSenderEmail: 'someone.else@example.com',
      forwardedSenderName: 'Someone',
    });
    assert.equal(r.redirect, false);
  });

  it('does NOT redirect when the advisor found no forwarded sender', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'support@rubyshines.com',
      forwardedSenderEmail: null,
      forwardedSenderName: null,
    });
    assert.equal(r.redirect, false);
  });

  it('does NOT redirect to another internal address (internal-to-internal forward)', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'care@rubyshines.com',
      forwardedSenderEmail: 'jamie@rubyshines.com',
      forwardedSenderName: 'Jamie',
    });
    assert.equal(r.redirect, false);
  });

  it('does NOT redirect when the forwarded email equals the requester', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'support@rubyshines.com',
      forwardedSenderEmail: 'SUPPORT@rubyshines.com',
      forwardedSenderName: null,
    });
    assert.equal(r.redirect, false);
  });

  it('does NOT redirect when the forwarded sender is not a valid email', () => {
    const r = resolveForwardedCustomer({
      ticketCustomerEmail: 'support@rubyshines.com',
      forwardedSenderEmail: 'not-an-email',
      forwardedSenderName: 'Nope',
    });
    assert.equal(r.redirect, false);
  });
});
