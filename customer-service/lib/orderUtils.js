/**
 * Shared helpers for order creation tools (exchange, invoice, wholesale).
 *
 * Extracts the customer lookup + address resolution code that was duplicated
 * across exchangeOrder.js and wholesaleOrder.js.
 */

const { searchCustomers } = require('./shopify');
const { formatAddressBlock } = require('./addressUtils');

/**
 * Look up a Shopify customer by GID and resolve their name, formatted address,
 * and a shippingAddress object suitable for draft order creation.
 *
 * Returns { customerName, addressBlock, shippingAddress } where shippingAddress
 * is null if the customer has no default address on file.
 *
 * Non-critical — returns defaults on failure so callers can proceed.
 */
async function resolveCustomerForDraft(customerGid) {
  let customerName = customerGid;
  let addressBlock = 'No address on file';
  let shippingAddress = null;
  try {
    const numericId = customerGid.split('/').pop();
    const customers = await searchCustomers(`id:${numericId}`);
    if (customers.length > 0) {
      const c = customers[0];
      customerName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;
      if (c.defaultAddress) {
        shippingAddress = buildShippingAddress(c.defaultAddress, c.firstName, c.lastName);
        addressBlock = formatAddressBlock(c.defaultAddress);
      }
    }
  } catch (_) {
    // Non-critical — continue with defaults
  }
  return { customerName, addressBlock, shippingAddress };
}

/**
 * Convert a Shopify address object into the format expected by DraftOrderInput.shippingAddress.
 */
function buildShippingAddress(a, firstName, lastName) {
  return {
    firstName: firstName || '',
    lastName: lastName || '',
    address1: a.address1,
    address2: a.address2 || '',
    city: a.city,
    province: a.province,
    country: a.countryCodeV2 || a.country,
    zip: a.zip,
  };
}

// FedEx is the carrier of choice for international orders. US orders ship via
// the default US carrier and must never carry a FedEx tag. The DDP/DDU split
// follows the shipping_zones table: Canada and DDP zone (Passport duties
// prepaid) get "ship fedex ddp"; everything else non-US gets "ship fedex ddu".
const US_COUNTRY_VALUES = new Set(['US', 'USA', 'UNITED STATES']);
const CANADA_COUNTRY_VALUES = new Set(['CA', 'CANADA']);

function isUSCountry(country) {
  const c = (country || '').toUpperCase().trim();
  return US_COUNTRY_VALUES.has(c);
}

async function getFedExTag(country) {
  const c = (country || '').toUpperCase().trim();
  if (!c) return null;
  if (US_COUNTRY_VALUES.has(c)) return null;
  if (CANADA_COUNTRY_VALUES.has(c)) return 'ship fedex ddp';

  // Lazy-require to avoid circular import (shippingLookup pulls in the same
  // shopify/supabase clients that some order-creation tools also rely on).
  const { getShippingZone } = require('./tools/shippingLookup');
  const zone = await getShippingZone(c);
  if (zone === 'ddp' || zone === 'canada') return 'ship fedex ddp';
  return 'ship fedex ddu';
}

module.exports = { resolveCustomerForDraft, buildShippingAddress, isUSCountry, getFedExTag };
