/**
 * Tracking Analyzer — uses Sonnet to extract structured data from raw tracking
 * page text and generate customer-friendly summaries.
 *
 * Two functions:
 * 1. parseTrackingPage() — extracts structured events, status, carrier info from raw text
 * 2. summarizeForCustomer() — generates a customer-facing message from structured data
 */

const Anthropic = require('@anthropic-ai/sdk');
const { addBusinessDays, businessDaysSince } = require('../../../shared/businessDays');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ---------------------------------------------------------------------------
// Parse tracking page text → structured data
// ---------------------------------------------------------------------------

const PARSE_PROMPT = `You are parsing the text content of a shipping tracking page. Extract structured JSON from this text.

Return JSON:
{
  "current_status": "pre_transit" | "in_transit" | "out_for_delivery" | "delivered" | "exception" | "returned" | "unknown",
  "status_description": string — one-line description of current status (e.g. "Delivered to mailbox", "In transit from LA to London"),
  "estimated_delivery": string or null — estimated delivery date if mentioned,
  "last_location": string or null — most recent scan location,
  "destination": string or null — delivery destination city/country,
  "local_carrier": string or null — last-mile carrier name if this is a Passport/international shipment (e.g. "Royal Mail", "Australia Post", "DHL"),
  "local_tracking_number": string or null — the local carrier tracking number if different from the main one,
  "customs_cleared": boolean — true if the package has cleared customs/been handed to local carrier,
  "events": [
    {
      "date": string — e.g. "Mar 24",
      "time": string — e.g. "10:40",
      "description": string — what happened,
      "location": string — where it happened
    }
  ] — chronological list of tracking events (most recent first). Include ALL events you can find.
}

IMPORTANT:
- For Passport pages: the journey goes merchant → Passport hub (usually LA) → international export → destination country → local carrier → delivery. Extract the full chain.
- "Waiting for package from shipper" = pre_transit
- If the page says "No tracking information available" = pre_transit
- Extract the local carrier name from Passport pages (appears under "Your local delivery")
- Return ONLY JSON. No explanation.`;

async function parseTrackingPage(rawText, carrier) {
  const ai = getClient();
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `${PARSE_PROMPT}\n\nCarrier: ${carrier}\n\nTracking page text:\n${rawText}`,
    }],
  });

  const text = response.content[0]?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch (e) {
    return { current_status: 'unknown', status_description: 'Could not parse tracking page', events: [] };
  }
}

// ---------------------------------------------------------------------------
// Deterministic response builder — decides WHAT to say based on status + timing
// ---------------------------------------------------------------------------

// addBusinessDays + businessDaysSince imported from shared/businessDays.js (US holiday-aware)

/**
 * Format a date as a relative day name: "today", "tomorrow", "Monday", "next Thursday"
 * Weekend-aware: on Sat/Sun, says "Monday" not "tomorrow" (warehouse doesn't ship weekends)
 */
function relativeDay(d) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target - now) / 86400000);
  const dayName = target.toLocaleDateString('en-US', { weekday: 'long' });
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  if (diff === 0) return 'today';
  if (diff === 1 && !isWeekend) return 'tomorrow';
  if (diff < 0) return dayName;
  if (diff <= 7) return dayName;
  if (diff <= 14) return `next ${dayName}`;
  return formatDate(target);
}

// ---------------------------------------------------------------------------
// Delivery window lookup — country (90-day rolling stats) → zone → static policy
// ---------------------------------------------------------------------------

// Static policy defaults (business days from ship date)
const POLICY_WINDOWS = {
  us:      { standard: { min: 2, max: 6 },  expedited: { min: 2, max: 3 } },
  canada:  { standard: { min: 5, max: 8 },  expedited: { min: 3, max: 4 } },
  ddp:     { standard: { min: 5, max: 10 }, expedited: { min: 3, max: 6 } },
  ddu:     { standard: { min: 5, max: 10 }, expedited: { min: 3, max: 6 } },
};

/**
 * Get expected delivery window from order_delivery_times (90-day rolling).
 *
 * Lookup chain (most granular → least):
 * 1. Province/state (US: OR vs MA matters — warehouse is in Portland)
 * 2. Region (US: west_coast, northeast, etc.)
 * 3. Country (GB, AU, DE — each has different last-mile)
 * 4. Shipping zone (ddp, ddu, canada — aggregate fallback)
 * 5. Static policy defaults
 *
 * Uses p50 for customer-facing ETA, p90 for "overdue" threshold.
 * Requires min 10 samples per bucket, 90-day window.
 */
const MIN_SAMPLE_COUNT = 10;

function computePercentiles(times) {
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p90: times[Math.floor(times.length * 0.9)],
    count: times.length,
  };
}

async function getExpectedWindow(countryCode, shippingZone, provinceCode, region) {
  try {
    const { getSupabaseClient } = require('../../../shared/supabaseClient');
    const supabase = getSupabaseClient();

    // 90-day rolling window
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffISO = cutoff.toISOString();

    // Build base query helper
    async function queryTimes(filters) {
      let q = supabase
        .from('order_delivery_times')
        .select('transit_business_days')
        .not('transit_business_days', 'is', null)
        .gte('delivered_at', cutoffISO);
      for (const [col, val] of Object.entries(filters)) {
        q = q.eq(col, val);
      }
      const { data } = await q;
      return (data || []).map(r => r.transit_business_days);
    }

    // 1. Province/state level (mostly useful for US)
    if (countryCode && provinceCode) {
      const times = await queryTimes({ country_code: countryCode, province_code: provinceCode });
      const stats = computePercentiles(times);
      if (stats && stats.count >= MIN_SAMPLE_COUNT) {
        return { standard: { min: stats.p50, max: stats.p90 }, source: 'province', sampleCount: stats.count };
      }
    }

    // 2. Region level (US regions: west_coast, northeast, etc.)
    if (region) {
      const times = await queryTimes({ region });
      const stats = computePercentiles(times);
      if (stats && stats.count >= MIN_SAMPLE_COUNT) {
        return { standard: { min: stats.p50, max: stats.p90 }, source: 'region', sampleCount: stats.count };
      }
    }

    // 3. Country level
    if (countryCode) {
      const times = await queryTimes({ country_code: countryCode });
      const stats = computePercentiles(times);
      if (stats && stats.count >= MIN_SAMPLE_COUNT) {
        return { standard: { min: stats.p50, max: stats.p90 }, source: 'country', sampleCount: stats.count };
      }
    }

    // 4. Shipping zone level
    if (shippingZone) {
      const times = await queryTimes({ shipping_zone: shippingZone });
      const stats = computePercentiles(times);
      if (stats && stats.count >= MIN_SAMPLE_COUNT) {
        return { standard: { min: stats.p50, max: stats.p90 }, source: 'zone', sampleCount: stats.count };
      }
    }
  } catch (e) {
    // Table may not exist yet — fall through to static defaults
  }

  // 5. Static policy defaults
  return {
    ...(POLICY_WINDOWS[shippingZone] || POLICY_WINDOWS.ddu),
    source: 'policy',
  };
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Convert a raw ETA string like "Thursday Apr 09 - Monday Apr 13" into
 * relative phrasing like "next Thursday to the following Monday" or
 * "early next week". Falls back to the raw string if unparseable.
 */
function formatEtaRelative(rawEta) {
  if (!rawEta) return null;

  // Try to parse date range: "Thursday Apr 09 - Monday Apr 13" or single "Thursday Apr 09"
  const year = new Date().getFullYear();
  const parts = rawEta.split(/\s*[-–]\s*/);
  const dates = parts.map(p => {
    const d = new Date(`${p.trim()} ${year}`);
    return isNaN(d) ? null : d;
  }).filter(Boolean);

  if (dates.length === 0) return rawEta; // unparseable, return as-is

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  function relativeDay(d) {
    const diff = Math.round((d - now) / 86400000);
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff < 0) return dayName; // already past
    if (diff <= 7) return dayName; // "Thursday" (this week)
    if (diff <= 14) return `next ${dayName}`;
    return formatDate(d); // far out, use full date
  }

  if (dates.length === 1) {
    return relativeDay(dates[0]);
  }

  // Range
  const start = relativeDay(dates[0]);
  const end = relativeDay(dates[1]);
  return `${start} to ${end}`;
}

function daysSinceEvent(events) {
  if (!events?.length) return null;
  const latest = events[0]; // most recent first
  // Try parsing the date — events use various formats
  const year = new Date().getFullYear();
  const eventDate = new Date(latest.date?.includes(',') ? latest.date : `${latest.date} ${year}`);
  if (isNaN(eventDate)) return null;
  return Math.floor((Date.now() - eventDate.getTime()) / 86400000);
}

function daysSinceDelivery(trackingData) {
  if (trackingData.current_status !== 'delivered') return null;
  // Find the delivery event
  const deliveryEvent = trackingData.events?.find(e =>
    /deliver/i.test(e.description)
  );
  if (!deliveryEvent) return daysSinceEvent(trackingData.events);
  const year = new Date().getFullYear();
  const d = new Date(deliveryEvent.date?.includes(',') ? deliveryEvent.date : `${deliveryEvent.date} ${year}`);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

async function buildShippingResponse(trackingData, context) {
  const { shippingZone, customerName, orderNumber, customerMessage, shipDate, countryCode, provinceCode, region } = context || {};
  const name = customerName || null;
  const greeting = name ? `Hi ${name}` : 'Hi';
  const trackingLink = trackingData.trackingUrl || null;
  const localCarrier = trackingData.local_carrier;
  const status = trackingData.current_status;
  const daysSinceLastUpdate = daysSinceEvent(trackingData.events);
  const daysSinceDeliver = daysSinceDelivery(trackingData);

  // Check if package is outside expected delivery window
  const window = await getExpectedWindow(countryCode, shippingZone || 'ddu', provinceCode, region);
  const bizDaysSinceShip = shipDate ? businessDaysSince(shipDate) : null;
  const isOverdue = bizDaysSinceShip !== null && bizDaysSinceShip > window.standard.max;

  // Detect customer complaint signals
  const claimsNotReceived = customerMessage && /haven.?t (received|gotten|got)|not received|never (received|arrived|got)|didn.?t (get|receive|arrive)|where.?s my|has not arrived/i.test(customerMessage);
  const complainsAboutDelay = customerMessage && /stuck|no update|hasn.?t (moved|updated|shipped|arrived)|delayed|slow|taking (forever|long|a while)|still (waiting|hasn.?t|has not|not arrived|no sign)|what is going on|where is|not here yet/i.test(customerMessage);

  const parts = [];
  let needsHumanFollowUp = false;

  switch (status) {
    case 'delivered': {
      if (claimsNotReceived && daysSinceDeliver !== null && daysSinceDeliver <= 2) {
        // Delivered very recently + customer says not received → reassure
        const checkBackDate = addBusinessDays(new Date(), 5);
        parts.push(`${greeting}, I can see the tracking shows this was delivered recently.`);
        parts.push(`Sometimes packages take a day or two to show up — I'd suggest checking with neighbours or your building manager, or any safe spot the carrier might have left it.`);
        parts.push(`If it still hasn't turned up by ${relativeDay(checkBackDate)}, reach out to me and I'll get another package sent over to you.`);
      } else if (claimsNotReceived) {
        // Delivered 3+ days ago + customer says not received → escalate
        const detail = trackingData.status_description?.replace(/^delivered\s*/i, '').trim();
        parts.push(`${greeting}, I'm sorry to hear that — tracking does show this was marked as delivered${detail ? ` (${detail})` : ''}.`);
        parts.push(`Since it's been a few days, please reach out to me and worst case scenario I'll send over another package.`);
        needsHumanFollowUp = true;
      } else {
        // Delivered + customer just asking status (no complaint)
        const deliveryDetail = trackingData.status_description?.replace(/^delivered\s*/i, '').trim();
        parts.push(`${greeting}, your order was delivered${deliveryDetail ? ` — ${deliveryDetail}` : ''}.`);
      }
      break;
    }

    case 'in_transit':
    case 'out_for_delivery': {
      if (status === 'out_for_delivery') {
        parts.push(`${greeting}, your package is out for delivery today!`);
      } else if (daysSinceLastUpdate !== null && daysSinceLastUpdate > 14) {
        // Likely lost — 14+ days no update
        parts.push(`${greeting}, I'm sorry for the delay — I can see your package hasn't had a tracking update in ${daysSinceLastUpdate} days.`);
        parts.push(`I'm going to check in with the carrier but it can sometimes take a few days to hear back.`);
        parts.push(`I'll keep you posted — worst case scenario I'll send over another package so don't worry, we'll get this sorted.`);
        needsHumanFollowUp = true;
      } else if (daysSinceLastUpdate !== null && daysSinceLastUpdate > 7) {
        // Stale — 7+ days no update
        parts.push(`${greeting}, I'm sorry for the delay — the tracking hasn't updated in ${daysSinceLastUpdate} days.`);
        parts.push(`I'm going to check in with the carrier but it can sometimes take a few days to hear back.`);
        parts.push(`I'll keep you posted — worst case scenario I'll send over another package so don't worry, we'll get this sorted.`);
        needsHumanFollowUp = true;
      } else if (isOverdue) {
        // Past delivery window but tracking still updating
        parts.push(`${greeting}, I'm sorry for the delay — your order shipped ${bizDaysSinceShip} business days ago and is still in transit${trackingData.last_location ? ' at ' + trackingData.last_location : ''}, which is outside our usual ${window.standard.min}-${window.standard.max} business day delivery window.`);
        parts.push(`I'm going to check in with the carrier but it can sometimes take a few days to hear back.`);
        parts.push(`I'll keep you posted — worst case scenario I'll send over another package so don't worry, we'll get this sorted.`);
        needsHumanFollowUp = true;
      } else {
        // Normal in-transit
        if (complainsAboutDelay && daysSinceLastUpdate !== null && daysSinceLastUpdate > 0) {
          parts.push(`${greeting}, I can see the last tracking update was ${daysSinceLastUpdate === 1 ? 'yesterday' : daysSinceLastUpdate + ' days ago'}${trackingData.last_location ? ' at ' + trackingData.last_location : ''} — it is still moving though.`);
        } else {
          parts.push(`${greeting}, your package is on its way!`);
          if (trackingData.last_location) {
            parts.push(`It was last scanned at ${trackingData.last_location}.`);
          }
        }
        if (trackingData.estimated_delivery) {
          parts.push(`Estimated delivery is ${formatEtaRelative(trackingData.estimated_delivery)}.`);
        }
        if (localCarrier) {
          parts.push(`${localCarrier} is handling the local delivery.`);
        }
        if (trackingData.customs_cleared === false) {
          parts.push(`It's currently going through customs — this can sometimes add a few days.`);
        }
      }
      break;
    }

    case 'pre_transit': {
      parts.push(`${greeting}, the shipping label has been created for your order and it's waiting for carrier pickup.`);
      if (trackingData.estimated_delivery) {
        parts.push(`Estimated delivery is ${formatEtaRelative(trackingData.estimated_delivery)}.`);
      }
      parts.push(`You should see tracking updates within the next day or two once the carrier scans it in.`);
      break;
    }

    case 'exception': {
      parts.push(`${greeting}, I can see there's been an issue with the delivery of your package.`);
      if (trackingData.status_description) parts.push(`The carrier reported: ${trackingData.status_description}.`);
      parts.push(`I'm looking into this and will get back to you. If we can't get this sorted I'll send over another package.`);
      needsHumanFollowUp = true;
      break;
    }

    case 'returned': {
      parts.push(`${greeting}, it looks like your package is being returned to us.`);
      if (trackingData.status_description) parts.push(`The carrier noted: ${trackingData.status_description}.`);
      parts.push(`Once I confirm it's on its way back I'll get a new order sent out to you.`);
      needsHumanFollowUp = true;
      break;
    }

    default: {
      parts.push(`${greeting}, I'm looking into the status of your shipment and will get back to you shortly.`);
      needsHumanFollowUp = true;
      break;
    }
  }

  // Add tracking link
  if (trackingLink && status !== 'unknown') {
    parts.push(`You can follow along here: ${trackingLink}`);
  }

  // Add zone-specific duties note (only if relevant to the message)
  const askingAboutDuties = customerMessage && /dut(y|ies)|customs|tax|import|aduana/i.test(customerMessage);
  if (askingAboutDuties || shippingZone === 'ddu') {
    if (shippingZone === 'ddp') {
      parts.push(`Just a heads up — all duties and taxes are covered on your order, so nothing extra to pay.`);
    } else if (shippingZone === 'ddu') {
      parts.push(`Just a heads up — you may be charged customs duties on delivery. If you are, pay it and send us the receipt and we'll refund it.`);
    }
  }

  return { text: parts.join(' '), needsHumanFollowUp };
}

// ---------------------------------------------------------------------------
// Summarize for customer — deterministic response + light AI polish
// ---------------------------------------------------------------------------

async function summarizeForCustomer(trackingData, context) {
  const { customerMessage } = context || {};
  const { text, needsHumanFollowUp } = await buildShippingResponse(trackingData, context);

  // If no customer message, the deterministic response is good enough — skip AI
  if (!customerMessage) return text;

  // Light AI polish — smooth phrasing only, no added content
  try {
    const ai = getClient();
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Lightly smooth this customer service response so it reads naturally. Jamie (RUBIES founder) is warm and direct.

DRAFT:
${text}

CUSTOMER MESSAGE:
"${customerMessage}"

RULES:
- Keep ALL facts, dates, links, and offers EXACTLY as written — change nothing substantive
- Only smooth awkward phrasing or combine choppy sentences
- Do NOT add emotional commentary ("that's frustrating", "I understand how you feel", etc.)
- Do NOT add filler or padding — shorter is better
- Do NOT add a sign-off
- If the draft already reads fine, return it unchanged
- Return ONLY the response`,
      }],
    });
    return response.content[0]?.text || text;
  } catch (e) {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Problem detection — identifies issues that need human attention
// ---------------------------------------------------------------------------

function detectProblems(trackingData) {
  const problems = [];

  if (trackingData.current_status === 'exception') {
    problems.push({ type: 'exception', severity: 'high', description: 'Carrier reported an exception/alert' });
  }

  if (trackingData.current_status === 'returned') {
    problems.push({ type: 'returned', severity: 'high', description: 'Package is being returned to sender' });
  }

  // Check for stale tracking (no recent events)
  if (trackingData.events?.length > 0) {
    const latestEvent = trackingData.events[0]; // most recent first
    const eventDate = new Date(latestEvent.date + ' ' + new Date().getFullYear());
    const daysSinceUpdate = Math.floor((Date.now() - eventDate.getTime()) / 86400000);

    if (trackingData.current_status !== 'delivered') {
      if (daysSinceUpdate > 14) {
        problems.push({ type: 'stale', severity: 'high', description: `No tracking update in ${daysSinceUpdate} days — may be lost` });
      } else if (daysSinceUpdate > 7) {
        problems.push({ type: 'stale', severity: 'medium', description: `No tracking update in ${daysSinceUpdate} days` });
      }
    }
  }

  return problems;
}

module.exports = {
  parseTrackingPage,
  summarizeForCustomer,
  buildShippingResponse,
  detectProblems,
  addBusinessDays,
  relativeDay,
};
