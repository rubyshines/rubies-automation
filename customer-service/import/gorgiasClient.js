/**
 * Gorgias REST API client for importing customer service tickets.
 *
 * Auth: HTTP Basic (email:api_key) or Bearer token.
 * Base URL: https://{domain}.gorgias.com/api
 * Rate limit: ~2 req/sec — we add 500ms delay between calls.
 *
 * Docs: https://developers.gorgias.com/reference
 */

const GORGIAS_API_VERSION = ''; // No versioning needed for current endpoints

function getConfig() {
  const domain = process.env.GORGIAS_DOMAIN;
  const apiKey = process.env.GORGIAS_API_KEY;
  const email = process.env.GORGIAS_EMAIL;

  if (!domain || !apiKey || !email) {
    throw new Error('GORGIAS_DOMAIN, GORGIAS_API_KEY, and GORGIAS_EMAIL must be set in .env');
  }

  return {
    baseUrl: `https://${domain}.gorgias.com/api`,
    auth: Buffer.from(`${email}:${apiKey}`).toString('base64'),
  };
}

async function apiFetch(path, options = {}) {
  const config = getConfig();
  const url = `${config.baseUrl}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${config.auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gorgias API error ${response.status} on ${path}: ${errText}`);
  }

  return response.json();
}

/**
 * Fetch tickets with pagination.
 * Returns { data: [tickets], meta: { next_cursor } }
 */
async function getTickets({ cursor, limit = 30, order_by = 'created_datetime:desc', since } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('order_by', order_by);

  if (cursor) params.set('cursor', cursor);

  const result = await apiFetch(`/tickets?${params}`);
  let tickets = result.data || [];

  // Client-side date filter (Gorgias doesn't support created_datetime__gte query param)
  if (since) {
    const sinceDate = new Date(since);
    tickets = tickets.filter(t => new Date(t.created_datetime) >= sinceDate);
    // If all tickets in this page are newer than `since`, there may be more
    // If some are older, we've passed the boundary — signal no more pages
    const allNewer = (result.data || []).every(t => new Date(t.created_datetime) >= sinceDate);
    return {
      data: tickets,
      nextCursor: allNewer ? (result.meta?.next_cursor || null) : null,
    };
  }

  return {
    data: tickets,
    nextCursor: result.meta?.next_cursor || null,
  };
}

/**
 * Fetch all messages for a specific ticket.
 */
async function getTicketMessages(ticketId) {
  const result = await apiFetch(`/tickets/${ticketId}/messages?limit=50&order_by=created_datetime:asc`);
  return result.data || [];
}

/**
 * Fetch macros (saved response templates).
 */
async function getMacros({ limit = 100 } = {}) {
  const result = await apiFetch(`/macros?limit=${limit}`);
  return result.data || [];
}

/**
 * Fetch tags.
 */
async function getTags({ limit = 100 } = {}) {
  const result = await apiFetch(`/tags?limit=${limit}`);
  return result.data || [];
}

/**
 * Strip HTML tags and decode entities — simple version for message bodies.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Delay helper for rate limiting.
 */
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getTickets,
  getTicketMessages,
  getMacros,
  getTags,
  stripHtml,
  delay,
};
