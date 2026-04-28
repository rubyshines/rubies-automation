/**
 * Donation Routing — geographic partner matching for RUBIES returns.
 *
 * Routes returned items to the closest LGBTQ+ partner org based on
 * customer address (Google Maps geocoding + haversine distance).
 * Load-balanced among the 3 closest partners.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

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
      .select('id, name, region, city, address, description, donations_routed, latitude, longitude')
      .eq('country_code', country)
      .eq('active', true);
    partners = data || [];
  } catch (e) { /* no partners table yet */ }

  function formatDonationText(programExplanation, partner, washReminder) {
    const addrParts = partner.address.split(',').map(s => s.trim());
    let streetLine, cityLine;
    if (addrParts.length >= 3) {
      streetLine = addrParts[0];
      cityLine = addrParts.slice(1).join(', ');
    } else if (addrParts.length === 2) {
      streetLine = addrParts[0];
      cityLine = addrParts[1];
    } else {
      streetLine = partner.address;
      cityLine = '';
    }

    const addressBlock = [
      'RUBIES Returns',
      `c/o ${partner.name}`,
      streetLine,
      cityLine,
    ].filter(Boolean).join('\n');

    const lines = [
      programExplanation,
      '',
      addressBlock,
      '',
      `They ${partner.description.toLowerCase()} ${washReminder}`,
      '',
      'Your return will be greatly appreciated by someone in our community.',
      '',
      'Take care,',
    ];
    return lines.join('\n');
  }

  const programExplanation = 'We have moved to a model where all RUBIES returns will be donated to organizations that run gender-affirming programs.';
  const washReminder = 'Please wash any items that have been worn or tried on before donating.';

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

  // Multiple items — find closest partner by geographic proximity
  let partner = partners[0];
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
          partner = closest3.sort((a, b) => a.donations_routed - b.donations_routed)[0];
          routingMethod = `geographic (${Math.round(partner.distance_km)} km away)`;
        }
      }
    } catch (e) {
      partner = partners.sort((a, b) => a.donations_routed - b.donations_routed)[0];
      routingMethod = 'load_balance (geocoding failed)';
    }
  }

  return {
    phase: 'donation_routing',
    type: 'partner',
    partner,
    response_text: formatDonationText(programExplanation, partner, washReminder),
    audit: `${itemCount} items → ${partner.name} (${partner.city}, ${country}) — routing: ${routingMethod}, ${partner.donations_routed} previous donations`,
  };
}

module.exports = { prescribeDonationRouting, geocodeAddress, haversineDistance };
