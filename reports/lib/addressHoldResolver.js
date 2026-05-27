/**
 * Address Hold Auto-Resolver
 *
 * Attempts to auto-resolve Warehance address holds using two rules:
 *   1. Previous fulfilled order to the same address → release hold
 *   2. Street View + Claude Vision classification → release if residential
 *
 * Returns results for each held order so the report can show what happened.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { releaseAddressHold } = require('./warehanceClient');

let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic();
  return _ai;
}

// ---------------------------------------------------------------------------
// Rule 1: Previous fulfilled order to same address
// ---------------------------------------------------------------------------

async function checkPreviousFulfilledOrder(supabase, customerEmail, shippingAddress) {
  if (!customerEmail || !shippingAddress?.address1) return null;

  const { data, error } = await supabase
    .from('orders')
    .select('order_number, shipping_address, fulfilled_at')
    .eq('customer_email', customerEmail)
    .eq('fulfillment_status', 'FULFILLED')
    .is('cancelled_at', null)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data?.length) return null;

  const normalizeAddr = (a) => (a || '').trim().toLowerCase().replace(/[.,#]/g, '');
  const normalizeZip = (z) => (z || '').trim().toLowerCase().replace(/\s+/g, '');

  const targetAddr = normalizeAddr(shippingAddress.address1);
  const targetZip = normalizeZip(shippingAddress.zip);

  for (const order of data) {
    const addr = order.shipping_address;
    if (!addr) continue;
    if (normalizeAddr(addr.address1) === targetAddr && normalizeZip(addr.zip) === targetZip) {
      return {
        matched: true,
        previousOrderNumber: order.order_number,
        fulfilledAt: order.fulfilled_at,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule 1b: Google Geocoding validation + address cleanup
// ---------------------------------------------------------------------------

async function geocodeAddress(shippingAddress) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  // Clean address1: strip city/state/zip if customer stuffed them in the street field
  let cleanAddr1 = shippingAddress.address1 || '';
  const city = (shippingAddress.city || '').trim();
  if (city) {
    // Remove city name from end of address1 (case-insensitive)
    const cityPattern = new RegExp(`[,\\s]+${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    cleanAddr1 = cleanAddr1.replace(cityPattern, '').trim();
  }

  // Combine address1 + unit as a single line for better geocoding
  const unit = (shippingAddress.address2 || '').trim();
  let streetLine = cleanAddr1;
  if (unit) {
    // If unit already has a prefix (Apt, Suite, Unit, #), use as-is; otherwise add #
    const hasPrefix = /^(apt|suite|ste|unit|#)/i.test(unit);
    streetLine = hasPrefix ? `${cleanAddr1} ${unit}` : `${cleanAddr1} #${unit}`;
  }

  const parts = [
    streetLine,
    city,
    shippingAddress.provinceCode || shippingAddress.province,
    shippingAddress.zip,
    shippingAddress.countryCode || shippingAddress.country,
  ].filter(Boolean);

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(parts.join(', '))}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.results?.[0];
    if (!result) return null;

    const comp = (type) => result.address_components?.find(c => c.types.includes(type));

    return {
      formatted: result.formatted_address,
      locationType: result.geometry?.location_type,
      partialMatch: result.partial_match || false,
      streetNumber: comp('street_number')?.long_name || null,
      route: comp('route')?.short_name || null,
      subpremise: comp('subpremise')?.long_name || null,
      city: comp('locality')?.long_name || comp('sublocality')?.long_name || null,
      province: comp('administrative_area_level_1')?.short_name || null,
      zip: comp('postal_code')?.long_name || null,
      country: comp('country')?.short_name || null,
    };
  } catch {
    return null;
  }
}

/**
 * Validate address via geocoding. Returns cleaned address fields if safe to update,
 * or null if the address can't be confidently resolved.
 *
 * Safety checks:
 * - Must be ROOFTOP precision (exact building match)
 * - Must not be a partial match
 * - Zip code must not change (signals a different location)
 * - If original has address2, Google must return a matching subpremise
 */
function validateGeocodedAddress(original, geocoded) {
  if (!geocoded) return null;
  if (geocoded.locationType !== 'ROOFTOP') return null;
  if (geocoded.partialMatch) return null;

  // Zip must not change
  const origZip = (original.zip || '').trim().replace(/\s+/g, '');
  const geoZip = (geocoded.zip || '').trim().replace(/\s+/g, '');
  if (!geoZip || origZip.toLowerCase() !== geoZip.toLowerCase()) return null;

  // If original has address2, Google must account for it as subpremise
  const origAddr2 = (original.address2 || '').trim();
  if (origAddr2 && !geocoded.subpremise) return null;

  // Build cleaned address
  const streetNumber = geocoded.streetNumber || '';
  const route = geocoded.route || '';
  const address1 = `${streetNumber} ${route}`.trim();
  if (!address1) return null;

  return {
    address1,
    address2: geocoded.subpremise ? `#${geocoded.subpremise}` : (origAddr2 || null),
    city: geocoded.city || original.city,
    province: geocoded.province || original.provinceCode || original.province,
    zip: geocoded.zip || original.zip,
  };
}

// ---------------------------------------------------------------------------
// Rule 2: Street View + Claude Vision
// ---------------------------------------------------------------------------

async function fetchStreetViewImage(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const parts = [address.address1, address.city, address.province, address.zip, address.country].filter(Boolean);
  const location = encodeURIComponent(parts.join(', '));

  const url = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${location}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    // Street View returns a grey "no image" placeholder if no coverage.
    // Check content-type is image and size is reasonable.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const buffer = Buffer.from(await res.arrayBuffer());

    // The "no imagery" placeholder is typically small (~8KB). Real images are 20KB+.
    if (buffer.length < 15000) return null;

    return buffer;
  } catch {
    return null;
  }
}

async function classifyAddressImage(imageBuffer, addressStr) {
  try {
    const response = await callClaude({
      component: 'address_hold_resolver',
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `This is a Google Street View image of the address: ${addressStr}

Our shipping warehouse flagged this address for review. I need to determine if this is a deliverable residential address.

Classify this as one of:
- RESIDENTIAL: A house, apartment building, townhouse, duplex, condo, or any building where people live. Includes small multi-unit buildings that look like large houses.
- COMMERCIAL: A large commercial building, warehouse, office tower, or industrial facility that is clearly NOT residential.
- UNCERTAIN: Cannot determine (empty lot, construction site, obscured view, or genuinely ambiguous).

Respond with ONLY one word: RESIDENTIAL, COMMERCIAL, or UNCERTAIN.`,
          },
        ],
      }],
    });

    const text = response.content?.[0]?.text?.trim().toUpperCase() || '';
    if (text.includes('RESIDENTIAL')) return 'RESIDENTIAL';
    if (text.includes('COMMERCIAL')) return 'COMMERCIAL';
    return 'UNCERTAIN';
  } catch (err) {
    console.warn(`  Claude Vision error: ${err.message}`);
    return 'UNCERTAIN';
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-resolve address holds.
 *
 * @param {object} supabase - Supabase client
 * @param {Array} heldOrders - Orders with address_hold from the report results
 * @param {Map} whOrdersMap - Warehance orders map (order_number string → whOrder)
 * @returns {Array} Results: [{ orderNumber, autoResolved, reason, rule, classification }]
 */
async function resolveAddressHolds(supabase, heldOrders, whOrdersMap) {
  const results = [];

  for (const r of heldOrders) {
    const order = r.order;
    const whOrder = whOrdersMap.get(String(order.order_number));
    const result = {
      orderNumber: order.order_number,
      autoResolved: false,
      reason: null,
      rule: null,
      classification: null,
    };

    // Rule 1: Previous fulfilled order to same address
    console.log(`  Checking #${order.order_number} — Rule 1 (previous order)...`);
    const prevMatch = await checkPreviousFulfilledOrder(
      supabase,
      order.customer_email,
      order.shipping_address,
    );

    if (prevMatch?.matched) {
      result.autoResolved = true;
      result.rule = 'previous_order';
      result.reason = `Previous order #${prevMatch.previousOrderNumber} fulfilled to same address`;

      if (whOrder?.id) {
        try {
          await releaseAddressHold(whOrder.id);
          console.log(`  ✓ Released hold on #${order.order_number} (previous order match)`);
        } catch (err) {
          console.warn(`  Failed to release hold: ${err.message}`);
          result.autoResolved = false;
          result.reason = `Match found but hold release failed: ${err.message}`;
        }
      }

      // Log note
      if (result.autoResolved) {
        await supabase.from('order_alert_notes').insert({
          order_number: order.order_number,
          note: `Auto-resolved: ${result.reason}`,
          resolved: false, // Keep visible for review
          author: 'auto',
          alert_type: 'unfulfilled',
        });
      }

      results.push(result);
      continue;
    }

    // Rule 2: Google Geocoding validation + address cleanup
    console.log(`  Checking #${order.order_number} — Rule 2 (Geocoding)...`);
    const addr = order.shipping_address;
    if (addr) {
      const geocoded = await geocodeAddress(addr);
      const cleaned = validateGeocodedAddress(addr, geocoded);

      if (cleaned) {
        result.autoResolved = true;
        result.rule = 'geocoding_validated';

        // Build diff description
        const changes = [];
        if (cleaned.address1 !== addr.address1) changes.push(`address1: "${addr.address1}" → "${cleaned.address1}"`);
        if ((cleaned.address2 || '') !== (addr.address2 || '')) changes.push(`address2: "${addr.address2 || ''}" → "${cleaned.address2 || ''}"`);
        if (cleaned.city !== addr.city) changes.push(`city: "${addr.city}" → "${cleaned.city}"`);
        const changeDesc = changes.length ? ` (fixed: ${changes.join(', ')})` : '';
        result.reason = `Geocoding validated as ROOFTOP precision, zip unchanged${changeDesc}`;

        // Update Shopify shipping address if formatting changed
        if (changes.length && order.shopify_order_id) {
          try {
            const { updateOrderShippingAddress } = require('../../customer-service/lib/shopify');
            const shopifyGid = order.shopify_order_id.includes('gid://')
              ? order.shopify_order_id
              : `gid://shopify/Order/${order.shopify_order_id}`;
            await updateOrderShippingAddress(shopifyGid, {
              address1: cleaned.address1,
              address2: cleaned.address2 || undefined,
              city: cleaned.city,
              provinceCode: cleaned.province,
              zip: cleaned.zip,
            });
            console.log(`  ✓ Updated Shopify address for #${order.order_number}${changeDesc}`);
          } catch (err) {
            console.warn(`  Shopify address update failed: ${err.message}`);
            // Continue — still release the hold, the address was validated
          }
        }

        // Release Warehance hold
        if (whOrder?.id) {
          try {
            await releaseAddressHold(whOrder.id);
            console.log(`  ✓ Released hold on #${order.order_number} (geocoding validated)`);
          } catch (err) {
            console.warn(`  Failed to release hold: ${err.message}`);
            result.autoResolved = false;
            result.reason = `Geocoding validated but hold release failed: ${err.message}`;
          }
        }

        if (result.autoResolved) {
          await supabase.from('order_alert_notes').insert({
            order_number: order.order_number,
            note: `Auto-resolved: ${result.reason}`,
            resolved: false,
            author: 'auto',
            alert_type: 'unfulfilled',
          });
        }

        results.push(result);
        continue;
      } else {
        const reason = !geocoded ? 'geocoding failed'
          : geocoded.locationType !== 'ROOFTOP' ? `precision: ${geocoded.locationType}`
          : geocoded.partialMatch ? 'partial match'
          : (addr.address2 && !geocoded.subpremise) ? 'unit not validated'
          : `zip changed (${addr.zip} → ${geocoded.zip})`;
        console.log(`  Geocoding did not validate: ${reason}`);
      }
    }

    // Rule 3: Street View + Claude Vision
    console.log(`  Checking #${order.order_number} — Rule 3 (Street View + Vision)...`);
    const svAddr = order.shipping_address;
    if (svAddr) {
      const imageBuffer = await fetchStreetViewImage(svAddr);

      if (imageBuffer) {
        const addrStr = [svAddr.address1, svAddr.city, svAddr.province, svAddr.zip].filter(Boolean).join(', ');
        const classification = await classifyAddressImage(imageBuffer, addrStr);
        result.classification = classification;

        if (classification === 'RESIDENTIAL') {
          result.autoResolved = true;
          result.rule = 'street_view_residential';
          result.reason = `Street View shows residential building`;

          if (whOrder?.id) {
            try {
              await releaseAddressHold(whOrder.id);
              console.log(`  ✓ Released hold on #${order.order_number} (residential per Street View)`);
            } catch (err) {
              console.warn(`  Failed to release hold: ${err.message}`);
              result.autoResolved = false;
              result.reason = `Classified residential but hold release failed: ${err.message}`;
            }
          }

          if (result.autoResolved) {
            await supabase.from('order_alert_notes').insert({
              order_number: order.order_number,
              note: `Auto-resolved: ${result.reason}`,
              resolved: false,
              author: 'auto',
              alert_type: 'unfulfilled',
            });
          }
        } else {
          console.log(`  Street View classification: ${classification} — leaving hold for manual review`);
          result.reason = `Street View classified as ${classification}`;
        }
      } else {
        console.log(`  No Street View coverage — leaving hold`);
        result.reason = 'No Street View coverage available';
      }
    }

    results.push(result);
  }

  return results;
}

module.exports = {
  checkPreviousFulfilledOrder,
  geocodeAddress,
  validateGeocodedAddress,
  fetchStreetViewImage,
  classifyAddressImage,
  resolveAddressHolds,
};
