const https = require('https');

const MAPS_BASE = 'https://maps.googleapis.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapsGet(path) {
  const fetch = new Promise((resolve, reject) => {
    const req = https
      .get(`${MAPS_BASE}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Failed to parse Maps API response: ${data.slice(0, 300)}`));
          }
        });
        res.on('error', reject);
      })
      .on('error', reject);
    req.on('timeout', () => { req.destroy(); });
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Maps API request timed out (15s)')), 15000)
  );
  return Promise.race([fetch, timeout]);
}

async function textSearch(query, apiKey, pageToken = null) {
  let path = `/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
  if (pageToken) path += `&pagetoken=${encodeURIComponent(pageToken)}`;
  return mapsGet(path);
}

async function placeDetails(placeId, apiKey) {
  const fields = 'website,formatted_phone_number';
  const path = `/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(fields)}&key=${encodeURIComponent(apiKey)}`;
  return mapsGet(path);
}

function parseCityState(formattedAddress) {
  if (!formattedAddress) return { city: '', state: '' };

  const parts = formattedAddress.split(',').map((s) => s.trim());

  // Remove trailing country name
  const last = parts[parts.length - 1];
  if (last === 'USA' || last === 'United States' || last === 'Canada' || last === 'United Kingdom') {
    parts.pop();
  }

  if (parts.length < 2) return { city: parts[0] || '', state: '' };

  // Last part: "OR 97201" or just "OR"
  const stateZip = parts[parts.length - 1];
  const stateMatch = stateZip.match(/^([A-Z]{2})(?:\s+\d+)?$/);
  const state = stateMatch ? stateMatch[1] : '';

  // Second-to-last is the city
  const city = parts[parts.length - 2] || '';

  return { city, state };
}

// Fetch all pages (up to 3) for one city + term query.
// Returns an array of raw result objects (no DB operations).
async function searchCityTerm({ term, cityStr, apiKey, verbose = false }) {
  const query = `${term} in ${cityStr}`;
  const results = [];
  let pageToken = null;
  let page = 0;
  const MAX_RATE_LIMIT_RETRIES = 3;

  do {
    // Google requires ≥2s between page requests for next_page_token to activate
    if (page > 0) await sleep(2000);

    if (verbose) process.stdout.write(`  Page ${page + 1}... `);

    let resp;
    let rateLimitRetries = 0;
    // Fetch the page, retrying the SAME page on rate limit. (The old code used
    // `continue` inside the do-while, which exited the loop on page 0 because
    // pageToken was still null — a page-0 rate limit returned zero results and
    // the caller then marked the search permanently complete.)
    while (true) {
      try {
        resp = await textSearch(query, apiKey, pageToken);
      } catch (err) {
        // Transport error: surface it so the caller skips markProgressComplete
        // (the search did NOT finish) and retries on a later run, instead of
        // silently recording an incomplete/empty search as done.
        if (verbose) console.log(`ERROR: ${err.message}`);
        throw err;
      }
      if (resp.status !== 'OVER_QUERY_LIMIT') break;
      if (++rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        throw new Error(`Maps API OVER_QUERY_LIMIT after ${MAX_RATE_LIMIT_RETRIES} retries for "${query}"`);
      }
      if (verbose) console.log(`rate limited — waiting 60s (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})...`);
      await sleep(60000);
    }

    if (resp.status === 'ZERO_RESULTS') {
      if (verbose) console.log('0 results');
      break;
    }

    if (resp.status !== 'OK') {
      throw new Error(
        `Maps API error: ${resp.status}${resp.error_message ? ' — ' + resp.error_message : ''}`
      );
    }

    const pageResults = resp.results || [];
    if (verbose) console.log(`${pageResults.length} results`);

    for (const r of pageResults) {
      const { city, state } = parseCityState(r.formatted_address || '');
      results.push({
        company_name: r.name,
        address: r.formatted_address,
        city,
        state,
        google_place_id: r.place_id,
        types: r.types || [],
        rating: r.rating || null,
        business_status: r.business_status || null,
      });
    }

    pageToken = resp.next_page_token || null;
    page++;
  } while (pageToken && page < 3);

  return results;
}

module.exports = { textSearch, placeDetails, parseCityState, searchCityTerm };
