/**
 * Donation Routing — geographic partner matching for RUBIES returns.
 *
 * Routes returned items to a nearby LGBTQ+ partner org based on customer
 * address (Google Maps geocoding + haversine distance), closest-first:
 * a partner in the same city or metro wins, then one in the same
 * state/province, and only failing both does the box spread across the
 * 3 closest nationally. Every tier picks weighted-random by item volume
 * over a trailing window, so no nearby partner goes dark while a newly
 * added one catches up — and in the two tiers that can span real distance,
 * the pick is pulled back toward the nearest partner so load can never send
 * a box hundreds of kilometres past a closer org.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { geocode } = require('./geocoder');
const { shipmentSizeCategories, partnerAcceptsCategories } = require('./sizeAcceptance');

// Trailing window for load balancing. Lifetime counts made every newly added
// partner monopolize its region until it caught up (Montgomery blacked out
// Raleigh for two weeks in June 2026); a window keeps the comparison current.
const LOAD_WINDOW_DAYS = 90;

// Floor on the window a partner's volume is measured over. A partner added
// three days ago has a three-day sample; projecting it to 90 days turns one
// ordinary box into a career's worth of volume and shuts them off entirely.
// Two weeks is long enough for the projection to mean something at the
// national rate of roughly one partner-routed box a day.
const MIN_EXPOSURE_DAYS = 14;

// How far "same city or nearby city" reaches. 50 km covers a metro and its
// commuter band (Framingham is local to a Boston customer) without stretching
// to the next city over (Kingston is not local to Toronto).
const LOCAL_RADIUS_KM = 50;

// ---------------------------------------------------------------------------
// Geocoding & distance
// ---------------------------------------------------------------------------

/**
 * Geocode a Shopify-shaped address object. Returns lat/lng plus the structured
 * city/region, which come back as Google long names ("Massachusetts",
 * "Ontario") — the same convention partner rows were geocoded under at ingest,
 * so region strings compare cleanly on both sides. Null on any failure:
 * routing then degrades to load balancing rather than erroring.
 */
async function geocodeAddress(address) {
  const parts = [address.address1, address.city, address.province, address.zip, address.country].filter(Boolean);
  try {
    return await geocode(parts.join(', '));
  } catch (e) {
    return null; // no API key, HTTP error, malformed response
  }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Load balancing
// ---------------------------------------------------------------------------

/**
 * Sum items routed per partner over the trailing window, from the
 * `donation_routings` audit log (the source of truth for what was actually
 * sent). Partners with no recent routings simply have no entry (load 0).
 * Falls back to the lifetime `donations_routed` counters if the log can't be
 * read, so routing never hard-fails on a reporting table.
 */
async function fetchRecentPartnerLoads(supabase, partners) {
  try {
    const cutoff = new Date(Date.now() - LOAD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = await fetchAllPaginated(() =>
      supabase
        .from('donation_routings')
        .select('partner_id, items_count')
        .gte('created_at', cutoff)
        .not('partner_id', 'is', null)
        .order('id'));
    const loads = new Map();
    for (const row of rows) {
      loads.set(row.partner_id, (loads.get(row.partner_id) || 0) + (row.items_count || 1));
    }
    return loads;
  } catch (e) {
    return new Map(partners.map(p => [p.id, p.donations_routed || 0]));
  }
}

/**
 * How many days of the trailing window a partner was actually available for.
 * A partner created inside the window has only been eligible for part of it.
 * A missing `created_at` (legacy rows) reads as fully exposed, so nothing is
 * adjusted on a partner whose age we don't know.
 */
function partnerExposureDays(createdAt, now = Date.now()) {
  if (!createdAt) return LOAD_WINDOW_DAYS;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return LOAD_WINDOW_DAYS;
  const ageDays = (now - created) / (24 * 60 * 60 * 1000);
  if (!(ageDays > 0)) return MIN_EXPOSURE_DAYS;
  return Math.min(Math.max(ageDays, MIN_EXPOSURE_DAYS), LOAD_WINDOW_DAYS);
}

/**
 * Raw item counts over a fixed 90-day window compare a new partner's few days
 * against an established one's full quarter, which is the whole reason a new
 * partner ran away with its region: 4 items in 5 days scored as "quieter than
 * everybody" against 29 items in 90. Projecting the young partner's volume up
 * to a full-window equivalent compares rates instead of totals, so a partner
 * that is ALREADY taking more than its share is downweighted on day six rather
 * than in six weeks. A partner older than the window is untouched (factor 1),
 * so this changes nothing for the established network.
 *
 * The projection is self-limiting rather than a special case that has to be
 * switched off later: a brand-new partner still starts at load 0 and takes the
 * next box, and one ordinary box is enough to put it in the normal band.
 */
function exposureAdjustedLoad(items, createdAt, now = Date.now()) {
  const load = items || 0;
  if (!load) return 0;
  return load * (LOAD_WINDOW_DAYS / partnerExposureDays(createdAt, now));
}

/**
 * How much a candidate's distance pulls the pick toward it, relative to the
 * nearest candidate in the same tier: 1 for the nearest, falling off with the
 * SQUARE of how much farther away it is.
 *
 * Squared rather than linear because the penalty should track the extra
 * distance disproportionately. Three partners at comparable distance still
 * share the flow properly (a Chicago box sees Raleigh, Montgomery and Poughkeepsie
 * within 10% of each other, and all three stay in play), while a partner at
 * five times the distance drops to a couple of percent instead of winning
 * outright on load alone.
 */
function proximityBoost(distanceKm, nearestKm) {
  // Floor at 1 km: a customer geocoding to the partner's own coordinates would
  // otherwise divide by zero.
  const ratio = Math.max(nearestKm || 0, 1) / Math.max(distanceKm || 0, 1);
  return ratio * ratio;
}

/**
 * Weighted-random pick, weight = proximity boost / (load + 1). A lightly loaded
 * partner is strongly preferred but never wins outright, so a new partner takes
 * the majority of its region's flow without blacking out established neighbors.
 *
 * `getBoost` defaults to 1 for every candidate, which is the pure load balance
 * used by the local tier (where every candidate is inside the same 50 km metro,
 * and sharing it is the point) and by the country-wide fallback (where no
 * distances exist at all).
 */
function pickWeightedByLoad(candidates, getLoad, rng = Math.random, getBoost = () => 1) {
  const weights = candidates.map(c => (getBoost(c) || 0) / ((getLoad(c) || 0) + 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// Tiered geographic selection
// ---------------------------------------------------------------------------

function samePlace(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pick a partner for a geocoded customer, closest-first:
 *
 *   1. local     — within LOCAL_RADIUS_KM, or an exact city + region match
 *                  (the string match also covers a partner row that has no
 *                  coordinates yet).
 *   2. in-state  — only when the nearest partner overall is ALREADY in the
 *                  customer's state/province. That guard is the point: a bare
 *                  "same state wins" rule would ship a far-northern-California
 *                  box past Oregon down to Los Angeles. This tier never
 *                  overrides distance, it only stops the weighted-random pick
 *                  from crossing a state line when the in-state partner was
 *                  the closest thing anyway. Coordinate-less partners sit this
 *                  tier out (they can't be ranked); they can still win tier 1.
 *   3. regional  — the closest 3 nationally, the long-standing spread rule.
 *
 * Each tier still picks weighted-random by trailing-window load, so a metro or
 * province holding several partners keeps sharing flow between them. Tiers 2
 * and 3 additionally weight by distance (see proximityBoost); tier 1 does not,
 * because everything in it is inside the same 50 km metro and sharing that
 * metro evenly is the point — and a partner matched on city name alone has no
 * distance to weight by.
 *
 * Returns null when no partner has coordinates and no city matches, leaving the
 * caller's country-wide load-balanced pick in place.
 */
function selectByProximity(partners, place, getLoad, rng) {
  const withDistance = partners
    .filter(p => p.latitude && p.longitude)
    .map(p => ({
      ...p,
      distance_km: haversineDistance(place.lat, place.lng, p.latitude, p.longitude),
    }))
    .sort((a, b) => a.distance_km - b.distance_km);

  // Tier 1 — local. Distance-ranked entries go in first so a partner that is
  // both within the radius and an exact city match keeps its distance and is
  // counted once (a duplicate would double its weight in the pick).
  const local = new Map();
  for (const p of withDistance) {
    if (p.distance_km <= LOCAL_RADIUS_KM) local.set(p.id, p);
  }
  for (const p of partners) {
    if (!local.has(p.id) && samePlace(p.city, place.city) && samePlace(p.region, place.region)) {
      local.set(p.id, p);
    }
  }
  if (local.size > 0) {
    const partner = pickWeightedByLoad([...local.values()], getLoad, rng);
    const proximity = partner.distance_km === undefined
      ? 'same city'
      : `${Math.round(partner.distance_km)} km`;
    return { partner, method: `local (${proximity} — ${[partner.city, partner.region].filter(Boolean).join(', ')})` };
  }

  // Tier 2 — same state/province, gated on the nearest partner being in it.
  // Distance-weighted: a state can be a thousand kilometres end to end, so an
  // in-state partner an hour away should beat one at the far end of California.
  const nearest = withDistance[0];
  if (nearest && samePlace(nearest.region, place.region)) {
    const inState = withDistance.filter(p => samePlace(p.region, place.region));
    const boost = p => proximityBoost(p.distance_km, inState[0].distance_km);
    const partner = pickWeightedByLoad(inState, getLoad, rng, boost);
    return { partner, method: `in-state (${partner.region} — ${Math.round(partner.distance_km)} km)` };
  }

  // Tier 3 — national spread across the closest 3, pulled toward the nearest.
  // Load alone used to decide this outright, which made the FARTHEST of the
  // three the likeliest pick whenever it was the quietest: a Maine box went to
  // Poughkeepsie with Boston 220 km closer. Distance now carries real weight
  // here, so load balances between comparable options instead of overriding
  // geography.
  const top3 = withDistance.slice(0, 3);
  if (top3.length > 0) {
    const boost = p => proximityBoost(p.distance_km, top3[0].distance_km);
    const partner = pickWeightedByLoad(top3, getLoad, rng, boost);
    return { partner, method: `geographic (${Math.round(partner.distance_km)} km away)` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main routing function
// ---------------------------------------------------------------------------

// Soft accountability ask appended to partner-routed donation text for
// refund-pattern-flagged refunds (wording locked by Jamie 2026-07-23). The
// refund is never contingent on it — it signals the donation is noticed.
const PROOF_ASK_TEXT = "When you've dropped them off, can you send over a photo with the receipt so I can let the org know to expect the donation?";
const PROOF_ASK_TEXT_SINGULAR = "When you've dropped it off, can you send over a photo with the receipt so I can let the org know to expect the donation?";

async function prescribeDonationRouting(intake, context) {
  const customerRequestedPartner = !!context.customerRequestedPartner;
  // Refund-pattern proof ask: route even single items to a partner org (a
  // local donation has no org to notify, so the ask would be meaningless).
  const includeProofAsk = !!context.includeProofAsk;
  // Skip for defects
  const nonDefectItems = intake.items.filter(i => i.issue !== 'defect');
  if (nonDefectItems.length === 0) {
    return {
      phase: 'donation_routing',
      skip: true,
      reason: 'All items are defects — customer keeps originals',
      audit: 'Skipped: defect items keep original',
    };
  }

  const country = context.customerCountry;
  // Count total UNITS being returned, not just intake entries
  let itemCount = 0;
  const orderLineItems = context.targetOrder?.lineItems || [];
  for (const intakeItem of nonDefectItems) {
    if (intakeItem._orderQty) {
      itemCount += intakeItem._orderQty;
    } else {
      let matchedQty = 0;
      const prodLower = (intakeItem.product || '').toLowerCase();
      for (const oi of orderLineItems) {
        const oiLower = (oi.title || '').toLowerCase();
        const oiSecondWord = oiLower.split(' ')[1];
        if (oiLower.includes(prodLower) || (oiSecondWord && oiSecondWord.length > 1 && prodLower.includes(oiSecondWord))) {
          matchedQty += oi.quantity;
        }
      }
      itemCount += matchedQty || 1;
    }
  }
  if (itemCount === 0) itemCount = nonDefectItems.length;

  if (!country) {
    return {
      phase: 'donation_routing',
      response_text: 'Ask for shipping address to determine donation routing',
      audit: 'Need country for donation routing',
    };
  }

  const supabase = getSupabaseClient();

  let partners = [];
  try {
    const { data } = await supabase
      .from('donation_partners')
      .select('id, name, region, city, address, mailing_address, description, description_short, donations_routed, created_at, latitude, longitude, accepts_smaller_sizes, accepts_larger_sizes')
      .eq('country_code', country)
      .eq('active', true);
    partners = data || [];
  } catch (e) { /* no partners table yet */ }

  // Size eligibility, applied before the proximity tiers rather than inside
  // them: a partner that cannot use these sizes is not a worse match, it is not
  // a match at all, so it should not occupy a local slot and suppress the
  // in-state or national tier behind it. Filtering here means the tiers fall
  // through naturally, and an empty result lands on the existing
  // no-partner-in-country branch below.
  const sizeCategories = shipmentSizeCategories(context.donationSizes);
  const partnersBeforeSizeFilter = partners.length;
  if (sizeCategories.size > 0) {
    partners = partners.filter(p => partnerAcceptsCategories(p, sizeCategories));
  }
  const sizeFilterExcluded = partnersBeforeSizeFilter - partners.length;
  const sizeNote = sizeCategories.size > 0
    ? ` [sizes: ${[...sizeCategories].join('+')}${sizeFilterExcluded ? `, ${sizeFilterExcluded} partner(s) excluded` : ''}]`
    : '';

  const singleItem = itemCount <= 1;

  function formatDonationText(partner, washReminder, proofAsk) {
    // Prefer the canonical mailing_address from the partner registry (multi-line
    // "RUBIES Returns / c/o ..." block published to the website). Fall back to
    // reconstructing from `address` for any legacy row that doesn't have it yet.
    let addressBlock;
    if (partner.mailing_address && partner.mailing_address.trim()) {
      addressBlock = partner.mailing_address.trim();
    } else {
      const addrParts = (partner.address || '').split(',').map(s => s.trim());
      let streetLine, cityLine;
      if (addrParts.length >= 3) {
        streetLine = addrParts[0];
        cityLine = addrParts.slice(1).join(', ');
      } else if (addrParts.length === 2) {
        streetLine = addrParts[0];
        cityLine = addrParts[1];
      } else {
        streetLine = partner.address || '';
        cityLine = '';
      }
      addressBlock = [
        'RUBIES Returns',
        `c/o ${partner.name}`,
        streetLine,
        cityLine,
      ].filter(Boolean).join('\n');
    }

    // Jamie's canonical partner-address wording (matches his sent replies) —
    // fuller than the shared programExplanation used for local-donation cases.
    // Partner routing normally means several items, but a single item lands here
    // too (customer accepted the partner offer, or a flagged refund forced the
    // proof ask), and plural copy reads wrong when they are sending one garment.
    const lines = [
      'We have moved to a model where all RUBIES returns will be donated. We are working with LGBTQ+ organizations that accept donations for distribution in their gender affirming clothing programs.',
      '',
      singleItem
        ? 'With this in mind can you please send the item you are returning to:'
        : 'With this in mind can you please send the items you are returning to:',
      '',
      addressBlock,
      '',
      // Emails use the short 1-2 sentence version; the full org-written
      // description (which can run multiple paragraphs) stays on the website.
      // Both are authored as standalone sentences, so present as written rather
      // than splicing after "They ..." — that produced mangled openings like
      // "They we have bins".
      (partner.description_short || partner.description || '').trim(),
      '',
      washReminder,
      '',
      ...(proofAsk ? [proofAsk, ''] : []),
      'Your return will be greatly appreciated by someone in our community.',
      '',
      'Take care,',
    ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
    return lines.join('\n');
  }

  const programExplanation = 'We have moved to a model where all RUBIES returns will be donated to organizations that run gender-affirming programs.';
  // Both variants keep the worn/tried-on vs new-with-tags distinction — dropping
  // it prompts the customer to ask whether a new item needs washing.
  const washReminder = singleItem
    ? 'Please wash the item if it has been worn or tried on before it is returned. If it is still new with tags it can be sent as is.'
    : 'Please wash any items that have been worn or tried on before they are returned. Anything still new with tags can be sent as is.';

  if (partners.length === 0) {
    return {
      phase: 'donation_routing',
      type: 'local_no_partner',
      response_text: `${programExplanation} Feel free to donate locally. Do you know of any LGBTQ+ organizations in your area we could partner with?`,
      audit: sizeFilterExcluded > 0
        ? `No partner in ${country} can use these sizes${sizeNote} — local donation + ask for org referral`
        : `No partners in ${country} — local donation + ask for org referral`,
    };
  }

  if (itemCount <= 1 && !customerRequestedPartner && !includeProofAsk) {
    return {
      phase: 'donation_routing',
      type: 'local_single',
      response_text: `${programExplanation} Since you only have one item to return, feel free to donate it locally. If you don't have someone or a local org in mind, I can send you the info for one of our partner LGBTQ+ organizations that accept donations for distribution in their gender affirming clothing programs.`,
      audit: `Single item in ${country} — local donation + offered partner org info`,
    };
  }

  // Multiple items — pick geographically (local, then in-state, then the
  // closest 3 nationally), weighted-random by recent item volume within
  // whichever tier fires (trailing window from the donation_routings log, NOT
  // the lifetime counter — see fetchRecentPartnerLoads).
  // Raw items over the window, then scaled for how long each partner has
  // actually been eligible (see exposureAdjustedLoad). The raw figure is kept
  // for the audit line so the number a human reads is still a real item count.
  // On the degraded fallback path inside fetchRecentPartnerLoads the map holds
  // lifetime counters rather than windowed items; scaling those is directionally
  // right (a young partner with lifetime volume is a busy one) and that path
  // only fires when donation_routings cannot be read at all.
  const now = Date.now();
  const loads = await fetchRecentPartnerLoads(supabase, partners);
  const rawLoad = p => loads.get(p.id) || 0;
  const getLoad = p => exposureAdjustedLoad(rawLoad(p), p.created_at, now);
  const rng = context._rng || Math.random;

  // Says so explicitly when a partner was weighed as busier than its raw count,
  // so "2 items and it still lost" is legible in the audit rather than looking
  // like the balancer misfiring.
  const loadNote = (p) => {
    const adjusted = getLoad(p);
    if (Math.round(adjusted) === rawLoad(p)) return '';
    const days = Math.round(partnerExposureDays(p.created_at, now));
    return ` (weighed as ${Math.round(adjusted)} over ${days}d active)`;
  };

  let partner = pickWeightedByLoad(partners, getLoad, rng);
  let routingMethod = 'load_balance';

  const customerAddress = context.customer?.defaultAddress;
  if (customerAddress) {
    try {
      const place = await geocodeAddress(customerAddress);
      if (place) {
        const selected = selectByProximity(partners, place, getLoad, rng);
        if (selected) {
          partner = selected.partner;
          routingMethod = selected.method;
        }
      }
    } catch (e) {
      routingMethod = 'load_balance (geocoding failed)';
    }
  }

  return {
    phase: 'donation_routing',
    type: 'partner',
    partner,
    proof_ask: includeProofAsk,
    response_text: formatDonationText(
      partner,
      washReminder,
      includeProofAsk ? (singleItem ? PROOF_ASK_TEXT_SINGULAR : PROOF_ASK_TEXT) : null,
    ),
    audit: `${itemCount} items → ${partner.name} (${partner.city}, ${country}) — routing: ${routingMethod}, ${rawLoad(partner)} items routed in last ${LOAD_WINDOW_DAYS}d${loadNote(partner)}${sizeNote}${includeProofAsk ? ', proof ask included' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Audit logging — call after a customer reply containing donation info is
// SENT (not just drafted). Inserts an audit row in `donation_routings` and
// increments `donation_partners.donations_routed` for the chosen partner so
// future routings load-balance across the closest 3.
// ---------------------------------------------------------------------------
async function logDonationRouting({ customer_email, order_number, partner_id, items_count, routing_type }) {
  if (!customer_email || !routing_type) {
    throw new Error('logDonationRouting requires customer_email and routing_type');
  }
  const supabase = getSupabaseClient();

  const { error: logErr } = await supabase
    .from('donation_routings')
    .insert({
      customer_email,
      order_number: order_number || null,
      partner_id: partner_id || null,
      items_count: items_count || 1,
      routing_type,
    });
  if (logErr) throw new Error(`Failed to log routing: ${logErr.message}`);

  if (partner_id) {
    const { data: partner } = await supabase
      .from('donation_partners')
      .select('donations_routed')
      .eq('id', partner_id)
      .single();
    if (partner) {
      await supabase
        .from('donation_partners')
        .update({
          donations_routed: (partner.donations_routed || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', partner_id);
    }
  }
}

module.exports = { prescribeDonationRouting, geocodeAddress, haversineDistance, logDonationRouting, pickWeightedByLoad, fetchRecentPartnerLoads, selectByProximity, exposureAdjustedLoad, partnerExposureDays, proximityBoost, LOCAL_RADIUS_KM, LOAD_WINDOW_DAYS, MIN_EXPOSURE_DAYS, PROOF_ASK_TEXT, PROOF_ASK_TEXT_SINGULAR };
