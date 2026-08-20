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
  html = html.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
    // A URL that ends a sentence must not swallow the full stop. Gmail renders
    // the href verbatim, so "…/1Hq93BSiPrhJkgfB8." is a dead link — which is
    // exactly what happened to the onboarding survey link in a partner email.
    // Trailing sentence punctuation is put back OUTSIDE the anchor.
    const m = url.match(/^(.*?)([.,;:!?]+)$/);
    const href = m ? m[1] : url;
    const trailing = m ? m[2] : '';
    return `<a href="${href}">${href}</a>${trailing}`;
  });
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
 * RFC 2047 encode a filename if it has non-ASCII, so an org name with an
 * accent doesn't produce a mangled attachment name. Pure.
 */
function encodeFilename(name) {
  const s = String(name || 'attachment');
  if (/^[\x20-\x7e]*$/.test(s)) return `"${s.replace(/"/g, '')}"`;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** One or many addresses → a header value. Drops blanks and dedupes. Pure. */
function addressList(v) {
  const list = (Array.isArray(v) ? v : [v])
    .flatMap(x => String(x || '').split(','))
    .map(x => x.trim())
    .filter(Boolean);
  return [...new Set(list.map(x => x.toLowerCase()))]
    .map(lower => list.find(x => x.toLowerCase() === lower))
    .join(', ');
}

/**
 * Build the RFC822 message, base64url-encoded for gmail.users.messages.send.
 *
 * Without attachments: multipart/alternative (plain + HTML).
 * With attachments: multipart/mixed wrapping that alternative part, then one
 * base64 part per file — the standard nesting, so clients still show the HTML
 * body rather than treating everything as a file list.
 *
 * @param to          one address, or several (array or comma string)
 * @param cc          copied recipients, same shape
 * @param attachments [{ filename, mimeType, content: Buffer }]
 */
function buildRawMessage({ to, cc, subject, body: rawBody, inReplyTo, references, message_type, attachments = [] }) {
  const body = normalizeSignature(rawBody);
  const introLink = INTRO_LINK_TYPES.has(message_type);
  const seed = `${Buffer.from(subject || 'm').toString('hex').slice(0, 12)}-${(body || '').length.toString(36)}`;
  const altBoundary = `b2b-alt-${seed}`;
  const mixedBoundary = `b2b-mix-${seed}`;
  const hasFiles = Array.isArray(attachments) && attachments.length > 0;
  const ccLine = addressList(cc);

  const headers = [
    `From: Jamie Alexander <${FROM_EMAIL}>`,
    `To: ${addressList(to)}`,
  ];
  // Org threads routinely carry a second person (a colleague who handles
  // ordering, a director copied for sign-off). Replying to only the sender
  // silently drops them from a conversation they were part of.
  if (ccLine) headers.push(`Cc: ${ccLine}`);
  headers.push(
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    hasFiles
      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
  );
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const alternative = `--${altBoundary}\r\n`
    + 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
    + body + '\r\n\r\n'
    + `--${altBoundary}\r\n`
    + 'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
    + `<div>${toHtmlBody(body, { introLink })}</div>\r\n\r\n`
    + `--${altBoundary}--\r\n`;

  let raw = headers.join('\r\n') + '\r\n\r\n';
  if (!hasFiles) {
    raw += alternative;
  } else {
    raw += `--${mixedBoundary}\r\n`
      + `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`
      + alternative + '\r\n';
    for (const a of attachments) {
      const b64 = Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content || '').toString('base64');
      raw += `--${mixedBoundary}\r\n`
        + `Content-Type: ${a.mimeType || 'application/octet-stream'}; name=${encodeFilename(a.filename)}\r\n`
        + `Content-Disposition: attachment; filename=${encodeFilename(a.filename)}\r\n`
        + 'Content-Transfer-Encoding: base64\r\n\r\n'
        // 76-char lines per RFC 2045; some servers reject longer ones.
        + (b64.match(/.{1,76}/g) || []).join('\r\n') + '\r\n\r\n';
    }
    raw += `--${mixedBoundary}--\r\n`;
  }
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Resolve the recipient for a company: primary active contact, else general_email.
 *
 * Ordering past is_primary is load-bearing, not cosmetic. Twenty companies carry
 * more than one active primary (the imports set the flag freely, and merging
 * duplicate rows pools their contacts), and `order(is_primary).limit(1)` alone
 * lets Postgres return whichever row it likes. Oasis had both a stale address
 * and the successor a human explicitly handed us as the new contact, both
 * primary, so who received the email was down to row order. Break the tie on
 * evidence of a real correspondence, then on email for determinism, so the same
 * company always resolves to the same person.
 */
async function resolveRecipient(sb, companyId) {
  const { data: contacts, error } = await sb.from('b2b_contacts')
    .select('email, full_name, is_primary, is_active, message_count, last_seen_at')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('message_count', { ascending: false, nullsFirst: false })
    .order('last_seen_at', { ascending: false, nullsFirst: false })
    .order('email', { ascending: true })
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
 * The delivery decision itself, as a pure function so the send path (one
 * company, authoritative) and the queue build (all companies, bulk) can never
 * disagree about how a company is reachable. Pure.
 */
function deliveryMode({ hasContact, generalEmail, contactFormUrl }) {
  if (hasContact || generalEmail) return 'email';
  if (contactFormUrl) return 'form';
  return 'none';
}

/**
 * How we can actually reach this company. DERIVED, never stored: an email on
 * file always wins, so adding a contact later silently upgrades a form company
 * to email without anything needing to be un-flagged.
 *
 *   { mode: 'email', email, name, via }  — normal send
 *   { mode: 'form', url }                — no address published; the operator
 *                                          submits the draft through their form
 *   { mode: 'none' }                     — unreachable; nothing should draft
 *
 * Small orgs often publish only a form, and a form is usually the channel they
 * actually monitor. Guessing `info@` instead would risk a bounce against
 * rubyshines.com, the same sending reputation Klaviyo depends on.
 */
async function resolveDelivery(sb, companyId) {
  const recipient = await resolveRecipient(sb, companyId);
  const { data: company, error } = await sb.from('b2b_companies')
    .select('contact_form_url').eq('id', companyId).maybeSingle();
  if (error) throw new Error(`company lookup: ${error.message}`);

  const mode = deliveryMode({
    hasContact: !!recipient,
    contactFormUrl: company?.contact_form_url,
  });
  if (mode === 'email') return { mode, ...recipient };
  if (mode === 'form') return { mode, url: company.contact_form_url };
  return { mode: 'none' };
}

/**
 * sendB2bEmail — see module doc.
 * @param {object} p { company_id, thread_id?, message_type, variant_id?,
 *                     subject?, body, confirmed? }
 */
async function sendB2bEmail(p = {}) {
  const { company_id, thread_id, message_type, variant_id, body, confirmed, next_touch_days, attachments, cc, to_override, test_send } = p;
  if (!company_id) throw new Error('company_id required');
  if (!message_type) throw new Error('message_type required');
  if (!body || !body.trim()) throw new Error('body required');

  const sb = getSupabaseClient();
  // An explicit To wins over the resolved contact: the operator may be
  // answering a person who is not the primary contact, or correcting a bad
  // record from the panel without editing the contact first.
  const delivery = to_override
    ? { mode: 'email', email: addressList(to_override), name: null, via: 'operator' }
    : await resolveDelivery(sb, company_id);
  // Fail closed before the gate, not at the Gmail call: this company publishes
  // no address, so there is nothing to send TO. The draft is still good — it
  // goes through their form, by hand, from the panel.
  if (delivery.mode === 'form') {
    return {
      ok: false,
      phase: 'manual',
      form_url: delivery.url,
      error: `${company_id} publishes no email address, only a contact form. Submit the draft at ${delivery.url} — the panel has a copy button. Nothing was sent.`,
    };
  }
  if (delivery.mode === 'none') {
    return { ok: false, error: `No active contact, general_email, or contact form for ${company_id} — fix the contact record first.` };
  }
  const recipient = delivery;

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

  // ---- TEST SEND -----------------------------------------------------------
  // The real email — same body, same HTML, same attachments — addressed to
  // ourselves, so it can be read in a mail client before a partner sees it.
  //
  // It writes NOTHING: no thread, no b2b_messages row, no cadence dates, no
  // draft status change. A test that left a footprint on the relationship
  // record would be worse than no test at all.
  //
  // Deliberately NOT behind the send gate: the gate exists to stop mail
  // reaching organizations, and this can only reach jamie@rubyshines.com. That
  // is exactly the check you want available BEFORE go-live.
  if (test_send) {
    const { getGmail: getTestGmail } = require('../../gmail-management/lib/gmailClient');
    const testGmail = await getTestGmail();
    const testBody = normalizeSignature(body);
    const raw = buildRawMessage({
      to: FROM_EMAIL,
      subject: `[TEST] ${subject || '(no subject)'}`,
      body: testBody,
      message_type,
      attachments,
      // No threading: a test must not attach itself to the real conversation.
    });
    const res = await testGmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return {
      ok: true,
      phase: 'test_sent',
      to: FROM_EMAIL,
      gmail_message_id: res.data.id,
      would_send_to: recipient?.email || null,
      would_cc: addressList(cc) || null,
      attachments: (attachments || []).map(a => a.filename),
      note: 'Sent to you only. Nothing was recorded against the company, and the draft is still pending.',
    };
  }

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
  const raw = buildRawMessage({ to: recipient.email, cc, subject, body: sentBody, inReplyTo, references: inReplyTo, message_type, attachments });
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

  // Cadence bookkeeping. Answering them IS the thing an On Me claim was for, so
  // sending clears it — the alternative is a list that only ever grows, cleared
  // by a second deliberate click nobody makes once the real work is done.
  // Snooze and pause are untouched: a send during either is one deliberate
  // message, not a decision to resume chasing.
  await sb.from('b2b_companies').update({
    last_outbound_at: sentAt,
    next_action_date: nextActionDateAfterSend(message_type, new Date(sentAt), next_touch_days ?? null),
    on_me_at: null,
    on_me_note: null,
    updated_at: sentAt,
  }).eq('id', company_id);

  return { ok: true, phase: 'sent', gmail_message_id: gmailMessageId, gmail_thread_id: gmailThreadId, thread_id: threadRowId, to: recipient.email, sent_at: sentAt };
}

module.exports = { sendB2bEmail, buildRawMessage, toHtmlBody, normalizeSignature, resolveRecipient, resolveDelivery, deliveryMode, addressList, encodeSubject, FROM_EMAIL, SEND_FLAG };
