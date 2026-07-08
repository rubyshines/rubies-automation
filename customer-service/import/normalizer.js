/**
 * Normalizer for customer service conversations.
 *
 * Handles:
 * - HTML stripping
 * - Email normalization
 * - Order number extraction from message text
 * - Product mention detection (against product cache)
 * - Response time calculation
 */

const { stripHtml } = require('./gorgiasClient');

// Patterns for extracting Shopify order numbers from text
const ORDER_PATTERNS = [
  /RUBIES-(\d{4,5})/gi,
  /#(\d{4,5})\b/g,
  /order\s*(?:#?\s*)(\d{4,5})\b/gi,
  /\border\s+number\s*:?\s*#?(\d{4,5})\b/gi,
];

// Known RUBIES product names for mention detection
const PRODUCT_NAMES = ['aj', 'charlie', 'brooke', 'ruby', 'ava', 'cheeky', 'sassy'];

/**
 * Normalize an email address.
 */
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

/**
 * Extract order numbers from text.
 * Returns array of order number strings (just the digits).
 */
function extractOrderNumbers(text) {
  if (!text) return [];
  const numbers = new Set();

  for (const pattern of ORDER_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      numbers.add(match[1]);
    }
  }

  return [...numbers];
}

/**
 * Detect product mentions in text.
 * Returns array of product names found.
 */
function extractProductMentions(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PRODUCT_NAMES.filter(name => {
    // Match whole word only (avoid "a jazz" matching "aj")
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    return regex.test(lower);
  });
}

/**
 * Calculate response time in minutes.
 * Takes the first customer message and first agent reply.
 */
function calculateResponseTime(messages) {
  const firstCustomer = messages.find(m => m.sender_type === 'customer');
  const firstAgent = messages.find(m => m.sender_type === 'agent' && m.created_at > (firstCustomer?.created_at || ''));

  if (!firstCustomer || !firstAgent) return null;

  const diff = new Date(firstAgent.created_at) - new Date(firstCustomer.created_at);
  return Math.round(diff / 60000); // milliseconds to minutes
}

/**
 * Normalize a Gorgias ticket into our cs_conversations format.
 */
function normalizeGorgiasTicket(ticket, messages) {
  const normalizedMessages = messages.map(m => {
    // Gorgias distinguishes sender via `from_agent` (boolean) + the internal-note
    // channel — NOT source.type (which carries the channel, e.g. 'email', and is
    // never 'customer'). The old source.type check classified EVERY customer
    // message as 'agent'.
    const isNote = m.channel === 'internal-note' || m.source?.type === 'internal-note';
    return {
    id: `gorgias:${m.id}`,
    conversation_id: `gorgias:${ticket.id}`,
    source: 'gorgias',
    sender_type: isNote ? 'system'
      : m.from_agent === false ? 'customer'
      : 'agent',
    sender_name: m.source?.from?.name || m.source?.from?.address || null,
    body_text: stripHtml(m.body_html || m.body_text || ''),
    body_html: m.body_html || null,
    created_at: m.created_datetime,
    attachments: m.attachments?.length ? JSON.stringify(m.attachments.map(a => ({
      filename: a.name,
      url: a.url,
      type: a.content_type,
    }))) : null,
    is_internal: isNote,
    };
  });

  // Collect all text for order/product extraction
  const allText = normalizedMessages.map(m => m.body_text).join(' ');
  const orderNumbers = extractOrderNumbers(allText);
  const productsMentioned = extractProductMentions(allText);
  const responseTime = calculateResponseTime(normalizedMessages);

  const conversation = {
    id: `gorgias:${ticket.id}`,
    source: 'gorgias',
    source_id: String(ticket.id),
    customer_email: normalizeEmail(ticket.customer?.email),
    customer_name: ticket.customer?.name || null,
    subject: ticket.subject || null,
    status: ticket.status || 'closed',
    channel: ticket.channel || 'email',
    tags: (ticket.tags || []).map(t => t.name || t),
    order_numbers: orderNumbers,
    products_mentioned: productsMentioned,
    created_at: ticket.created_datetime,
    resolved_at: ticket.closed_datetime || ticket.updated_datetime,
    response_time_minutes: responseTime,
    message_count: normalizedMessages.filter(m => !m.is_internal).length,
    imported_at: new Date().toISOString(),
  };

  return { conversation, messages: normalizedMessages };
}

/**
 * Normalize a Tidio conversation export.
 * Tidio export format varies — this handles the common CSV/JSON structure.
 */
function normalizeTidioConversation(tidioData, index) {
  const id = tidioData.id || tidioData.conversation_id || `tidio_${index}`;

  const allMessages = (tidioData.messages || []).map((m, i) => {
    // Role mapping: support both scraper export (role: customer/agent/bot)
    // and legacy Tidio format (is_visitor / type: visitor)
    let senderType;
    if (m.role === 'customer' || m.is_visitor || m.type === 'visitor') {
      senderType = 'customer';
    } else if (m.role === 'bot') {
      senderType = 'system';
    } else {
      senderType = 'agent';
    }

    return {
      id: `tidio:${id}:${i}`,
      conversation_id: `tidio:${id}`,
      source: 'tidio',
      sender_type: senderType,
      sender_name: m.sender_name || m.operator_name || null,
      body_text: stripHtml(m.content || m.message || m.text || ''),
      body_html: null,
      created_at: m.timestamp_iso || m.created_at || (m.timestamp ? new Date(m.timestamp * 1000).toISOString() : new Date().toISOString()),
      attachments: null,
      is_internal: false,
    };
  });

  // Filter out bot messages for text analysis (they're generic prompts, not real content)
  const humanMessages = allMessages.filter(m => m.sender_type !== 'system');
  const allText = humanMessages.map(m => m.body_text).join(' ');

  const conversation = {
    id: `tidio:${id}`,
    source: 'tidio',
    source_id: String(id),
    customer_email: normalizeEmail(tidioData.customer_email || tidioData.visitor_email || tidioData.email),
    customer_name: tidioData.customer_name || tidioData.visitor_name || tidioData.name || null,
    subject: null,
    status: tidioData.is_solved === false ? 'open' : 'closed',
    channel: tidioData.channel || 'chat',
    tags: [],
    order_numbers: extractOrderNumbers(allText),
    products_mentioned: extractProductMentions(allText),
    created_at: tidioData.created_at || tidioData.timestamp || allMessages[0]?.created_at || new Date().toISOString(),
    resolved_at: tidioData.last_message_at || allMessages[allMessages.length - 1]?.created_at || null,
    response_time_minutes: calculateResponseTime(allMessages),
    message_count: allMessages.length,
    imported_at: new Date().toISOString(),
  };

  return { conversation, messages: allMessages };
}

module.exports = {
  normalizeEmail,
  extractOrderNumbers,
  extractProductMentions,
  calculateResponseTime,
  normalizeGorgiasTicket,
  normalizeTidioConversation,
};
