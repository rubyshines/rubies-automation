/**
 * Donation Routing — geographic partner matching for RUBIES returns.
 *
 * Routes returned items to a nearby LGBTQ+ partner org based on customer
 * address (Google Maps geocoding + haversine distance), closest-first:
 * a partner in the same city or metro wins, then one in the same
 * state/province, and only failing both does the box spread across the
 * 3 closest nationally. Every tier picks weighted-random by item volume
 * over a trailing window, so no nearby partner goes dark while a newly
 * added one catches up.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { geocode } = require('./geocoder');
const { shipmentSizeCategories, partnerAcceptsCategories } = require('./sizeAcceptance');

// Trailing window for load balancing. Lifetime counts made every newly added
// partner monopolize its region until it caught up (Montgomery blacked out
// Raleigh for two weeks in June 2026); a window keeps the comparison current.
const LOAD_WINDOW_DAYS = 90;

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
 * Weighted-random pick, weight = 1 / (load + 1). A lightly loaded partner is
 * strongly preferred but never wins outright, so a new partner takes the
 * majority of its region's flow without blacking out established neighbors.
 */
function pickWeightedByLoad(candidates, getLoad, rng = Math.random) {
  const weights = candidates.map(c => 1 / ((getLoad(c) || 0) + 1));
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
 * province holding several partners keeps sharing flow between them.
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
  const nearest = withDistance[0];
  if (nearest && samePlace(nearest.region, place.region)) {
    const inState = withDistance.filter(p => samePlace(p.region, place.region));
    const partner = pickWeightedByLoad(inState, getLoad, rng);
    return { partner, method: `in-state (${partner.region} — ${Math.round(partner.distance_km)} km)` };
  }

  // Tier 3 — national spread across the closest 3.
  if (withDistance.length > 0) {
    const partner = pickWeightedByLoad(withDistance.slice(0, 3), getLoad, rng);
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
      .select('id, name, region, city, address, mailing_address, description, description_short, donations_routed, latitude, longitude, accepts_smaller_sizes, accepts_larger_sizes')
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
  const loads = await fetchRecentPartnerLoads(supabase, partners);
  const getLoad = p => loads.get(p.id) || 0;
  const rng = context._rng || Math.random;

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
    audit: `${itemCount} items → ${partner.name} (${partner.city}, ${country}) — routing: ${routingMethod}, ${getLoad(partner)} items routed in last ${LOAD_WINDOW_DAYS}d${sizeNote}${includeProofAsk ? ', proof ask included' : ''}`,
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

module.exports = { prescribeDonationRouting, geocodeAddress, haversineDistance, logDonationRouting, pickWeightedByLoad, fetchRecentPartnerLoads, selectByProximity, LOCAL_RADIUS_KM, PROOF_ASK_TEXT, PROOF_ASK_TEXT_SINGULAR };
