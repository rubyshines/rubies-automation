/**
 * Shared address formatting helpers.
 *
 * Handles the gotchas that cause "null null" to appear in formatted addresses:
 *   - Missing province (e.g. Denmark, UK regions)
 *   - Missing address2
 *   - Missing zip (e.g. Ireland)
 *   - Missing country
 *
 * All inputs are permissive — a null/undefined address returns an empty string
 * or the provided fallback.
 */

function cleanLine(parts, separator = ' ') {
  return parts
    .map(p => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .join(separator);
}

// ---------------------------------------------------------------------------
// Country name -> ISO 3166-1 alpha-2 code
//
// Shopify's OrderInput.shippingAddress.countryCode is a CountryCode enum and
// only accepts two-letter ISO codes ("US", "CA"). The advisor and customers
// routinely supply a full country name ("United States"), which Shopify rejects
// outright (INVALID_VARIABLE). toCountryCode maps any reasonable spelling to the
// ISO code so the address write — and the same/cross-border zone comparison that
// reads countryCodeV2 — both behave.
//
// The base map is derived from Intl.DisplayNames, so every ISO region's
// canonical English name resolves with zero maintenance. ALIASES covers the
// common non-canonical spellings people actually type.
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES = {
  usa: 'US',
  'united states of america': 'US',
  america: 'US',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  holland: 'NL',
  'south korea': 'KR',
  'north korea': 'KP',
  russia: 'RU',
  uae: 'AE',
  'czech republic': 'CZ',
};

// ISO 3166-3 "formerly used" / exceptionally-reserved codes that Intl.DisplayNames
// still resolves to a CURRENT country's name (e.g. UK->"United Kingdom" same as GB,
// DD->"Germany" same as DE). Skipping them keeps the map pointing at the live code.
const DEPRECATED_REGION_CODES = new Set([
  'AN', 'BU', 'CS', 'DD', 'DY', 'FX', 'HV', 'NH',
  'RH', 'SU', 'TP', 'UK', 'VD', 'YD', 'YU', 'ZR',
]);

function normalizeCountryKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

const COUNTRY_NAME_TO_CODE = (() => {
  const map = {};
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let i = 65; i <= 90; i++) {
      for (let j = 65; j <= 90; j++) {
        const code = String.fromCharCode(i, j);
        if (DEPRECATED_REGION_CODES.has(code)) continue;
        let name;
        try { name = display.of(code); } catch { continue; }
        if (!name || name === code) continue; // not a valid ISO region
        // First-wins on duplicate display names so the proper ISO code keeps the
        // name (e.g. "United Kingdom" stays GB; the reserved alias UK doesn't
        // overwrite it because G sorts before U).
        const key = normalizeCountryKey(name);
        if (!(key in map)) map[key] = code;
      }
    }
  } catch { /* Intl unavailable — ALIASES + passthrough still work */ }
  Object.assign(map, COUNTRY_ALIASES); // aliases win over canonical names
  return map;
})();

/**
 * Normalize a country value to its ISO 3166-1 alpha-2 code for Shopify's
 * countryCode enum. Accepts an existing two-letter code (returned upper-cased),
 * a full English country name, or a common alias. Unknown values are returned
 * unchanged so Shopify rejects them loudly rather than silently shipping wrong.
 * null/undefined/empty pass through untouched.
 */
function toCountryCode(value) {
  if (value == null) return value;
  const v = String(value).trim();
  if (!v) return v;
  // Name/alias lookup first so two-letter aliases that aren't ISO codes
  // (e.g. "UK" -> "GB") win over the bare passthrough below.
  const mapped = COUNTRY_NAME_TO_CODE[normalizeCountryKey(v)];
  if (mapped) return mapped;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase(); // assume already an ISO code
  return v; // unknown — let Shopify reject loudly rather than ship wrong
}

/**
 * Format an address as a multi-line block for display.
 *
 *   123 Main St
 *   Apt 4
 *   Portland, OR 97227
 *   United States
 *
 * Province and zip are dropped if null/empty. Country is dropped if null.
 * Returns fallback (default 'No address on file') when address is null/empty.
 */
function formatAddressBlock(a, fallback = 'No address on file') {
  if (!a) return fallback;

  const line1 = cleanLine([a.address1]);
  const line2 = cleanLine([a.address2]);

  // "City, Province Zip" — any component may be missing. The comma is a
  // US/Canada convention tied to the *province*, so we only use it when
  // a province is present. Otherwise city and zip join with a single space.
  const city = cleanLine([a.city]);
  const province = cleanLine([a.province]);
  const zip = cleanLine([a.zip]);
  let cityLine = '';
  if (city && province) {
    cityLine = `${city}, ${cleanLine([province, zip])}`;
  } else if (city) {
    cityLine = cleanLine([city, zip]);
  } else {
    cityLine = cleanLine([province, zip]);
  }

  const countryLine = cleanLine([a.country]);

  const lines = [line1, line2, cityLine, countryLine].filter(Boolean);
  return lines.length ? lines.join('\n') : fallback;
}

/**
 * Format an address on a single line with comma separators.
 * Used in draft previews and order detail summaries.
 */
function formatAddressLine(a, fallback = 'No address') {
  if (!a) return fallback;

  const parts = [];
  if (a.address1) parts.push(String(a.address1).trim());
  if (a.address2) parts.push(String(a.address2).trim());

  const cityRegion = [
    a.city ? String(a.city).trim() : '',
    cleanLine([a.province, a.zip]),
  ].filter(Boolean).join(' ').trim();
  if (cityRegion) parts.push(cityRegion);

  if (a.country) parts.push(String(a.country).trim());

  return parts.length ? parts.join(', ') : fallback;
}

module.exports = { formatAddressBlock, formatAddressLine, toCountryCode };
