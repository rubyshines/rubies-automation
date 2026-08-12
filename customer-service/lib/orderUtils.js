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

// Reverse map of English country names → ISO 3166 alpha-2 codes, built once
// via Intl.DisplayNames. The shipping_zones lookup is keyed by 2-letter code,
// so a spelled-out country ("United States") would miss and silently land the
// order on the international (DDU) shipping line — which Warehance routes to
// the international carrier.
const COUNTRY_CODE_ALIASES = { UK: 'GB' };
const COUNTRY_NAME_TO_CODE = (() => {
  const map = {
    'USA': 'US', 'U.S.': 'US', 'U.S.A.': 'US', 'UNITED STATES OF AMERICA': 'US', 'AMERICA': 'US',
    'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB',
    'SOUTH KOREA': 'KR', 'RUSSIA': 'RU', 'VIETNAM': 'VN', 'CZECH REPUBLIC': 'CZ',
  };
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of AZ) {
      for (const b of AZ) {
        const code = a + b;
        let name;
        try { name = dn.of(code); } catch { continue; }
        // Unassigned codes echo back the code itself — skip those.
        if (name && name !== code) map[name.toUpperCase()] = code;
      }
    }
  } catch (_) {
    // Intl unavailable — the manual aliases above still cover the common cases.
  }
  return map;
})();

/**
 * Normalize a country input (ISO alpha-2 code or full English name) to an ISO
 * alpha-2 code. Returns '' when the input is empty or unrecognizable — callers
 * must treat '' as "destination unknown" and surface it in previews, because
 * the shipping title falls back to international.
 */
function normalizeCountryCode(raw) {
  const c = String(raw || '').toUpperCase().trim();
  if (!c) return '';
  if (/^[A-Z]{2}$/.test(c)) return COUNTRY_CODE_ALIASES[c] || c;
  return COUNTRY_NAME_TO_CODE[c] || '';
}

async function getShippingMethodTitle(country, speed) {
  const s = speed === 'expedited' ? 'expedited' : 'standard';
  const c = normalizeCountryCode(country);
  if (!c) return SHIPPING_METHOD_TITLES.ddu[s];

  // Lazy-require to avoid circular import (shippingLookup pulls in the same
  // shopify/supabase clients that some order-creation tools also rely on).
  const { getShippingZone } = require('./tools/shippingLookup');
  const zone = await getShippingZone(c);
  return (SHIPPING_METHOD_TITLES[zone] || SHIPPING_METHOD_TITLES.ddu)[s];
}

/**
 * Normalize an operator-supplied shipping charge into the string Shopify's
 * draft `shippingLine.price` expects. Defaults to free, which is what almost
 * every operator-created order wants — RUBIES covers shipping on exchanges,
 * samples and donations.
 *
 * Anything not a finite, non-negative number (missing, null, junk string, a
 * negative that would REDUCE the order total) collapses to '0.00'. Failing
 * closed to free is safe because both phases of every order tool show the
 * shipping price in the preview, so an operator who meant to charge sees $0.00
 * and can correct it before the invoice goes out.
 */
function normalizeShippingPrice(raw) {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0.00';
  return n.toFixed(2);
}

/**
 * Guard against charging for shipping on a rate whose NAME promises it is free.
 *
 * Every `standard` entry in SHIPPING_METHOD_TITLES has "Free" baked into the
 * title, because that is the literal Shopify rate name Warehance matches on to
 * pick a carrier. Putting a price on one of those lines invoices the customer
 * "Free US Standard Shipping — $24.00", which is self-contradicting on the
 * document they file for expenses. We cannot rename the rate without breaking
 * carrier routing, so the paid case has to ride an expedited title instead.
 *
 * Returns an operator-facing error string, or null when the combination is fine.
 */
function shippingChargeError(shippingTitle, shippingPrice) {
  if (normalizeShippingPrice(shippingPrice) === '0.00') return null;
  if (!/free/i.test(shippingTitle)) return null;
  return `Cannot charge for shipping on the rate "${shippingTitle}" — the rate name itself says Free, ` +
    'so the invoice would contradict itself. Charged shipping belongs on an expedited rate: ' +
    'pass shipping_speed="expedited" alongside shipping_price. If you genuinely need paid standard shipping, ' +
    'that needs a new non-"Free" rate title in Shopify (and the matching Warehance carrier mapping) first.';
}

/**
 * Preview text for a shipping line: names the carrier-routing title and says
 * plainly whether the customer is being charged for it.
 */
function shippingPreviewLine(shippingTitle, shippingPrice) {
  const price = normalizeShippingPrice(shippingPrice);
  return price === '0.00'
    ? `${shippingTitle} ($0.00 — covered by RUBIES)`
    : `${shippingTitle} ($${price} — charged to customer)`;
}

/**
 * Warning line appended to order-creation previews when the destination
 * country couldn't be determined (no address on file, unrecognized country).
 * The shipping title has already defaulted to international at that point,
 * and Warehance routes carriers by title — a US order would ship Passport.
 */
function unknownDestinationWarning(shippingTitle) {
  return `⚠️ **Shipping destination unknown — shipping line defaulted to international ("${shippingTitle}").** ` +
    'If you know where this ships (e.g. a US customer whose checkout failed), pass shipping_address and recreate the draft, ' +
    'or fix it with update_shipping_speed before sending — the warehouse picks the carrier from this title.';
}

module.exports = {
  resolveCustomerForDraft,
  buildShippingAddress,
  applyShippingAddressOverride,
  SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
  getShippingMethodTitle,
  SHIPPING_METHOD_TITLES,
  normalizeCountryCode,
  unknownDestinationWarning,
  normalizeShippingPrice,
  shippingPreviewLine,
  shippingChargeError,
};
