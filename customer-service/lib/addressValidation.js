/**
 * Shipping-address validation (Tier 1: geocode plausibility check).
 *
 * Used before auto-applying a customer-requested shipping-address change to an
 * unfulfilled order (see autoExecuteAddressChange in
 * intake/processGorgiasTickets.js). This is a PLAUSIBILITY gate, not a
 * deliverability oracle: it catches gibberish, nonexistent streets/cities,
 * wrong-country mismatches, and incomplete addresses (Google's partial_match).
 * It does NOT catch a real street with a wrong house number — that needs a
 * true address-validation service (USPS CASS / Google Address Validation API).
 *
 * Reuses the Google Geocoding API + GOOGLE_MAPS_API_KEY already wired for
 * donation routing and the store locator (see lib/geocoder.js).
 *
 * Design: the address is VALIDATED here but applied verbatim by the caller — we
 * deliberately do NOT substitute Google's formatted_address, because Google
 * sometimes drops secondary address lines (apartment/unit numbers). We only
 * use the resolved country to confirm same-vs-cross-border routing.
 */

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Build a single-line geocoder query from a structured address.
 * @param {{address1, address2, city, province, zip, country}} addr
 */
function addressToQuery(addr) {
  return [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
    .join(', ');
}

/**
 * Classify a raw Google Geocoding API JSON response into a validation verdict.
 * PURE — unit tested in test/addressValidation.test.js.
 *
 *   { ok: true,  country_code, reason }      → address resolves cleanly; safe to auto-apply
 *   { ok: false, country_code, reason }      → unresolvable / ambiguous; caller must fall back to a hold
 *
 * @param {object} json     Parsed Google Geocoding response ({ status, results }).
 */
function classifyGeocodeResult(json) {
  const status = json?.status;
  if (status === 'ZERO_RESULTS' || !Array.isArray(json?.results) || json.results.length === 0) {
    return { ok: false, country_code: null, reason: 'address did not resolve to a real location' };
  }
  if (status !== 'OK') {
    // OVER_QUERY_LIMIT / REQUEST_DENIED / INVALID_REQUEST / UNKNOWN_ERROR —
    // treat as "could not validate", caller falls back to a hold (fail-safe).
    return { ok: false, country_code: null, reason: `geocoder returned status ${status || 'UNKNOWN'}` };
  }

  const top = json.results[0];
  const countryComp = (top.address_components || []).find((c) => (c.types || []).includes('country'));
  const country_code = countryComp ? (countryComp.short_name || '').toUpperCase() : null;

  if (top.partial_match === true) {
    return { ok: false, country_code, reason: 'address only partially matched (possible typo or incomplete address)' };
  }

  return { ok: true, country_code, reason: 'address resolved' };
}

/**
 * Validate a structured shipping address via the Google Geocoding API.
 * Fail-safe: any missing key / network / API error resolves to { ok: false }
 * so the caller places a protective hold rather than auto-applying blindly.
 *
 * @param {object} addr  { address1, address2, city, province, zip, country }
 * @param {object} [opts.fetchImpl]  injectable fetch for tests
 * @returns {Promise<{ok, country_code, reason}>}
 */
async function validateShippingAddress(addr, opts = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return { ok: false, country_code: null, reason: 'address validation unavailable (no GOOGLE_MAPS_API_KEY)' };
  }
  const query = addressToQuery(addr || {});
  if (!query) {
    return { ok: false, country_code: null, reason: 'no address provided' };
  }

  const doFetch = opts.fetchImpl || fetch;
  try {
    const url = `${GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(query)}&key=${apiKey}`;
    const res = await doFetch(url);
    if (!res.ok) {
      return { ok: false, country_code: null, reason: `geocoder HTTP ${res.status}` };
    }
    const json = await res.json();
    return classifyGeocodeResult(json);
  } catch (e) {
    return { ok: false, country_code: null, reason: `geocoder request failed (${e.message})` };
  }
}

module.exports = { validateShippingAddress, classifyGeocodeResult, addressToQuery };
