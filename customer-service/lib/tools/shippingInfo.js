/**
 * Shipping Info Handler
 *
 * Answers pre-purchase shipping questions:
 * - "Do you ship to [country]?"
 * - "How much is shipping to [country]?"
 * - "How long does shipping take?"
 * - "Do I have to pay customs/duties?"
 *
 * Deterministic lookup from shipping_zones + delivery stats.
 * AI only for light tone polish.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { addBusinessDays } = require('../../../shared/businessDays');

// ---------------------------------------------------------------------------
// Country detection — extract country from customer message
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES = {
  'uk': 'GB', 'united kingdom': 'GB', 'england': 'GB', 'britain': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'us': 'US', 'usa': 'US', 'united states': 'US', 'america': 'US', 'states': 'US',
  'canada': 'CA',
  'australia': 'AU', 'aus': 'AU', 'oz': 'AU',
  'new zealand': 'NZ', 'nz': 'NZ',
  'germany': 'DE', 'deutschland': 'DE',
  'france': 'FR',
  'netherlands': 'NL', 'holland': 'NL',
  'denmark': 'DK', 'danmark': 'DK',
  'sweden': 'SE', 'sverige': 'SE',
  'norway': 'NO', 'norge': 'NO',
  'finland': 'FI', 'suomi': 'FI',
  'ireland': 'IE',
  'spain': 'ES', 'españa': 'ES',
  'italy': 'IT', 'italia': 'IT',
  'portugal': 'PT',
  'poland': 'PL', 'polska': 'PL',
  'switzerland': 'CH', 'schweiz': 'CH', 'suisse': 'CH',
  'austria': 'AT', 'österreich': 'AT',
  'belgium': 'BE', 'belgique': 'BE',
  'israel': 'IL',
  'mexico': 'MX', 'méxico': 'MX',
  'japan': 'JP',
  'south korea': 'KR', 'korea': 'KR',
  'india': 'IN',
  'brazil': 'BR', 'brasil': 'BR',
  'uruguay': 'UY',
  'iceland': 'IS',
  'czech republic': 'CZ', 'czechia': 'CZ',
  'greece': 'GR',
  'hungary': 'HU',
  'romania': 'RO',
  'croatia': 'HR',
  'singapore': 'SG',
  'taiwan': 'TW',
  'hong kong': 'HK',
  'philippines': 'PH',
  'thailand': 'TH',
  'south africa': 'ZA',
  'chile': 'CL',
  'colombia': 'CO',
  'argentina': 'AR',
  'peru': 'PE',
};

/**
 * Try to extract a country from the customer's message.
 * Returns { code, name } or null.
 */
async function detectCountry(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  // Check aliases first (handles "UK", "US", etc.)
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    // Word boundary match to avoid "used" matching "us"
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) {
      const supabase = getSupabaseClient();
      const { data } = await supabase.from('shipping_zones').select('country_name').eq('country_code', code).single();
      return { code, name: data?.country_name || alias };
    }
  }

  // Try matching against all country names in shipping_zones
  const supabase = getSupabaseClient();
  const { data: zones } = await supabase.from('shipping_zones').select('country_code, country_name');
  if (zones) {
    for (const z of zones) {
      if (z.country_name && lower.includes(z.country_name.toLowerCase())) {
        return { code: z.country_code, name: z.country_name };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Delivery time estimates
// ---------------------------------------------------------------------------

// Policy defaults (business days)
const DELIVERY_ESTIMATES = {
  us:     { standard: '2-6 business days', expedited: '2-3 business days' },
  canada: { standard: '5-8 business days', expedited: '3-4 business days' },
  ddp:    { standard: '5-10 business days', expedited: '3-6 business days' },
  ddu:    { standard: '5-10 business days', expedited: '3-6 business days' },
};

// ---------------------------------------------------------------------------
// Detect what the customer is asking about
// ---------------------------------------------------------------------------

function detectIntent(message) {
  if (!message) return { availability: true };
  const msg = message.toLowerCase();
  return {
    availability: /do you (ship|deliver)|ship to|can (i|you) (ship|send|order)|deliver.* to/i.test(msg),
    cost: /how much|cost|charge|rate|fee|price|shipping.*\$/i.test(msg),
    time: /how long|when|time|days|fast|quick|take to/i.test(msg),
    duties: /dut(y|ies)|customs|tax|import|aduana|additional (fee|charge|cost)/i.test(msg),
    expedited: /expedit|express|fast|rush|overnight|next day|urgent/i.test(msg),
  };
}

// ---------------------------------------------------------------------------
// Build response — only answer what's asked
// ---------------------------------------------------------------------------

function buildShippingInfoResponse(zone, country, context) {
  const { customerName, customerMessage } = context || {};
  const greeting = customerName ? `Hi ${customerName}` : 'Hi';
  const parts = [];
  const intent = detectIntent(customerMessage);
  let needsHumanFollowUp = false;

  // Handle overnight/expedited questions specifically
  if (intent.expedited) {
    if (zone?.zone === 'us' && zone?.expedited_rate) {
      parts.push(`${greeting}, we offer expedited shipping within the US for $${zone.expedited_rate} ${zone.currency} which typically takes 2-3 business days.`);
      if (/overnight|next day/i.test(customerMessage || '')) {
        parts.push(`We don't offer overnight but if you let me know the latest date you need to receive it I can see what we can do.`);
        needsHumanFollowUp = true;
      }
    } else {
      parts.push(`${greeting}, we offer expedited shipping within the US.`);
      parts.push(`Let me know what country you are shipping to and the latest date you need to receive it and I can look into it.`);
      needsHumanFollowUp = true;
    }
    return { text: parts.join(' '), resolved: !needsHumanFollowUp, needsHumanFollowUp };
  }

  // No country detected
  if (!zone) {
    parts.push(`${greeting}, yes we ship to most countries worldwide.`);
    if (intent.cost) parts.push(`Standard international shipping is $12 USD.`);
    parts.push(`Let me know which country and I can give you more specific info.`);
    return { text: parts.join(' '), resolved: true, needsHumanFollowUp: false };
  }

  const countryName = country?.name || 'there';

  // If nothing specific asked, they're just asking availability — keep it simple
  const nothingSpecific = !intent.cost && !intent.time && !intent.duties;

  // Availability (always include if they asked or if it's the only question)
  if (intent.availability || nothingSpecific) {
    // US customers know we ship there — say where we ship FROM instead
    if (zone.zone === 'us') {
      parts.push(`${greeting}, yes we ship from Portland, Oregon.`);
    } else {
      parts.push(`${greeting}, yes we ship to ${countryName}.`);
    }
  } else {
    parts.push(greeting + '!');
  }

  // Cost — only if asked
  if (intent.cost || nothingSpecific) {
    if (zone.free_shipping_threshold > 0) {
      parts.push(`Shipping is $${zone.standard_rate} ${zone.currency}, and free on orders over $${zone.free_shipping_threshold} ${zone.currency}.`);
    } else {
      parts.push(`Shipping is $${zone.standard_rate} ${zone.currency}.`);
    }
  }

  // Delivery time — only if asked
  if (intent.time) {
    const estimates = DELIVERY_ESTIMATES[zone.zone] || DELIVERY_ESTIMATES.ddu;
    parts.push(`Standard delivery typically takes ${estimates.standard}.`);
  }

  // Duties — include if asked OR if DDP (good news worth sharing) OR if DDU and they asked about cost/availability
  if (intent.duties || zone.duties_prepaid || (zone.zone === 'ddu' && (intent.cost || nothingSpecific))) {
    if (zone.duties_prepaid) {
      parts.push(`The pricing includes all taxes and duties so there will be no additional fees once you place the order.`);
    } else if (zone.zone === 'ddu') {
      parts.push(`There may be customs duties charged on delivery — the amount depends on your local customs authority and we unfortunately can't predict what they will be.`);
    }
  }

  return { text: parts.join(' '), resolved: true, needsHumanFollowUp: false };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleShippingInfo({ customer_email, issue_description, _context }) {
  const customerMessage = issue_description || _context?.customerMessage || '';
  const customerName = _context?.intake?.name || _context?.customer?.firstName || null;

  // Detect which country they're asking about
  const country = await detectCountry(customerMessage);

  // Look up zone data
  let zone = null;
  if (country) {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('shipping_zones').select('*').eq('country_code', country.code).single();
    zone = data;
  }

  const { text, needsHumanFollowUp } = buildShippingInfoResponse(zone, country, { customerName, customerMessage });

  // Light AI polish if customer message present
  let polished = text;
  if (customerMessage) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const ai = new Anthropic();
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
- Keep ALL facts, rates, and policy details EXACTLY as written — change nothing substantive
- Only smooth awkward phrasing or combine choppy sentences
- Do NOT add emotional commentary
- Do NOT add a sign-off
- If the draft already reads fine, return it unchanged
- Return ONLY the response`,
        }],
      });
      polished = response.content[0]?.text || text;
    } catch (e) {
      polished = text;
    }
  }

  let md = `## Shipping Info\n\n`;
  if (country) {
    md += `**Country:** ${country.name} (${country.code})\n`;
    md += `**Zone:** ${zone?.zone || 'unknown'}\n`;
    md += `**Rate:** $${zone?.standard_rate || '?'} ${zone?.currency || 'USD'}`;
    if (zone?.free_shipping_threshold > 0) md += ` (free over $${zone.free_shipping_threshold})`;
    md += '\n';
    md += `**Duties prepaid:** ${zone?.duties_prepaid ? 'Yes' : 'No'}\n`;
  } else {
    md += `**Country:** Could not detect from message\n`;
  }
  md += `\n**Customer response:**\n${polished}\n`;

  return {
    content: [{ type: 'text', text: md }],
    _structured: {
      status: needsHumanFollowUp ? 'needs_attention' : 'resolved',
      intake: _context?.intake || null,
      country: country || null,
      zone: zone?.zone || null,
      response: polished,
      rawResponse: text,
    },
  };
}

// ---------------------------------------------------------------------------
// Duties reimbursement handler
// ---------------------------------------------------------------------------

function buildDutiesResponse(zone, context) {
  const { customerName } = context || {};
  const greeting = customerName ? `Hi ${customerName}` : 'Hi';
  const parts = [];

  if (zone?.duties_prepaid) {
    // DDP country — we cover duties, reimburse if charged
    parts.push(`${greeting}, yes we do reimburse the cost of duties that are charged on international orders.`);
    parts.push(`Please go ahead and pay the bill so you can receive your package, then send us the receipt and we will refund the amount.`);
    return { text: parts.join(' '), needsHumanFollowUp: false };
  }

  // DDU country — we don't cover duties
  parts.push(`${greeting}, unfortunately we are unable to cover the cost of duties for your country.`);
  parts.push(`These are charged by your local customs authority and are outside of our control.`);
  return { text: parts.join(' '), needsHumanFollowUp: false };
}

async function handleDutiesInquiry({ customer_email, issue_description, _context }) {
  const customerMessage = issue_description || _context?.customerMessage || '';
  const customerName = _context?.intake?.name || _context?.customer?.firstName || null;
  const customerCountry = _context?.customerCountry || null;

  // Try to find their zone from their account country or message
  let zone = null;
  let country = null;

  if (customerCountry) {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('shipping_zones').select('*').eq('country_code', customerCountry).single();
    zone = data;
    country = { code: customerCountry, name: data?.country_name || customerCountry };
  }

  if (!zone) {
    // Try detecting from message
    country = await detectCountry(customerMessage);
    if (country) {
      const supabase = getSupabaseClient();
      const { data } = await supabase.from('shipping_zones').select('*').eq('country_code', country.code).single();
      zone = data;
    }
  }

  const { text, needsHumanFollowUp } = buildDutiesResponse(zone, { customerName, customerMessage });

  // Light AI polish
  let polished = text;
  if (customerMessage) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const ai = new Anthropic();
      const response = await ai.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Lightly smooth this customer service response so it reads naturally. Jamie (RUBIES founder) is warm and direct. If the customer wrote in a language other than English, respond in their language.

DRAFT:
${text}

CUSTOMER MESSAGE:
"${customerMessage}"

RULES:
- Keep ALL facts and policy details EXACTLY as written
- Only smooth phrasing
- If customer wrote in Spanish, French, Dutch, etc. — translate the response to their language
- Do NOT add a sign-off
- Return ONLY the response`,
        }],
      });
      polished = response.content[0]?.text || text;
    } catch (e) {
      polished = text;
    }
  }

  let md = `## Duties Inquiry\n\n`;
  md += `**Country:** ${country?.name || 'unknown'} (${country?.code || '?'})\n`;
  md += `**DDP (duties prepaid):** ${zone?.duties_prepaid ? 'Yes — reimburse' : 'No — customer pays'}\n`;
  md += `\n**Customer response:**\n${polished}\n`;

  return {
    content: [{ type: 'text', text: md }],
    _structured: {
      status: needsHumanFollowUp ? 'needs_attention' : 'resolved',
      intake: _context?.intake || null,
      country: country || null,
      zone: zone?.zone || null,
      dutiesPrepaid: zone?.duties_prepaid || false,
      response: polished,
      rawResponse: text,
    },
  };
}

// ---------------------------------------------------------------------------
// Address change handler
// ---------------------------------------------------------------------------

/**
 * Detect if the customer provided a new address in their message.
 */
function hasNewAddress(message) {
  if (!message) return false;
  // Look for patterns like street numbers, zip codes, city/state combos
  return /\d{2,5}\s+\w+\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court|pl|place)\b/i.test(message)
    || /\b\d{5}(-\d{4})?\b/.test(message) // US zip
    || /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(message); // Canadian postal
}

/**
 * Address change decision tree:
 *
 * FULFILLED:
 *   → Can't change. Ask if they have access to old address. Kick to human.
 *
 * UNFULFILLED + IN PROGRESS at warehouse:
 *   → "We'll try to update it but it may be too late." Kick to human.
 *
 * UNFULFILLED + NOT in progress:
 *   + Customer provided new address → "I'll update it on your order." Kick to human to do the update.
 *   + Customer did NOT provide address → Put warehouse hold + ask for address.
 */
function buildAddressChangeResponse(order, context) {
  const { customerName, customerMessage, warehouseStatus } = context || {};
  const greeting = customerName ? `Hi ${customerName}` : 'Hi';
  const parts = [];
  let action = 'ask_human'; // ask_human, hold_placed, update_pending

  const isFulfilled = order?.displayFulfillmentStatus === 'FULFILLED'
    || (order?.fulfillments && order.fulfillments.length > 0);

  if (!order) {
    parts.push(`${greeting}, can you let me know your order number so I can look into this?`);
    return { text: parts.join(' '), needsHumanFollowUp: true, action: 'need_order_number' };
  }

  if (isFulfilled) {
    // Post-shipment — can't change
    parts.push(`${greeting}, unfortunately once a package has shipped we can't change the shipping address.`);
    const mentionsOldAddress = /old address|moved|wrong address|incorrect address|shipped to.*(old|wrong)/i.test(customerMessage || '');
    if (mentionsOldAddress) {
      parts.push(`Do you still have access to that address? If not, let me know your correct address and I'll send out another package.`);
    } else {
      parts.push(`Let me know your correct address and I'll send out another package.`);
    }
    action = 'ask_human';
  } else if (warehouseStatus === 'in_progress') {
    // Unfulfilled but already being picked/packed
    parts.push(`${greeting}, I can see your order is already being prepared at our warehouse. I'll try to update the address but it may be too late.`);
    if (hasNewAddress(customerMessage)) {
      parts.push(`I'll do my best to get it changed.`);
    } else {
      parts.push(`Can you let me know the correct address and I'll do my best to get it changed?`);
    }
    action = 'ask_human';
  } else {
    // Unfulfilled, not in progress — we can update
    if (hasNewAddress(customerMessage)) {
      parts.push(`${greeting}, no problem — I'll update the address on your order.`);
      action = 'update_pending';
    } else {
      parts.push(`${greeting}, no problem — I've put a hold on your order so it doesn't ship until we sort this out.`);
      parts.push(`Can you let me know the correct address?`);
      action = 'hold_placed';
    }
  }

  return { text: parts.join(' '), needsHumanFollowUp: true, action };
}

async function handleAddressChange({ customer_email, issue_description, _context }) {
  const customerMessage = issue_description || _context?.customerMessage || '';
  const customerName = _context?.intake?.name || _context?.customer?.firstName || null;
  const order = _context?.order || null;

  const isFulfilled = order && (order.displayFulfillmentStatus === 'FULFILLED'
    || (order.fulfillments && order.fulfillments.length > 0));

  // Check Warehance status for unfulfilled orders
  let warehouseStatus = null;
  let whOrder = null;
  if (order && !isFulfilled) {
    try {
      const { fetchOrderByNumber, setWarehouseHold } = require('../../../reports/lib/warehanceClient');
      const orderNum = order.name?.replace('#', '');
      whOrder = await fetchOrderByNumber(orderNum);
      if (whOrder) {
        warehouseStatus = whOrder.fulfillment_status || null; // 'unfulfilled', 'in_progress', etc.
      }
    } catch (e) {
      // Warehance unavailable — proceed without it
    }
  }

  const { text, needsHumanFollowUp, action } = buildAddressChangeResponse(order, { customerName, customerMessage, warehouseStatus });

  // If action is hold_placed, actually place the hold
  if (action === 'hold_placed' && whOrder?.id) {
    try {
      const { setWarehouseHold } = require('../../../reports/lib/warehanceClient');
      await setWarehouseHold(whOrder.id);
    } catch (e) {
      // Hold failed — still send the response, Jamie will handle manually
    }
  }

  let md = `## Address Change Request\n\n`;
  if (order) {
    md += `**Order:** ${order.name}\n`;
    md += `**Status:** ${isFulfilled ? 'SHIPPED' : 'UNFULFILLED'}`;
    if (warehouseStatus) md += ` (warehouse: ${warehouseStatus})`;
    md += '\n';
    if (action === 'hold_placed') md += `**Hold placed:** Yes — warehouse hold set to prevent shipping\n`;
    if (order.shippingAddress) {
      const addr = order.shippingAddress;
      md += `**Current address:** ${addr.address1 || ''}${addr.address2 ? ', ' + addr.address2 : ''}, ${addr.city || ''} ${addr.provinceCode || ''} ${addr.zip || ''} ${addr.countryCodeV2 || ''}\n`;
    }
  }
  md += `**Action:** ${action}\n`;
  md += `\n**Customer response:**\n${text}\n`;

  return {
    content: [{ type: 'text', text: md }],
    _structured: {
      status: 'needs_attention',
      intake: _context?.intake || null,
      order: order?.name || null,
      fulfilled: isFulfilled || false,
      warehouseStatus,
      action,
      response: text,
      rawResponse: text,
    },
  };
}

// ---------------------------------------------------------------------------
// Shipping speed change handler (upgrade/downgrade expedited)
// ---------------------------------------------------------------------------

function buildShippingSpeedResponse(order, context) {
  const { customerName, customerMessage } = context || {};
  const greeting = customerName ? `Hi ${customerName}` : 'Hi';
  const parts = [];

  if (!order) {
    parts.push(`${greeting}, can you let me know your order number so I can look into this?`);
    return { text: parts.join(' '), needsHumanFollowUp: true };
  }

  const isFulfilled = order.displayFulfillmentStatus === 'FULFILLED'
    || (order.fulfillments && order.fulfillments.length > 0);

  if (isFulfilled) {
    parts.push(`${greeting}, unfortunately your order has already shipped so we can't change the shipping speed.`);
    return { text: parts.join(' '), needsHumanFollowUp: false };
  }

  const wantsDowngrade = /downgrade|normal|standard|slower|change.*from.*expedit|don.?t need.*fast/i.test(customerMessage || '');
  const wantsUpgrade = /upgrade|expedit|express|fast|rush|need.*sooner|speed.*up/i.test(customerMessage || '');

  if (wantsDowngrade) {
    parts.push(`${greeting}, no problem — I'll update the shipping speed and refund you the difference.`);
  } else if (wantsUpgrade) {
    parts.push(`${greeting}, I can upgrade your order to expedited shipping. I'll get that updated and let you know once it's done.`);
  } else {
    parts.push(`${greeting}, I'll look into the shipping on your order and get back to you.`);
  }

  return { text: parts.join(' '), needsHumanFollowUp: true };
}

async function handleShippingSpeedChange({ customer_email, issue_description, _context }) {
  const customerMessage = issue_description || _context?.customerMessage || '';
  const customerName = _context?.intake?.name || _context?.customer?.firstName || null;
  const order = _context?.order || null;

  const { text, needsHumanFollowUp } = buildShippingSpeedResponse(order, { customerName, customerMessage });

  const isFulfilled = order && (order.displayFulfillmentStatus === 'FULFILLED'
    || (order.fulfillments && order.fulfillments.length > 0));

  let md = `## Shipping Speed Change\n\n`;
  if (order) {
    md += `**Order:** ${order.name}\n`;
    md += `**Status:** ${isFulfilled ? 'SHIPPED — cannot change' : 'UNFULFILLED — can update'}\n`;
  }
  md += `\n**Customer response:**\n${text}\n`;

  return {
    content: [{ type: 'text', text: md }],
    _structured: {
      status: needsHumanFollowUp ? 'needs_attention' : 'resolved',
      intake: _context?.intake || null,
      order: order?.name || null,
      fulfilled: isFulfilled || false,
      response: text,
      rawResponse: text,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP Tool definition
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'shipping_info',
    description: [
      'Answer shipping questions: availability, rates, delivery times, duties, address changes, speed changes.',
      'Routes internally based on the question type.',
      'Use cs_advisor for full conversation flow — this tool is for direct lookups.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        customer_email: { type: 'string', description: 'Customer email (used to find orders for address/speed changes)' },
        question: { type: 'string', description: 'The customer\'s shipping question' },
        order_number: { type: 'string', description: 'Order number (for address/speed changes)' },
      },
      required: ['question'],
    },
    handler: async ({ customer_email, question, order_number }) => {
      // Build minimal context
      let customer = null;
      let order = null;
      if (customer_email || order_number) {
        const { buildContext } = require('../contextBuilder');
        const ctx = await buildContext({ customer_email, order_number });
        customer = ctx.customer;
        order = ctx.targetOrder;
      }

      const msg = (question || '').toLowerCase();

      // Route by question type
      const isDuties = /dut(y|ies)|customs|import (cost|fee|tax|charge)|aduana/i.test(msg) && /paid|charged|pay|reimburse|refund|receipt/i.test(msg);
      const isAddress = /address|wrong (city|zip|street|house)|shipped to.*(old|wrong)/i.test(msg);
      const isSpeed = /expedit|express|fast|rush|overnight|upgrade.*ship|downgrade.*ship|change.*shipping/i.test(msg);

      if (isDuties) {
        return handleDutiesInquiry({ customer_email, issue_description: question, _context: { customer, order, customerMessage: question, intake: {}, customerCountry: customer?.defaultAddress?.countryCodeV2 } });
      }
      if (isAddress) {
        return handleAddressChange({ customer_email, issue_description: question, _context: { customer, order, customerMessage: question, intake: {} } });
      }
      if (isSpeed) {
        return handleShippingSpeedChange({ customer_email, issue_description: question, _context: { customer, order, customerMessage: question, intake: {} } });
      }

      // Default: shipping info (availability, cost, time)
      return handleShippingInfo({ customer_email, issue_description: question, _context: { customer, customerMessage: question, intake: {} } });
    },
  },
];

// Export both as tool array (for server.js) and named functions (for internal routing)
tools.handleShippingInfo = handleShippingInfo;
tools.handleDutiesInquiry = handleDutiesInquiry;
tools.handleAddressChange = handleAddressChange;
tools.handleShippingSpeedChange = handleShippingSpeedChange;
tools.buildShippingInfoResponse = buildShippingInfoResponse;
tools.buildDutiesResponse = buildDutiesResponse;
tools.buildAddressChangeResponse = buildAddressChangeResponse;
tools.buildShippingSpeedResponse = buildShippingSpeedResponse;
tools.detectCountry = detectCountry;

module.exports = tools;
