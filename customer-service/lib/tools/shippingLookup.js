/**
 * Shipping Lookup MCP Tool
 *
 * Looks up tracking info for a customer's order, scrapes the carrier tracking
 * page, uses AI to parse and summarize, returns a customer-friendly response.
 *
 * Tool: shipping_lookup
 */

const { scrapeTracking, detectCarrier } = require('../tracking/scraper');
const { parseTrackingPage, summarizeForCustomer, detectProblems } = require('../tracking/analyzer');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { buildContext } = require('../contextBuilder');

// Cache TTL: 2 hours for active, 24 hours for delivered
const ACTIVE_CACHE_MS = 2 * 60 * 60 * 1000;
const DELIVERED_CACHE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Check cache
// ---------------------------------------------------------------------------

async function getCachedTracking(trackingNumber) {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('tracking_snapshots')
      .select('*')
      .eq('tracking_number', trackingNumber)
      .single();

    if (!data?.scraped_at) return null;

    const age = Date.now() - new Date(data.scraped_at).getTime();
    const ttl = data.current_status === 'delivered' ? DELIVERED_CACHE_MS : ACTIVE_CACHE_MS;
    if (age > ttl) return null; // stale

    return data;
  } catch (e) {
    return null; // table may not exist yet
  }
}

async function cacheTracking(trackingNumber, data) {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('tracking_snapshots').upsert({
      tracking_number: trackingNumber,
      order_number: data.orderNumber || null,
      carrier: data.carrier,
      tracking_url: data.trackingUrl,
      destination_country: data.destination || null,
      shipping_zone: data.shippingZone || null,
      raw_events: data.events || [],
      summary: data.summary,
      action_draft: data.actionDraft || null,
      current_status: data.currentStatus,
      estimated_delivery: data.estimatedDelivery || null,
      last_location: data.lastLocation || null,
      local_carrier: data.localCarrier || null,
      local_tracking_number: data.localTrackingNumber || null,
      customs_cleared: data.customsCleared || null,
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'tracking_number' });
  } catch (e) {
    // Cache write failure is non-fatal
    console.error('[shippingLookup] Cache write failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Look up shipping zone for a country
// ---------------------------------------------------------------------------

async function getShippingZone(countryCode) {
  if (!countryCode) return null;
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('shipping_zones')
      .select('zone, duties_prepaid')
      .eq('country_code', countryCode)
      .single();
    return data?.zone || null;
  } catch (e) {
    // Fallback: US = us, CA = canada, known DDP countries
    if (countryCode === 'US') return 'us';
    if (countryCode === 'CA') return 'canada';
    const ddpCountries = new Set(['AU', 'NZ', 'GB', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
    return ddpCountries.has(countryCode) ? 'ddp' : 'ddu';
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleShippingLookup({ customer_email, order_number, _context }) {
  // _context is passed internally from the advisor (skip re-lookup).
  // When called as standalone MCP tool, _context is undefined — use buildContext.
  let order = null;
  let customer = null;
  let customerMessage = null;

  if (_context) {
    order = _context.order;
    customer = _context.customer;
    customerMessage = _context.customerMessage || null;
  } else {
    const ctx = await buildContext({ customer_email, order_number });
    order = ctx.targetOrder;
    customer = ctx.customer;
  }

  if (!order) {
    return {
      content: [{ type: 'text', text: 'Could not find the order. Please check the order number or customer email.' }],
      _structured: { status: 'error', error: 'order_not_found' },
    };
  }

  // Ensure we have fulfillment details — order lists from getCustomerOrders
  // don't include fulfillments, so re-fetch the full order if needed.
  if (!order.fulfillments && order.name) {
    const { getOrderByNumber } = require('../shopify');
    try {
      const fullOrder = await getOrderByNumber(order.name.replace('#', ''));
      if (fullOrder) order = fullOrder;
    } catch (e) { /* continue with what we have */ }
  }

  // Step 2: Get fulfillment + tracking info
  const fulfillments = order.fulfillments || [];
  if (fulfillments.length === 0 || order.fulfillmentStatus === 'UNFULFILLED') {
    // Unfulfilled order — investigate why
    const { analyzeUnfulfilledOrder, draftUnfulfilledResponse } = require('../tracking/fulfillmentChecker');
    try {
      const investigation = await analyzeUnfulfilledOrder(order);
      const customerName = customer?.firstName || order.customer?.name?.split(' ')[0] || null;
      const draft = await draftUnfulfilledResponse(investigation, { customerName, customerMessage });

      let md = `## Shipping Lookup\n\n`;
      md += `**Order:** ${order.name}\n`;
      md += `**Status:** Unfulfilled (${investigation.businessDays} business days)\n`;
      md += `**Severity:** ${investigation.severity.toUpperCase()}\n\n`;
      if (investigation.issues.length > 0) {
        md += `**Issues found:**\n`;
        for (const issue of investigation.issues) md += `- ${issue.type}: ${issue.description}\n`;
        md += '\n';
      }
      if (investigation.inventory.length > 0) {
        md += `**Inventory check:**\n`;
        for (const item of investigation.inventory) {
          if (item.error) { md += `- ${item.title}: error (${item.error})\n`; continue; }
          const status = item.isPreOrder ? '⏳ PRE-ORDER' : item.available <= 0 ? '❌ OUT OF STOCK' : `✅ ${item.available} available`;
          md += `- ${item.title} (${item.variant}): ${status}\n`;
        }
        md += '\n';
      }
      md += `**Customer response draft:**\n${draft}\n`;

      return {
        content: [{ type: 'text', text: md }],
        _structured: {
          status: investigation.severity === 'urgent' ? 'needs_attention' : investigation.severity === 'attention' ? 'needs_attention' : 'processing',
          order: order.name,
          fulfillmentStatus: 'UNFULFILLED',
          investigation,
          draft,
          results: [{ summary: draft, currentStatus: 'unfulfilled', problems: investigation.issues }],
        },
      };
    } catch (e) {
      // Fallback if investigation fails
      const daysSinceOrder = Math.floor((Date.now() - new Date(order.createdAt).getTime()) / 86400000);
      return {
        content: [{ type: 'text', text: `## Shipping Lookup\n\n**Order:** ${order.name}\n**Status:** Unfulfilled (${daysSinceOrder} days)\n**Note:** Could not complete investigation: ${e.message}` }],
        _structured: { status: 'needs_attention', order: order.name, fulfillmentStatus: 'UNFULFILLED', error: e.message },
      };
    }
  }

  // Step 3: For each fulfillment, scrape + analyze
  const results = [];
  const destCountry = order.shippingAddress?.countryCodeV2 || order.shippingAddress?.countryCode;
  const destProvince = order.shippingAddress?.provinceCode || order.shippingAddress?.province || null;
  const shippingZone = await getShippingZone(destCountry);

  // Look up region from province (for granular delivery window)
  let destRegion = null;
  if (destProvince && destCountry) {
    try {
      const supabase = getSupabaseClient();
      const { data: regionRow } = await supabase
        .from('shipping_regions')
        .select('region')
        .eq('country_code', destCountry)
        .eq('province_code', destProvince)
        .single();
      destRegion = regionRow?.region || null;
    } catch (e) { /* no region mapping */ }
  }

  for (const ff of fulfillments) {
    const trackingInfo = ff.trackingInfo?.[0] || {};
    const trackingNumber = trackingInfo.number;
    const trackingUrl = trackingInfo.url;
    const shipDate = ff.createdAt?.split('T')[0] || null;

    if (!trackingNumber && !trackingUrl) {
      results.push({ status: 'no_tracking', note: 'No tracking information available for this fulfillment.' });
      continue;
    }

    // Check cache
    const cached = await getCachedTracking(trackingNumber);
    if (cached) {
      // If we have the customer's message, re-summarize with it (cheap AI call, no re-scrape)
      let summary = cached.summary;
      if (customerMessage) {
        try {
          summary = await summarizeForCustomer(
            { current_status: cached.current_status, events: cached.raw_events, trackingUrl: cached.tracking_url, local_carrier: cached.local_carrier },
            { shippingZone, countryCode: destCountry, provinceCode: destProvince, region: destRegion, customerName: customer?.firstName || order.customer?.name?.split(' ')[0] || null, orderNumber: order.name?.replace('#', ''), customerMessage, shipDate }
          );
        } catch (e) { /* fall back to cached summary */ }
      }
      results.push({
        carrier: cached.carrier,
        trackingUrl: cached.tracking_url,
        currentStatus: cached.current_status,
        summary,
        events: cached.raw_events,
        localCarrier: cached.local_carrier,
        fromCache: true,
      });
      continue;
    }

    // Scrape
    try {
      const scrapeResult = await scrapeTracking(trackingUrl, trackingNumber, ff);
      const parsed = await parseTrackingPage(scrapeResult.rawText, scrapeResult.carrier);

      // Detect problems
      const problems = detectProblems(parsed);

      // Generate customer summary
      const summary = await summarizeForCustomer(
        { ...parsed, trackingUrl: scrapeResult.trackingUrl },
        {
          shippingZone,
          countryCode: destCountry,
          provinceCode: destProvince,
          region: destRegion,
          customerName: customer?.firstName || order.customer?.name?.split(' ')[0] || null,
          orderNumber: order.name?.replace('#', ''),
          customerMessage,
          shipDate,
        }
      );

      const result = {
        carrier: scrapeResult.carrier,
        trackingUrl: scrapeResult.trackingUrl,
        trackingNumber,
        currentStatus: parsed.current_status,
        statusDescription: parsed.status_description,
        estimatedDelivery: parsed.estimated_delivery,
        lastLocation: parsed.last_location,
        localCarrier: parsed.local_carrier,
        localTrackingNumber: parsed.local_tracking_number,
        customsCleared: parsed.customs_cleared,
        events: parsed.events,
        summary,
        problems,
        shippingZone,
      };

      // Cache
      await cacheTracking(trackingNumber, {
        orderNumber: parseInt(order.name?.replace('#', ''), 10) || null,
        carrier: scrapeResult.carrier,
        trackingUrl: scrapeResult.trackingUrl,
        destination: parsed.destination,
        shippingZone,
        events: parsed.events,
        summary,
        currentStatus: parsed.current_status,
        estimatedDelivery: parsed.estimated_delivery,
        lastLocation: parsed.last_location,
        localCarrier: parsed.local_carrier,
        localTrackingNumber: parsed.local_tracking_number,
        customsCleared: parsed.customs_cleared,
      });

      results.push(result);
    } catch (e) {
      results.push({
        carrier: detectCarrier(trackingUrl),
        trackingUrl,
        trackingNumber,
        currentStatus: 'unknown',
        summary: `You can track your package at: ${trackingUrl}`,
        error: e.message,
      });
    }
  }

  // Build output
  const primary = results[0] || {};
  const hasProblems = results.some(r => r.problems?.length > 0);

  let md = `## Shipping Lookup\n\n`;
  md += `**Order:** ${order.name}\n`;
  md += `**Destination:** ${order.shippingAddress?.city || '?'}, ${destCountry || '?'}`;
  if (shippingZone) md += ` (${shippingZone.toUpperCase()})`;
  md += '\n';

  for (const r of results) {
    md += `\n**Carrier:** ${r.carrier || 'unknown'}`;
    if (r.localCarrier) md += ` → ${r.localCarrier}`;
    md += '\n';
    md += `**Status:** ${r.currentStatus || 'unknown'}`;
    if (r.statusDescription) md += ` — ${r.statusDescription}`;
    md += '\n';
    if (r.trackingUrl) md += `**Tracking:** ${r.trackingUrl}\n`;
    if (r.fromCache) md += '*(cached)*\n';
    if (r.problems?.length) {
      for (const p of r.problems) md += `**⚠️ ${p.severity.toUpperCase()}:** ${p.description}\n`;
    }
    md += `\n**Customer response:**\n${r.summary || 'No summary available.'}\n`;
  }

  return {
    content: [{ type: 'text', text: md }],
    _structured: {
      status: hasProblems ? 'needs_attention' : primary.currentStatus || 'unknown',
      order: order.name,
      results,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'shipping_lookup',
    description: [
      'Look up shipping/tracking status for a customer order.',
      'Scrapes the carrier tracking page, uses AI to parse and summarize.',
      'Returns a customer-friendly response with status, location, and tracking link.',
      'Supports Passport (international), OnTrac, and USPS (basic status).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email address' },
        order_number: { type: 'string', description: 'Order number (e.g. "29276"). If omitted, uses most recent order.' },
      },
      required: ['customer_email'],
    },
    handler: handleShippingLookup,
  },
];

module.exports = tools;
