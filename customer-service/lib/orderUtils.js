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

/**
 * Merge an operator-supplied shipping_address override (snake_case partial)
 * onto a base DraftOrderInput.shippingAddress object. Override fields take
 * precedence — when an operator passes shipping_address, that's an explicit
 * instruction to ship somewhere other than what's on file. Unspecified fields
 * fall back to the base address.
 *
 * Returns null if both base and override are absent.
 */
function applyShippingAddressOverride(base, override) {
  if (!override) return base || null;
  const merged = { ...(base || {}) };
  if (override.first_name != null) merged.firstName = override.first_name;
  if (override.last_name != null)  merged.lastName  = override.last_name;
  if (override.address1 != null)   merged.address1  = override.address1;
  if (override.address2 != null)   merged.address2  = override.address2 || '';
  if (override.city != null)       merged.city      = override.city;
  if (override.province != null)   merged.province  = override.province;
  if (override.country != null)    merged.country   = override.country;
  if (override.zip != null)        merged.zip       = override.zip;
  return merged;
}

/**
 * JSON Schema fragment for the operator shipping_address override parameter.
 * Reused across create_wholesale_order, create_invoice_order, create_exchange_order.
 */
const SHIPPING_ADDRESS_OVERRIDE_SCHEMA = {
  type: 'object',
  description:
    'Operator override for the shipping address. When provided, takes precedence over the customer default and the previous-order address. Use whenever the customer has explicitly asked to ship to a different address than what is on file (the customer profile may not be updated yet). Provide every field of the new address; partial updates merge onto the base, but for a full address change supply all of address1, city, province, country, zip.',
  properties: {
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    address1: { type: 'string' },
    address2: { type: 'string', description: 'Apartment, suite, unit, etc.' },
    city: { type: 'string' },
    province: { type: 'string' },
    country: { type: 'string', description: 'Two-letter country code (e.g. "AU", "US")' },
    zip: { type: 'string' },
  },
};

// Shopify shipping rate titles per (zone, speed). These match what's configured
// in the Shopify admin; Warehance auto-maps the title to the correct carrier
// (US Standard / US Expedited / Passport DDP / Passport DDU / Fedex). Operator-
// created drafts always set price = $0 (RUBIES covers shipping for free and
// wholesale orders), so the title is the only signal that drives routing.
const SHIPPING_METHOD_TITLES = {
  us:     { standard: 'Free US Standard Shipping',                                       expedited: 'US Expedited Shipping' },
  canada: { standard: 'Free Canada Standard Shipping',                                   expedited: 'Canada Expedited Shipping' },
  ddp:    { standard: 'Free International Shipping - All Duties and Import Fees Included', expedited: 'Expedited International Shipping - All Duties and Import Fees Included' },
  ddu:    { standard: 'Free Standard International Shipping',                             expedited: 'Expedited International Shipping' },
};

async function getShippingMethodTitle(country, speed) {
  const s = speed === 'expedited' ? 'expedited' : 'standard';
  const c = (country || '').toUpperCase().trim();
  if (!c) return SHIPPING_METHOD_TITLES.ddu[s];

  // Lazy-require to avoid circular import (shippingLookup pulls in the same
  // shopify/supabase clients that some order-creation tools also rely on).
  const { getShippingZone } = require('./tools/shippingLookup');
  const zone = await getShippingZone(c);
  return (SHIPPING_METHOD_TITLES[zone] || SHIPPING_METHOD_TITLES.ddu)[s];
}

module.exports = {
  resolveCustomerForDraft,
  buildShippingAddress,
  applyShippingAddressOverride,
  SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
  getShippingMethodTitle,
  SHIPPING_METHOD_TITLES,
};
