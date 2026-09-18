'use strict';
/**
 * Requesters become store customers once their email is confirmed: a Shopify
 * customer with the name they go by (never a legal name, no last name), tagged
 * with the programme and their centre. Newsletter only when they ticked the box.
 */
const { logEvent } = require('./db');

async function registerRequester({ centre, request, newsletter = false }) {
  const shopify = require('../../customer-service/lib/shopify');
  const tags = ['virtual-closet', `closet:${centre.slug}`];
  let customer = null;
  try {
    const found = await shopify.searchCustomers(`email:${request.email}`);
    customer = (found || []).find(c => (c.email || '').toLowerCase() === request.email) || null;
  } catch (err) { console.warn(`[vc] customer search failed: ${err.message}`); }
  try {
    if (customer) {
      const merged = Array.from(new Set([...(customer.tags || []), ...tags]));
      await shopify.updateCustomer(customer.id, { tags: merged, ...(newsletter ? marketingConsent() : {}) });
    } else {
      customer = await shopify.createCustomer({ email: request.email, firstName: request.name, tags, ...(newsletter ? marketingConsent() : {}) });
    }
  } catch (err) { console.warn(`[vc] customer upsert failed: ${err.message}`); }

  if (newsletter) {
    try {
      const { getKlaviyoClient } = require('../../shared/klaviyoClient');
      const client = getKlaviyoClient();
      if (client) await client.updateSubscription(request.email, { action: 'subscribe', channels: ['email'] });
    } catch (err) { console.warn(`[vc] klaviyo subscribe failed: ${err.message}`); }
  }
  await logEvent(centre.id, 'system', 'requester.registered', { request_id: request.id, newsletter, customer: customer?.id || null });
  return customer;
}

function marketingConsent() {
  return { emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date().toISOString() } };
}

module.exports = { registerRequester };
