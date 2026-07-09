/**
 * Donation Routing — geographic partner matching for RUBIES returns.
 *
 * Routes returned items to the closest LGBTQ+ partner org based on
 * customer address (Google Maps geocoding + haversine distance).
 * Load-balanced among the 3 closest partners by item volume over a
 * trailing window, picked weighted-random so no nearby partner goes
 * dark while a newly added one catches up.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

// Trailing window for load balancing. Lifetime counts made every newly added
// partner monopolize its region until it caught up (Montgomery blacked out
// Raleigh for two weeks in June 2026); a window keeps the comparison current.
const LOAD_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Geocoding & distance
// ---------------------------------------------------------------------------

async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const parts = [address.address1, address.city, address.province, address.zip, address.country].filter(Boolean);
  const query = encodeURIComponent(parts.join(', '));

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${apiKey}`
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.status === 'OK' && data.results.length > 0) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) { /* geocoding failed */ }

  return null;
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
// Main routing function
// ---------------------------------------------------------------------------

async function prescribeDonationRouting(intake, context) {
  const customerRequestedPartner = !!context.customerRequestedPartner;
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
      .select('id, name, region, city, address, mailing_address, description, donations_routed, latitude, longitude')
      .eq('country_code', country)
      .eq('active', true);
    partners = data || [];
  } catch (e) { /* no partners table yet */ }

  function formatDonationText(programExplanation, partner, washReminder) {
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

    const lines = [
      programExplanation,
      '',
      addressBlock,
      '',
      // Partner descriptions are authored as standalone sentences (and some run
      // multiple paragraphs), so present each as written rather than splicing it
      // after "They ..." — that produced mangled openings like "They we have bins".
      (partner.description || '').trim(),
      '',
      washReminder,
      '',
      'Your return will be greatly appreciated by someone in our community.',
      '',
      'Take care,',
    ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
    return lines.join('\n');
  }

  const programExplanation = 'We have moved to a model where all RUBIES returns will be donated to organizations that run gender-affirming programs.';
  const washReminder = 'Please wash any items that have been worn or tried on before donating. Anything still new with tags can be sent as is.';

  if (partners.length === 0) {
    return {
      phase: 'donation_routing',
      type: 'local_no_partner',
      response_text: `${programExplanation} Feel free to donate locally. Do you know of any LGBTQ+ organizations in your area we could partner with?`,
      audit: `No partners in ${country} — local donation + ask for org referral`,
    };
  }

  if (itemCount <= 1 && !customerRequestedPartner) {
    return {
      phase: 'donation_routing',
      type: 'local_single',
      response_text: `${programExplanation} Since you only have one item to return, feel free to donate it locally. If you don't have someone or a local org in mind, I can send you the info for one of our partner LGBTQ+ organizations that accept donations for distribution in their gender affirming clothing programs.`,
      audit: `Single item in ${country} — local donation + offered partner org info`,
    };
  }

  // Multiple items — find the closest partners by geographic proximity, then
  // pick weighted-random by recent item volume (trailing window from the
  // donation_routings log, NOT the lifetime counter — see fetchRecentPartnerLoads).
  const loads = await fetchRecentPartnerLoads(supabase, partners);
  const getLoad = p => loads.get(p.id) || 0;
  const rng = context._rng || Math.random;

  let partner = pickWeightedByLoad(partners, getLoad, rng);
  let routingMethod = 'load_balance';

  const customerAddress = context.customer?.defaultAddress;
  if (customerAddress) {
    try {
      const customerCoords = await geocodeAddress(customerAddress);
      if (customerCoords) {
        const withDistance = partners
          .filter(p => p.latitude && p.longitude)
          .map(p => ({
            ...p,
            distance_km: haversineDistance(customerCoords.lat, customerCoords.lng, p.latitude, p.longitude),
          }))
          .sort((a, b) => a.distance_km - b.distance_km);

        if (withDistance.length > 0) {
          const closest3 = withDistance.slice(0, 3);
          partner = pickWeightedByLoad(closest3, getLoad, rng);
          routingMethod = `geographic (${Math.round(partner.distance_km)} km away)`;
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
    response_text: formatDonationText(programExplanation, partner, washReminder),
    audit: `${itemCount} items → ${partner.name} (${partner.city}, ${country}) — routing: ${routingMethod}, ${getLoad(partner)} items routed in last ${LOAD_WINDOW_DAYS}d`,
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

module.exports = { prescribeDonationRouting, geocodeAddress, haversineDistance, logDonationRouting, pickWeightedByLoad, fetchRecentPartnerLoads };
