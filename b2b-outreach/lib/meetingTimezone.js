/**
 * meetingTimezone.js — resolve the other party's timezone WITHOUT asking a model.
 *
 * Deliberately deterministic. What the model does (in proposedTimes.js) is read
 * a timezone the human actually STATED. This file is only the fallback for when
 * nobody said one, and it is a table lookup because a wrong answer here lands
 * verbatim in a customer-facing sentence ("Tuesday 4pm Eastern, 1pm your time").
 *
 * The rule the B2B domain keeps relearning applies: no match means NO FACTS,
 * not a guess. A multi-zone country with no region resolves to null, and the
 * panel then says "unknown, please set" rather than inventing an offset.
 *
 * Multi-zone STATES are handled differently from multi-zone countries: they
 * return the majority zone with `split: true`, because "Florida" is Eastern for
 * all but the western panhandle and refusing to answer would be unhelpful. The
 * caller is expected to surface `split` so the operator can correct it.
 */

/** US states / territories → IANA zone. `true` in SPLIT means multi-zone. */
const US_STATES = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix',
  AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York',
  LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver',
  NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago',
  TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
  PR: 'America/Puerto_Rico',
};
const US_SPLIT = new Set(['FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'NE', 'ND', 'OR', 'SD', 'TN', 'TX', 'AK']);

const US_STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};

const CA_PROVINCES = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina',
  MB: 'America/Winnipeg', ON: 'America/Toronto', QC: 'America/Toronto',
  NB: 'America/Halifax', NS: 'America/Halifax', PE: 'America/Halifax',
  NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife',
  NU: 'America/Iqaluit',
};
const CA_SPLIT = new Set(['BC', 'ON', 'NU', 'NL']);

const CA_PROVINCE_NAMES = {
  'british columbia': 'BC', alberta: 'AB', saskatchewan: 'SK', manitoba: 'MB',
  ontario: 'ON', quebec: 'QC', 'québec': 'QC', 'new brunswick': 'NB',
  'nova scotia': 'NS', 'prince edward island': 'PE',
  'newfoundland and labrador': 'NL', newfoundland: 'NL', yukon: 'YT',
  'northwest territories': 'NT', nunavut: 'NU',
};

const AU_STATES = {
  NSW: 'Australia/Sydney', VIC: 'Australia/Melbourne', ACT: 'Australia/Sydney',
  TAS: 'Australia/Hobart', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide',
  NT: 'Australia/Darwin', WA: 'Australia/Perth',
};
const AU_STATE_NAMES = {
  'new south wales': 'NSW', victoria: 'VIC', 'australian capital territory': 'ACT',
  tasmania: 'TAS', queensland: 'QLD', 'south australia': 'SA',
  'northern territory': 'NT', 'western australia': 'WA',
};

/** Countries with ONE practical business zone. */
const SINGLE_ZONE_COUNTRIES = {
  GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris',
  DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels',
  LU: 'Europe/Luxembourg', IT: 'Europe/Rome', AT: 'Europe/Vienna',
  CH: 'Europe/Zurich', SE: 'Europe/Stockholm', NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', IS: 'Atlantic/Reykjavik',
  PL: 'Europe/Warsaw', CZ: 'Europe/Prague', SK: 'Europe/Bratislava',
  HU: 'Europe/Budapest', RO: 'Europe/Bucharest', BG: 'Europe/Sofia',
  GR: 'Europe/Athens', HR: 'Europe/Zagreb', SI: 'Europe/Ljubljana',
  RS: 'Europe/Belgrade', EE: 'Europe/Tallinn', LV: 'Europe/Riga',
  LT: 'Europe/Vilnius', UA: 'Europe/Kyiv', TR: 'Europe/Istanbul',
  IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata', SG: 'Asia/Singapore',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh',
  PH: 'Asia/Manila', MY: 'Asia/Kuala_Lumpur', AE: 'Asia/Dubai',
  ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi', NG: 'Africa/Lagos',
  EG: 'Africa/Cairo', MA: 'Africa/Casablanca', NZ: 'Pacific/Auckland',
  AR: 'America/Argentina/Buenos_Aires', PE: 'America/Lima',
  CO: 'America/Bogota', UY: 'America/Montevideo', CL: 'America/Santiago',
  JM: 'America/Jamaica', CR: 'America/Costa_Rica', PA: 'America/Panama',
};

/** Multi-zone countries: a region is REQUIRED, otherwise we answer nothing. */
const MULTI_ZONE_COUNTRIES = new Set(['US', 'CA', 'AU', 'RU', 'BR', 'MX', 'ID', 'KZ', 'CD', 'CN', 'ES', 'PT', 'EC', 'PF', 'GL']);

const COUNTRY_NAMES = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US',
  'u.s.a.': 'US', america: 'US',
  canada: 'CA',
  australia: 'AU',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB',
  scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  ireland: 'IE', france: 'FR', germany: 'DE', deutschland: 'DE',
  netherlands: 'NL', holland: 'NL', belgium: 'BE', luxembourg: 'LU',
  italy: 'IT', austria: 'AT', switzerland: 'CH', sweden: 'SE',
  norway: 'NO', denmark: 'DK', finland: 'FI', iceland: 'IS',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', slovakia: 'SK',
  hungary: 'HU', romania: 'RO', bulgaria: 'BG', greece: 'GR',
  croatia: 'HR', slovenia: 'SI', serbia: 'RS', estonia: 'EE',
  latvia: 'LV', lithuania: 'LT', ukraine: 'UA', turkey: 'TR',
  israel: 'IL', india: 'IN', singapore: 'SG', japan: 'JP',
  'south korea': 'KR', korea: 'KR', 'hong kong': 'HK', taiwan: 'TW',
  thailand: 'TH', vietnam: 'VN', philippines: 'PH', malaysia: 'MY',
  'united arab emirates': 'AE', uae: 'AE', 'south africa': 'ZA',
  kenya: 'KE', nigeria: 'NG', egypt: 'EG', morocco: 'MA',
  'new zealand': 'NZ', argentina: 'AR', peru: 'PE', colombia: 'CO',
  uruguay: 'UY', chile: 'CL', jamaica: 'JM', 'costa rica': 'CR',
  panama: 'PA', brazil: 'BR', mexico: 'MX', spain: 'ES', portugal: 'PT',
  china: 'CN', russia: 'RU', indonesia: 'ID',
};

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.]/g, '');
}

/** Free text → ISO country code, or null. Pure. */
function normalizeCountry(country) {
  const c = norm(country);
  if (!c) return null;
  if (/^[a-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRY_NAMES[c] || null;
}

/** Free text → a region key for the given country, or null. Pure. */
function normalizeRegion(region, countryCode) {
  const r = norm(region);
  if (!r) return null;
  if (countryCode === 'US') {
    if (/^[a-z]{2}$/.test(r) && US_STATES[r.toUpperCase()]) return r.toUpperCase();
    return US_STATE_NAMES[r] || null;
  }
  if (countryCode === 'CA') {
    if (/^[a-z]{2}$/.test(r) && CA_PROVINCES[r.toUpperCase()]) return r.toUpperCase();
    return CA_PROVINCE_NAMES[r] || null;
  }
  if (countryCode === 'AU') {
    const up = r.toUpperCase().replace(/ /g, '');
    if (AU_STATES[up]) return up;
    return AU_STATE_NAMES[r] || null;
  }
  return null;
}

/**
 * Resolve a company's location to an IANA timezone.
 *
 * @param {object} loc { city, region, country, address }
 * @returns {{ timeZone: string|null, source: string, split: boolean, reason: string|null }}
 *
 * `source` is what the panel shows the operator so an inference is never
 * mistaken for something the other party actually told us.
 */
function timezoneFromLocation({ region, country, address } = {}) {
  const countryCode = normalizeCountry(country);

  // A region can be readable even when the country field is empty — the imports
  // left plenty of half-filled rows. Try US/CA/AU region tables directly.
  if (!countryCode) {
    for (const [code, table] of [['US', US_STATES], ['CA', CA_PROVINCES], ['AU', AU_STATES]]) {
      const key = normalizeRegion(region, code);
      if (key && table[key]) {
        const split = (code === 'US' && US_SPLIT.has(key)) || (code === 'CA' && CA_SPLIT.has(key));
        return {
          timeZone: table[key],
          source: `inferred from ${region}`,
          split,
          reason: split ? `${region} spans more than one timezone — worth confirming` : null,
        };
      }
    }
    return { timeZone: null, source: 'unknown', split: false, reason: 'No country or recognisable region on the company record' };
  }

  if (countryCode === 'US' || countryCode === 'CA' || countryCode === 'AU') {
    const table = countryCode === 'US' ? US_STATES : countryCode === 'CA' ? CA_PROVINCES : AU_STATES;
    const splitSet = countryCode === 'US' ? US_SPLIT : countryCode === 'CA' ? CA_SPLIT : new Set();
    const key = normalizeRegion(region, countryCode);
    if (key && table[key]) {
      const split = splitSet.has(key);
      const where = [region, country].filter(Boolean).join(', ');
      return {
        timeZone: table[key],
        source: `inferred from ${where}`,
        split,
        reason: split ? `${region} spans more than one timezone — worth confirming` : null,
      };
    }
    // Multi-zone country, no usable region: answer nothing rather than guess.
    return {
      timeZone: null,
      source: 'unknown',
      split: false,
      reason: `${country} spans several timezones and the company record has no usable region`
        + (address ? ' (there is a street address on file — setting region would fix this)' : ''),
    };
  }

  if (MULTI_ZONE_COUNTRIES.has(countryCode)) {
    return {
      timeZone: null,
      source: 'unknown',
      split: false,
      reason: `${country} spans several timezones and we have no region mapping for it`,
    };
  }

  if (SINGLE_ZONE_COUNTRIES[countryCode]) {
    return {
      timeZone: SINGLE_ZONE_COUNTRIES[countryCode],
      source: `inferred from ${country}`,
      split: false,
      reason: null,
    };
  }

  return { timeZone: null, source: 'unknown', split: false, reason: `No timezone mapping for ${country}` };
}

/** Is this a timezone Intl actually understands? Guards operator-typed values. Pure. */
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** "America/Los_Angeles" → "Pacific Time" style short label for a human. Pure. */
function timeZoneLabel(tz, at = new Date()) {
  if (!isValidTimeZone(tz)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(at);
  const name = parts.find(p => p.type === 'timeZoneName');
  return name ? name.value : tz;
}

module.exports = {
  timezoneFromLocation,
  normalizeCountry,
  normalizeRegion,
  isValidTimeZone,
  timeZoneLabel,
  US_STATES,
  CA_PROVINCES,
  AU_STATES,
  SINGLE_ZONE_COUNTRIES,
  MULTI_ZONE_COUNTRIES,
};
