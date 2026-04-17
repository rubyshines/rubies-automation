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

module.exports = { formatAddressBlock, formatAddressLine };
