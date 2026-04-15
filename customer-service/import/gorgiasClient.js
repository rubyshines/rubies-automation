/**
 * Gorgias REST API client — read + write operations.
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

// ─── Write operations ────────────────────────────────────────

/**
 * Fetch a single ticket by ID.
 */
async function getTicket(ticketId) {
  return apiFetch(`/tickets/${ticketId}`);
}

/**
 * Create a new ticket from an external email (e.g., Gmail import).
 * Returns the created ticket object.
 */
async function createTicket({ customerEmail, customerName, subject, bodyText, tags = [], attachments = [] }) {
  const bodyHtml = `<p>${(bodyText || '').replace(/\n/g, '<br>')}</p>`;

  const message = {
    channel: 'email',
    via: 'api',
    from_agent: false,
    source: {
      type: 'email',
      from: { name: customerName || '', address: customerEmail },
      to: [{ name: 'RUBIES Customer Care', address: 'care@rubyshines.com' }],
    },
    body_html: bodyHtml,
    body_text: bodyText || '',
  };
  if (attachments.length) message.attachments = attachments;

  const ticket = await apiFetch('/tickets', {
    method: 'POST',
    body: JSON.stringify({
      channel: 'email',
      via: 'api',
      subject: subject || '(no subject)',
      customer: {
        email: customerEmail,
        name: customerName || undefined,
      },
      messages: [message],
    }),
  });

  // Add tags if specified
  for (const tagName of tags) {
    try {
      await addTicketTag(ticket.id, tagName);
    } catch (err) {
      console.warn(`[gorgias] Could not tag ticket ${ticket.id} with '${tagName}': ${err.message}`);
    }
  }

  return ticket;
}

/**
 * Create a reply message on a ticket (sent to customer via email).
 */
async function createTicketReply(ticketId, { body_html, body_text }) {
  const html = body_html || `<p>${(body_text || '').replace(/\n/g, '<br>')}</p>`;
  // Look up sender info from the ticket
  const ticket = await getTicket(ticketId);
  const senderEmail = process.env.GORGIAS_SENDER_EMAIL || 'care@rubyshines.com';
  const senderName = process.env.GORGIAS_SENDER_NAME || 'RUBIES Customer Care';
  return apiFetch(`/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      channel: 'email',
      via: 'api',
      from_agent: true,
      sender: { id: ticket.assignee_user?.id || undefined },
      source: {
        type: 'email',
        from: { name: senderName, address: senderEmail },
        to: [{ name: ticket.customer?.name || '', address: ticket.customer?.email || '' }],
      },
      body_html: html,
      body_text: body_text || '',
    }),
  });
}

/**
 * Add an imported message to a ticket (not sent as email — for importing history).
 * Use from_agent: true for our sent messages, false for customer messages.
 */
async function addTicketMessage(ticketId, { fromAddress, fromName, bodyText, fromAgent = false, sentDatetime, attachments = [] }) {
  const bodyHtml = `<p>${(bodyText || '').replace(/\n/g, '<br>')}</p>`;

  const message = {
    channel: 'email',
    via: 'api',
    from_agent: fromAgent,
    source: {
      type: 'email',
      from: { name: fromName || '', address: fromAddress },
      to: [{ name: fromAgent ? '' : 'RUBIES Customer Care', address: fromAgent ? fromAddress : 'care@rubyshines.com' }],
    },
    body_html: bodyHtml,
    body_text: bodyText || '',
    ...(sentDatetime ? { sent_datetime: sentDatetime } : {}),
  };
  if (attachments.length) message.attachments = attachments;

  return apiFetch(`/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify(message),
  });
}

/**
 * Add an internal note to a ticket (not visible to customer).
 * Gorgias requires `sender` + `from_agent: true` for internal notes.
 */
let _noteSenderId = null;
async function getNoteSenderId() {
  if (_noteSenderId) return _noteSenderId;
  const query = process.env.GORGIAS_NOTE_SENDER || 'RUBIES AI';
  const user = await findUser(query);
  if (!user) throw new Error(`[gorgias] Could not resolve internal-note sender for "${query}"`);
  _noteSenderId = user.id;
  return _noteSenderId;
}

async function addInternalNote(ticketId, noteText) {
  const senderId = await getNoteSenderId();
  return apiFetch(`/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      channel: 'internal-note',
      via: 'api',
      from_agent: true,
      sender: { id: senderId },
      body_text: noteText,
      body_html: `<p>${noteText.replace(/\n/g, '<br>')}</p>`,
    }),
  });
}

/**
 * Add a tag to a ticket. Creates the tag if it doesn't exist.
 */
let _tagCache = null;
async function addTicketTag(ticketId, tagName) {
  if (!_tagCache) _tagCache = await getTags({ limit: 100 });
  let tag = _tagCache.find(t => t.name === tagName);
  if (!tag) {
    tag = await apiFetch('/tags', {
      method: 'POST',
      body: JSON.stringify({ name: tagName }),
    });
    _tagCache.push(tag);
  }
  // Gorgias requires updating the ticket's tags array via PUT /tickets/{id}
  const ticket = await getTicket(ticketId);
  const currentTags = (ticket.tags || []).map(t => ({ id: t.id }));
  if (currentTags.some(t => t.id === tag.id)) return ticket; // already tagged
  currentTags.push({ id: tag.id });
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags: currentTags }),
  });
}

/**
 * Assign a ticket to a user (or unassign by passing null).
 */
async function assignTicket(ticketId, userId) {
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({
      assignee_user: userId ? { id: userId } : null,
    }),
  });
}

/**
 * List team members. Cached after first call.
 */
let _usersCache = null;
async function getUsers() {
  if (_usersCache) return _usersCache;
  const result = await apiFetch('/users?limit=100');
  _usersCache = result.data || [];
  return _usersCache;
}

/**
 * Find a user by name (case-insensitive partial match).
 */
async function findUser(nameQuery) {
  const users = await getUsers();
  const q = nameQuery.toLowerCase();
  return users.find(u => (u.name || '').toLowerCase().includes(q)
    || (u.email || '').toLowerCase().includes(q));
}

/**
 * Snooze a ticket for a given number of days.
 */
async function snoozeTicket(ticketId, days = 3) {
  const snoozeUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ snooze_datetime: snoozeUntil }),
  });
}

/**
 * Close a ticket.
 */
async function closeTicket(ticketId) {
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'closed' }),
  });
}

/**
 * Fetch tickets from a Gorgias view (filtered ticket list).
 * Views use server-side filters (e.g. "All open" = view 28532).
 * Paginates until all results are returned.
 */
async function getViewItems(viewId, { limit = 30, order_by = 'updated_datetime:desc' } = {}) {
  const all = [];
  let cursor = null;
  do {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('order_by', order_by);
    if (cursor) params.set('cursor', cursor);
    const result = await apiFetch(`/views/${viewId}/items?${params}`);
    if (result.data) all.push(...result.data);
    cursor = result.meta?.next_cursor || null;
    if (cursor) await delay(500);
  } while (cursor);
  return all;
}

// ─── Utilities ───────────────────────────────────────────────

/**
 * Strip HTML tags and decode entities — simple version for message bodies.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#160;/g, ' ')
    .replace(/[ \t]+/g, ' ')          // collapse horizontal whitespace only
    .replace(/\n /g, '\n')            // trim leading space after newline
    .replace(/\n{3,}/g, '\n\n')       // max 2 consecutive newlines
    .trim();
}

/**
 * Delay helper for rate limiting.
 */
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  // Read
  getTickets,
  getTicket,
  getTicketMessages,
  getViewItems,
  getMacros,
  getTags,
  getUsers,
  findUser,
  // Write
  createTicket,
  createTicketReply,
  addTicketMessage,
  addInternalNote,
  addTicketTag,
  assignTicket,
  snoozeTicket,
  closeTicket,
  // Utilities
  stripHtml,
  delay,
};
