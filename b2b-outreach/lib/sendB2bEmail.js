/**
 * sendB2bEmail.js — the outreach engine's ONLY outbound path (Design #6).
 *
 * Two-phase, like every order tool:
 *   Phase 1 (no `confirmed`): resolve recipient + render preview. Never sends.
 *   Phase 2 (`confirmed: true`): HARD-GATED on the `b2b_send_enabled` system
 *     flag (default OFF — flipping it is a Jamie-only go-live act). Sends via
 *     Gmail API as jamie@rubyshines.com with proper threading headers, then
 *     writes the b2b_messages row (the ONLY writer of outbound rows — never
 *     Gmail-sync, per the draft-checkpoint dedupe rule), updates b2b_drafts /
 *     b2b_companies cadence fields.
 *
 * Agent-agnostic: callable by either B2B advisor, the operator console, or MCP.
 */
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { isFlagEnabled } = require('../../shared/systemFlags');
const { nextActionDateAfterSend } = require('./cadence');

const FROM_EMAIL = 'jamie@rubyshines.com';
const SEND_FLAG = 'b2b_send_enabled';

/** RFC 2047 encode a subject if it has non-ASCII. */
function encodeSubject(subject) {
  if (!subject || /^[\x20-\x7e]*$/.test(subject)) return subject || '';
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

// One signature convention everywhere — same source of truth as CS emails.
const { SIGNATURE_NAME, SITE_URL, SITE_LABEL } = require('../../customer-service/lib/signatures');

// Message types where the email is INTRODUCING the brand — only these get the
// first-mention RUBIES link in the body. Established relationships know us.
const INTRO_LINK_TYPES = new Set(['intro_outreach', 'intro_pitch', 'affiliate_intro', 'inbound_inquiry_response']);

/**
 * Ensure the CS signature convention: "Jamie Alexander, RUBIES Founder" is
 * followed by a rubyshines.com line (linked in the HTML part). Appended at
 * send time when the advisor didn't write it, so both MIME parts agree. Pure.
 */
function normalizeSignature(text) {
  const body = String(text || '');
  if (!body.includes(SIGNATURE_NAME)) return body;
  const sigLineRe = new RegExp(`${SIGNATURE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\r?\\n(https?:\\/\\/)?(www\\.)?rubyshines\\.com)?`);
  return body.replace(sigLineRe, (m, hasSite) => hasSite ? m : `${SIGNATURE_NAME}\n${SITE_LABEL}`);
}

/**
 * Plain text → minimal personal-looking HTML: escaped, URLs + rubyshines.com
 * linkified, line breaks preserved. When `introLink` (brand-introduction
 * message types), the FIRST standalone body mention of "RUBIES" also links to
 * the store — the signature's "RUBIES Founder" never counts. Pure.
 */
function toHtmlBody(text, { introLink = false } = {}) {
  let html = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => `<a href="${url}">${url}</a>`);
  html = html.replace(/(^|[\s>])((www\.)?rubyshines\.com)(?![\w.\/])/g, (m, pre, dom) => `${pre}<a href="${SITE_URL}">${dom}</a>`);
  if (introLink) {
    let linked = false;
    html = html.replace(/\bRUBIES\b(?! Founder)/g, (m) => {
      if (linked) return m;
      linked = true;
      return `<a href="${SITE_URL}">RUBIES</a>`;
    });
  }
  return html.replace(/\r?\n/g, '<br>\r\n');
}

/**
 * Build the RFC822 message, base64url-encoded for gmail.users.messages.send.
 * multipart/alternative: the advisor's plain text verbatim + a minimal HTML
 * part so links (incl. the first RUBIES mention) are clickable.
 */
function buildRawMessage({ to, subject, body: rawBody, inReplyTo, references, message_type }) {
  const body = normalizeSignature(rawBody);
  const introLink = INTRO_LINK_TYPES.has(message_type);
  const boundary = `b2b-${Buffer.from(subject || 'm').toString('hex').slice(0, 12)}-${(body || '').length.toString(36)}`;
  const headers = [
    `From: Jamie Alexander <${FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  const raw = headers.join('\r\n') + '\r\n\r\n'
    + `--${boundary}\r\n`
    + 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
    + body + '\r\n\r\n'
    + `--${boundary}\r\n`
    + 'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
    + `<div>${toHtmlBody(body, { introLink })}</div>\r\n\r\n`
    + `--${boundary}--\r\n`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Resolve the recipient for a company: primary active contact, else general_email. */
async function resolveRecipient(sb, companyId) {
  const { data: contacts, error } = await sb.from('b2b_contacts')
    .select('email, full_name, is_primary, is_active')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .limit(1);
  if (error) throw new Error(`contact lookup: ${error.message}`);
  if (contacts?.length) return { email: contacts[0].email, name: contacts[0].full_name || null, via: 'contact' };

  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('general_email').eq('id', companyId).maybeSingle();
  if (cErr) throw new Error(`company lookup: ${cErr.message}`);
  if (company?.general_email) return { email: company.general_email, name: null, via: 'general_email' };
  return null;
}

/**
 * sendB2bEmail — see module doc.
 * @param {object} p { company_id, thread_id?, message_type, variant_id?,
 *                     subject?, body, confirmed? }
 */
async function sendB2bEmail(p = {}) {
  const { company_id, thread_id, message_type, variant_id, body, confirmed, next_touch_days } = p;
  if (!company_id) throw new Error('company_id required');
  if (!message_type) throw new Error('message_type required');
  if (!body || !body.trim()) throw new Error('body required');

  const sb = getSupabaseClient();
  const recipient = await resolveRecipient(sb, company_id);
  if (!recipient) {
    return { ok: false, error: `No active contact or general_email for ${company_id} — fix the contact record first.` };
  }

  // Thread context (reply headers + subject inheritance)
  let thread = null;
  if (thread_id) {
    const { data, error } = await sb.from('b2b_threads').select('*').eq('id', thread_id).maybeSingle();
    if (error) throw new Error(`thread lookup: ${error.message}`);
    thread = data;
  }
  let subject = p.subject || (thread?.subject ? (thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`) : null);
  if (!subject) return { ok: false, error: 'subject required for a new thread' };

  // Last outbound/inbound message in the thread → In-Reply-To / References.
  // gmail_message_id is the Gmail API id, NOT an RFC 2822 Message-ID —
  // wrapping it in <> produced a bogus In-Reply-To that broke recipient-side
  // threading (Gmail-side threading still worked via the threadId param).
  // Fetch the real Message-ID header from the Gmail API instead.
  let inReplyTo = null;
  if (thread) {
    const { data: lastMsg } = await sb.from('b2b_messages')
      .select('gmail_message_id')
      .eq('thread_id', thread.id)
      .not('gmail_message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastMsg?.gmail_message_id) {
      try {
        const { getGmail: getGmailForHeaders } = require('../../gmail-management/lib/gmailClient');
        const gmailMeta = await getGmailForHeaders();
        const meta = await gmailMeta.users.messages.get({
          userId: 'me',
          id: lastMsg.gmail_message_id,
          format: 'metadata',
          metadataHeaders: ['Message-ID'],
        });
        const header = (meta.data.payload?.headers || []).find(h => (h.name || '').toLowerCase() === 'message-id');
        if (header?.value) inReplyTo = header.value; // already includes <...>
      } catch (e) {
        console.warn(`[sendB2bEmail] Message-ID lookup failed (${e.message}) — sending without In-Reply-To`);
      }
    }
  }

  const preview = {
    ok: true,
    phase: 'preview',
    to: recipient.email,
    to_name: recipient.name,
    resolved_via: recipient.via,
    from: FROM_EMAIL,
    subject,
    body,
    message_type,
    variant_id: variant_id || null,
    thread_id: thread?.id || null,
    threading: inReplyTo ? `reply (In-Reply-To ${inReplyTo})` : 'new thread',
  };

  if (!confirmed) return preview;

  // ---- PHASE 2: the gate ---------------------------------------------------
  if (!(await isFlagEnabled(SEND_FLAG))) {
    return {
      ok: false,
      phase: 'blocked',
      error: `B2B sending is disabled (system flag '${SEND_FLAG}' is off). Preview above is what WOULD send. Go-live is a Jamie decision in a cowork session.`,
      preview,
    };
  }

  // Send via Gmail API (gmail.modify scope covers send)
  const { getGmail } = require('../../gmail-management/lib/gmailClient');
  const gmail = await getGmail();
  const sentBody = normalizeSignature(body);
  const raw = buildRawMessage({ to: recipient.email, subject, body: sentBody, inReplyTo, references: inReplyTo, message_type });
  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, ...(thread?.gmail_thread_id ? { threadId: thread.gmail_thread_id } : {}) },
  });
  const gmailMessageId = sendRes.data.id;
  const gmailThreadId = sendRes.data.threadId;
  const sentAt = new Date().toISOString();

  // Ensure thread row
  let threadRowId = thread?.id || null;
  if (!threadRowId) {
    const { data: newThread, error: tErr } = await sb.from('b2b_threads').insert({
      company_id, thread_type: 'intro', subject, gmail_thread_id: gmailThreadId,
      last_message_at: sentAt,
    }).select('id').single();
    if (tErr) throw new Error(`thread insert: ${tErr.message}`);
    threadRowId = newThread.id;
  } else {
    await sb.from('b2b_threads').update({
      gmail_thread_id: thread.gmail_thread_id || gmailThreadId,
      last_message_at: sentAt,
    }).eq('id', threadRowId);
  }

  // The ONLY outbound b2b_messages writer (dedupe rule)
  const { error: mErr } = await sb.from('b2b_messages').insert({
    thread_id: threadRowId, company_id, direction: 'outbound', message_type,
    variant_id: variant_id || null, gmail_message_id: gmailMessageId,
    gmail_thread_id: gmailThreadId, in_reply_to: inReplyTo,
    from_email: FROM_EMAIL, to_email: recipient.email, body_text: sentBody,
    sent_at: sentAt, source: 'send_tool',
  });
  if (mErr) console.error(`[sendB2bEmail] b2b_messages insert failed (sent ok): ${mErr.message}`);

  // Cadence bookkeeping
  await sb.from('b2b_companies').update({
    last_outbound_at: sentAt,
    next_action_date: nextActionDateAfterSend(message_type, new Date(sentAt), next_touch_days ?? null),
    updated_at: sentAt,
  }).eq('id', company_id);

  return { ok: true, phase: 'sent', gmail_message_id: gmailMessageId, gmail_thread_id: gmailThreadId, thread_id: threadRowId, to: recipient.email, sent_at: sentAt };
}

module.exports = { sendB2bEmail, buildRawMessage, toHtmlBody, normalizeSignature, resolveRecipient, encodeSubject, FROM_EMAIL, SEND_FLAG };
