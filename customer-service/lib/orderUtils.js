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

module.exports = { resolveCustomerForDraft, buildShippingAddress };
