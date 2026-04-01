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
    const ai = getAI();
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
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

    // Rule 2: Street View + Claude Vision
    console.log(`  Checking #${order.order_number} — Rule 2 (Street View + Vision)...`);
    const addr = order.shipping_address;
    if (addr) {
      const imageBuffer = await fetchStreetViewImage(addr);

      if (imageBuffer) {
        const addrStr = [addr.address1, addr.city, addr.province, addr.zip].filter(Boolean).join(', ');
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
  fetchStreetViewImage,
  classifyAddressImage,
  resolveAddressHolds,
};
