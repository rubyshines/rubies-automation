/**
 * Tracking Analyzer — uses Sonnet to extract structured data from raw tracking
 * page text and generate customer-friendly summaries.
 *
 * Two functions:
 * 1. parseTrackingPage() — extracts structured events, status, carrier info from raw text
 * 2. summarizeForCustomer() — generates a customer-facing message from structured data
 */

const Anthropic = require('@anthropic-ai/sdk');

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
// Summarize for customer — generates a friendly message
// ---------------------------------------------------------------------------

const SUMMARIZE_PROMPT = `You are a customer service agent for RUBIES, a gender-affirming underwear brand. Based on the tracking data below, write a short, friendly response to a customer asking about their shipment.

RULES:
- Be warm and direct — match Jamie's tone (the founder). No corporate-speak.
- Include: current status, where the package is, estimated delivery if available
- Include the tracking link so they can follow along
- For international (Passport): mention the local carrier if known (e.g. "Royal Mail is handling the delivery in the UK")
- For DDP countries: if asked about customs, mention duties are pre-paid — nothing to pay at delivery
- For DDU countries: mention they may need to pay customs duties on delivery
- If the package appears lost or stuck (no updates for many days), draft an empathetic response and note this needs human follow-up
- If delivered: confirm delivery with location if available
- Do NOT add a sign-off
- Keep it to 2-3 sentences max for normal status updates
- Return ONLY the response text. No explanation.`;

async function summarizeForCustomer(trackingData, context) {
  const { shippingZone, customerName, isThirdParty, thirdPartyLabel, orderNumber } = context || {};

  let zoneNote = '';
  if (shippingZone === 'ddp') zoneNote = 'This is a DDP (Delivered Duty Paid) shipment — all duties and taxes are pre-paid, nothing to pay at delivery.';
  else if (shippingZone === 'ddu') zoneNote = 'This is a DDU shipment — the customer may need to pay customs duties on delivery.';

  const ai = getClient();
  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `${SUMMARIZE_PROMPT}

${zoneNote ? `SHIPPING ZONE: ${zoneNote}\n` : ''}${customerName ? `Customer name: ${customerName}` : 'No customer name — use "Hi!"'}
${isThirdParty ? `Buying for: ${thirdPartyLabel}` : ''}
${orderNumber ? `Order: #${orderNumber}` : ''}

TRACKING DATA:
${JSON.stringify(trackingData, null, 2)}

TRACKING LINK: ${trackingData.trackingUrl || 'not available'}`,
    }],
  });

  return response.content[0]?.text || 'I\'m looking into your shipment status — I\'ll get back to you shortly.';
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
  detectProblems,
};
