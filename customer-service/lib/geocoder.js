/**
 * Geocoder — Google Maps Geocoding API wrapper.
 *
 * Used by donation partner ingest (survey row → DB) and could be reused
 * anywhere we need to turn a free-form address into structured data.
 *
 * Returns lat/lng plus the structured address components (country_code,
 * region, city) so we don't have to re-derive them from the input string.
 */

/**
 * Strip "RUBIES Returns" and "c/o ..." prefix lines from a multi-line
 * donation partner mailing address, leaving just what Google needs.
 */
function cleanMailingAddress(mailingAddress) {
  return mailingAddress
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^rubies returns/i.test(l) && !/^c\/o\s/i.test(l))
    .join(', ');
}

/**
 * Geocode a free-form address string.
 *
 * `country` (an ISO-3166 alpha-2 code) constrains the search to that country.
 * Pass it whenever the country is known independently of the string being
 * geocoded: free text routinely contains place names that resolve somewhere
 * else entirely. A German org describing where it ships ("Based in Germany;
 * ships worldwide including ... Finland ...") geocoded to Finland, MINNESOTA
 * without it — a confident, plausible, completely wrong answer.
 *
 * @returns {Promise<null | {lat, lng, country_code, region, city, formatted_address}>}
 */
async function geocode(addressString, { country } = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');

  const countryFilter = country ? `&components=country:${encodeURIComponent(country)}` : '';
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressString)}${countryFilter}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google geocode HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || data.results.length === 0) {
    return null;
  }

  const r = data.results[0];
  const components = r.address_components || [];
  const getComp = (type) => {
    const c = components.find(c => c.types.includes(type));
    return c ? c.short_name : null;
  };
  const getCompLong = (type) => {
    const c = components.find(c => c.types.includes(type));
    return c ? c.long_name : null;
  };

  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    country_code: getComp('country'),
    region: getCompLong('administrative_area_level_1'),
    city: getCompLong('locality') || getCompLong('postal_town') || getCompLong('sublocality'),
    formatted_address: r.formatted_address,
  };
}

/**
 * Geocode a multi-line donation partner mailing block (the "RUBIES Returns /
 * c/o ORG / street / city, state / zip" shape).
 */
async function geocodeMailingAddress(mailingAddress) {
  const cleaned = cleanMailingAddress(mailingAddress);
  return geocode(cleaned);
}

module.exports = { geocode, geocodeMailingAddress, cleanMailingAddress };
