/**
 * Gmail Sync — Low-level Gmail API operations
 *
 * Fetch messages, parse headers/bodies, extract attachments.
 * Ported from rubies-utilities/scripts/update-sales-leads.js.
 */

const { OUR_ADDRESS } = require('../config');

// ---------------------------------------------------------------------------
// Header / body parsing
// ---------------------------------------------------------------------------

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractAddress(headerValue) {
  if (!headerValue) return '';
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).toLowerCase().trim();
}

function extractName(headerValue) {
  if (!headerValue) return '';
  const match = headerValue.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : '';
}

function parseAddressList(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(',').map(addr => extractAddress(addr)).filter(Boolean);
}

/**
 * Strip quoted/replied content from an email body.
 * Keeps only the new content in this message.
 */
function stripQuotedContent(body) {
  if (!body || typeof body !== 'string') return body;
  const lines = body.split(/\r?\n/);
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = i < lines.length - 1 ? lines[i + 1] : '';

    // Gmail/Apple: "On Mon, Jan 6, Jane wrote:"
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    // Gmail multi-line: "On Tue, Feb 10, 2026 at 1:33 PM Name <email>" + "wrote:"
    if (/^On .+<[^>]+>\s*$/i.test(line.trim()) && /^wrote:\s*$/i.test(nextLine.trim())) break;
    if (/^On\s+.+@.+$/i.test(line.trim()) && /^wrote:\s*$/i.test(nextLine.trim())) break;
    // Outlook
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(line)) break;
    if (line.trim() === '-----Original Message-----') break;
    // Underscore separator
    if (/^_{5,}$/.test(line)) break;
    // Outlook "From: ... Sent: ..."
    if (i > 0 && /^From:\s+/i.test(line) && /Sent:\s+/i.test(lines.slice(i, i + 4).join(' '))) break;
    // Quoted lines
    if (line.trim().startsWith('>')) break;

    result.push(line);
  }

  return result.join('\n').trim();
}

/**
 * Extract plain text body from a Gmail message payload.
 */
function extractBody(payload) {
  function extractTextFromParts(parts) {
    let plainText = '';
    let htmlText = '';
    if (!parts || !Array.isArray(parts)) return { plainText, htmlText };

    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plainText += Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlText += Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.parts) {
        const nested = extractTextFromParts(part.parts);
        if (nested.plainText) plainText += nested.plainText;
        if (nested.htmlText) htmlText += nested.htmlText;
      }
    }
    return { plainText, htmlText };
  }

  let body = '';
  if (payload.parts) {
    const extracted = extractTextFromParts(payload.parts);
    body = extracted.plainText;
    if (!body && extracted.htmlText) {
      body = htmlToText(extracted.htmlText);
    }
  } else if (payload.body && payload.body.data) {
    const raw = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    body = payload.mimeType === 'text/html' ? htmlToText(raw) : raw;
  }

  return stripQuotedContent(body);
}

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract attachment metadata from payload (without downloading content).
 */
function extractAttachments(payload) {
  const attachments = [];
  function walk(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body ? part.body.size : 0,
          attachmentId: part.body ? part.body.attachmentId : null,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(payload.parts);
  return attachments;
}

/**
 * Detect auto-replies from headers.
 */
function isAutoReply(headers) {
  const autoSubmitted = getHeader(headers, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = getHeader(headers, 'Precedence');
  if (['bulk', 'junk', 'list'].includes(precedence?.toLowerCase())) return true;
  const xAutoResponse = getHeader(headers, 'X-Autoreply');
  if (xAutoResponse) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Gmail API operations
// ---------------------------------------------------------------------------

/**
 * List message IDs with optional query, paginating through all results.
 * Returns array of { id, threadId }.
 */
async function listMessages(gmail, { query, maxResults = Infinity, afterDate } = {}) {
  const messages = [];
  let pageToken = null;
  let q = query || '';
  if (afterDate) {
    const dateStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');
    q = q ? `${q} after:${dateStr}` : `after:${dateStr}`;
  }

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      maxResults: Math.min(500, maxResults - messages.length),
      pageToken,
      q: q || undefined,
    });
    if (res.data.messages) {
      messages.push(...res.data.messages);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && messages.length < maxResults);

  return messages;
}

/**
 * Fetch full message content and parse into our schema shape.
 */
async function fetchMessage(gmail, messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = res.data.payload.headers;
  const fromRaw = getHeader(headers, 'From');
  const fromAddr = extractAddress(fromRaw);
  const bodyText = extractBody(res.data.payload);
  const attachments = extractAttachments(res.data.payload);

  return {
    gmail_message_id: res.data.id,
    gmail_thread_id: res.data.threadId,
    subject: getHeader(headers, 'Subject') || '(no subject)',
    from_address: fromAddr,
    from_name: extractName(fromRaw),
    to_addresses: parseAddressList(getHeader(headers, 'To')),
    cc_addresses: parseAddressList(getHeader(headers, 'Cc')),
    date: new Date(parseInt(res.data.internalDate)).toISOString(),
    body_text: bodyText,
    labels: res.data.labelIds || [],
    is_sent: fromAddr === OUR_ADDRESS || fromAddr.endsWith('@rubyshines.com') || (res.data.labelIds || []).includes('SENT'),
    has_attachments: attachments.length > 0,
    attachment_meta: attachments.length > 0 ? attachments : null,
    is_auto_reply: isAutoReply(headers),
    word_count: bodyText ? bodyText.split(/\s+/).filter(w => w.length > 0).length : 0,
    raw_size_bytes: res.data.sizeEstimate || 0,
  };
}

/**
 * Fetch multiple messages in parallel (batched to avoid rate limits).
 */
async function fetchMessages(gmail, messageIds, { batchSize = 20, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map(id => fetchMessage(gmail, id).catch(err => {
        console.error(`  Failed to fetch ${id}: ${err.message}`);
        return null;
      }))
    );
    results.push(...fetched.filter(Boolean));
    if (onProgress) onProgress(results.length, messageIds.length);
  }
  return results;
}

module.exports = {
  listMessages,
  fetchMessage,
  fetchMessages,
  stripQuotedContent,
  extractBody,
  getHeader,
  extractAddress,
  extractName,
};
