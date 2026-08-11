/**
 * Gorgias REST API client — read + write operations.
 *
 * Auth: HTTP Basic (email:api_key) or Bearer token.
 * Base URL: https://{domain}.gorgias.com/api
 *
 * Rate limiting: apiFetch retries on 429 up to 5 attempts. Honors the
 * `Retry-After` response header (seconds, capped at 30s) when Gorgias
 * sends one; falls back to exponential backoff (1s, 2s, 4s, 8s) otherwise.
 * No preemptive pacing — interactive callers (dashboard, webhooks) stay
 * fast; bursty batch callers self-throttle when they hit the wall.
 *
 * Transient failures: 5xx and network-level errors are retried on the same
 * backoff, but only for reads. A write that 5xx'd may already have applied
 * (a created ticket, a sent reply), so retrying it risks emailing a customer
 * twice — writes still retry on 429, which means Gorgias rejected the request
 * before running it. Same reasoning as lib/shopify.js.
 *
 * Docs: https://developers.gorgias.com/reference
 */

const GORGIAS_API_VERSION = ''; // No versioning needed for current endpoints

const MAX_ATTEMPTS = 5;
// Overridable so tests don't sit through real backoff.
const RETRY_BASE_MS = Number(process.env.GORGIAS_RETRY_BASE_MS) || 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);

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

let _retryCount = 0;
function getRetryCount() { return _retryCount; }
function resetRetryCount() { _retryCount = 0; }

async function apiFetch(path, options = {}) {
  const config = getConfig();
  const url = `${config.baseUrl}${path}`;
  const isRead = SAFE_METHODS.has((options.method || 'GET').toUpperCase());

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Basic ${config.auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...options.headers,
        },
      });
    } catch (err) {
      // Network-level failure (fetch failed, ECONNRESET). The request may have
      // reached Gorgias and applied, so only reads retry.
      if (!isRead || isLastAttempt) throw err;
      _retryCount++;
      console.error(`[Gorgias] network error on ${path} (attempt ${attempt + 1}): ${err.message}, retrying...`);
      await delay(RETRY_BASE_MS * Math.pow(2, attempt));
      continue;
    }

    if (response.ok) return response.json();

    if (response.status === 429 && !isLastAttempt) {
      _retryCount++;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const waitMs = retryAfter != null
        ? Math.min(retryAfter * 1000, 30000)
        : RETRY_BASE_MS * Math.pow(2, attempt);
      await delay(waitMs);
      continue;
    }

    // Gorgias 502/503s on the views endpoint often enough that a single blip
    // used to abort the whole daily reconciliation (and with it the follow-up
    // sweep, which is the only engine for snooze-expiry follow-ups).
    if (response.status >= 500 && isRead && !isLastAttempt) {
      _retryCount++;
      console.error(`[Gorgias] ${response.status} on ${path} (attempt ${attempt + 1}), retrying...`);
      await delay(RETRY_BASE_MS * Math.pow(2, attempt));
      continue;
    }

    // Truncated: a Gorgias 5xx returns a full HTML error page, which otherwise
    // lands verbatim in the daily digest.
    const errText = (await response.text()).slice(0, 300);
    throw new Error(`Gorgias API error ${response.status} on ${path}: ${errText}`);
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, (dateMs - Date.now()) / 1000);
  return null;
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
 * Fetch ALL messages for a specific ticket, oldest first.
 *
 * Paginates via the cursor like getViewItems — the old single 50-message page
 * silently returned only the OLDEST 50, so "did the customer reply?" checks
 * that read messages[length-1] looked at message #50, not the latest one.
 * MAX_PAGES bounds a pathological thread (500 messages) without truncating
 * any real conversation.
 */
async function getTicketMessages(ticketId) {
  const MAX_PAGES = 10;
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams();
    params.set('limit', '50');
    params.set('order_by', 'created_datetime:asc');
    if (cursor) params.set('cursor', cursor);
    const result = await apiFetch(`/tickets/${ticketId}/messages?${params}`);
    if (result.data) all.push(...result.data);
    cursor = result.meta?.next_cursor || null;
    pages++;
    if (cursor && pages < MAX_PAGES) await delay(300);
  } while (cursor && pages < MAX_PAGES);
  return all;
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
 * Find non-closed Gorgias tickets for a customer email created within the last
 * `withinMinutes` minutes. Used by Gmail intake to avoid creating a duplicate
 * ticket when Gorgias's native email integration has already ingested the same
 * email.
 */
async function findOpenTicketsByEmail(email, { withinMinutes = 10, limit = 10 } = {}) {
  if (!email) return [];
  const customers = await apiFetch(`/customers?email=${encodeURIComponent(email)}`);
  const customerId = customers.data?.[0]?.id;
  if (!customerId) return [];
  const result = await apiFetch(`/tickets?customer_id=${customerId}&order_by=created_datetime:desc&limit=${limit}`);
  const cutoff = Date.now() - withinMinutes * 60 * 1000;
  return (result.data || []).filter(t => {
    if (t.status === 'closed') return false;
    const created = new Date(t.created_datetime).getTime();
    return created >= cutoff;
  });
}

/**
 * Find an existing Gorgias customer by email, or create one. Returns the customer object.
 */
async function findOrCreateCustomer({ email, name }) {
  if (!email) throw new Error('findOrCreateCustomer requires an email');
  const existing = await apiFetch(`/customers?email=${encodeURIComponent(email)}`);
  if (existing.data?.[0]?.id) return existing.data[0];
  return apiFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: name || email,
      channels: [{ type: 'email', address: email }],
    }),
  });
}

/**
 * Re-point a ticket's customer (requester) to a different person. Used when a ticket
 * was created from a customer email forwarded to us by internal RUBIES staff — Gorgias
 * sets the requester to the forwarder, so replies (and the ticket's identity) would
 * otherwise go back to staff instead of the original sender. Finds/creates the target
 * customer and PUTs the ticket. Returns the updated ticket.
 */
async function setTicketCustomer(ticketId, { email, name }) {
  const customer = await findOrCreateCustomer({ email, name });
  if (!customer?.id) throw new Error(`Could not resolve Gorgias customer for ${email}`);
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ customer: { id: customer.id } }),
  });
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
 * Create a new ticket whose first message is OUTBOUND from us to the customer.
 * Gorgias delivers the email. Use for proactive outreach (incident notifications,
 * feedback campaigns, etc.) where there's no existing thread to reply to.
 *
 * Contrast with createTicket() above, which creates an inbound-style ticket
 * (used by Gmail import to replay customer messages into Gorgias).
 */
async function createOutboundTicket({ customerEmail, customerName, subject, bodyHtml, bodyText, tags = [] }) {
  const senderEmail = process.env.GORGIAS_SENDER_EMAIL || 'care@rubyshines.com';
  const senderName = process.env.GORGIAS_SENDER_NAME || 'RUBIES Customer Care';
  const html = bodyHtml || `<p>${(bodyText || '').replace(/\n/g, '<br>')}</p>`;

  const message = {
    channel: 'email',
    via: 'api',
    from_agent: true,
    source: {
      type: 'email',
      from: { name: senderName, address: senderEmail },
      to: [{ name: customerName || '', address: customerEmail }],
    },
    body_html: html,
    body_text: bodyText || '',
  };

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
async function createTicketReply(ticketId, { body_html, body_text, attachments, senderId, ticket: providedTicket }) {
  const html = body_html || `<p>${(body_text || '').replace(/\n/g, '<br>')}</p>`;
  // Look up sender info from the ticket (skip if caller passed it in)
  const ticket = providedTicket || await getTicket(ticketId);
  const ticketChannel = ticket.channel || 'email';
  const senderEmail = process.env.GORGIAS_SENDER_EMAIL || 'care@rubyshines.com';
  const senderName = process.env.GORGIAS_SENDER_NAME || 'RUBIES Customer Care';
  const payload = {
    channel: ticketChannel,
    via: 'api',
    from_agent: true,
    sender: { id: senderId || ticket.assignee_user?.id || undefined },
    body_html: html,
    body_text: body_text || '',
  };
  // Chat/offline-capture tickets: customer left the chat widget, so replies must go via email.
  // Force channel to email when the customer has an email address on file.
  if (ticketChannel !== 'email' && ticket.customer?.email) {
    payload.channel = 'email';
  }
  // Email (or forced-to-email) channels need explicit from/to addresses in source
  if (payload.channel === 'email') {
    payload.source = {
      type: 'email',
      from: { name: senderName, address: senderEmail },
      to: [{ name: ticket.customer?.name || '', address: ticket.customer?.email || '' }],
    };
  }
  // Gorgias requires http/https URLs — caller must pre-upload to storage
  // and pass { url, name, content_type, size } objects (see resolveAttachmentsForGorgias in server.js)
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({
      url: a.url,
      name: a.name,
      content_type: a.content_type,
      size: a.size,
    }));
  }
  return apiFetch(`/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
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
 * Close a ticket. Also clears any pending snooze — otherwise Gorgias
 * will reopen the ticket when the snooze timer expires.
 */
async function closeTicket(ticketId) {
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'closed', snooze_datetime: null }),
  });
}

/**
 * Reopen a ticket — set status back to open and clear any snooze.
 */
async function reopenTicket(ticketId) {
  return apiFetch(`/tickets/${ticketId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'open', snooze_datetime: null }),
  });
}

async function deleteTicket(ticketId) {
  const config = getConfig();
  const url = `${config.baseUrl}/tickets/${ticketId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Basic ${config.auth}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gorgias API error ${response.status} on DELETE /tickets/${ticketId}: ${errText}`);
  }
  // DELETE may return 204 No Content
  if (response.status === 204) return {};
  return response.json();
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
  findOpenTicketsByEmail,
  getViewItems,
  getMacros,
  getTags,
  getUsers,
  findUser,
  // Write
  findOrCreateCustomer,
  setTicketCustomer,
  createTicket,
  createOutboundTicket,
  createTicketReply,
  addTicketMessage,
  addInternalNote,
  addTicketTag,
  assignTicket,
  snoozeTicket,
  closeTicket,
  reopenTicket,
  deleteTicket,
  // Utilities
  stripHtml,
  delay,
  getRetryCount,
  resetRetryCount,
};
