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
const { resolveNextActionDate, withoutStatedNextTouch } = require('./cadence');
const { defaultReplyCc, splitAddresses } = require('./replyCc');

const FROM_EMAIL = 'jamie@rubyshines.com';
const SEND_FLAG = 'b2b_send_enabled';

/** RFC 2047 encode a subject if it has non-ASCII. */
function encodeSubject(subject) {
  if (!subject || /^[\x20-\x7e]*$/.test(subject)) return subject || '';
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

// One signature convention everywhere — same source of truth as CS emails.
const { SIGNATURE_NAME, SITE_URL, SIGNATURE_BLOCK_MD } = require('../../customer-service/lib/signatures');
// Same markdown-link grammar as CS mail, so a body written for one composer
// renders identically from the other; the plain-text flattener is shared too.
const { MD_LINK, markdownToPlainText } = require('../../customer-service/lib/autoLinker');

// Message types where the email is INTRODUCING the brand — only these get the
// first-mention RUBIES link in the body. Established relationships know us.
const INTRO_LINK_TYPES = new Set(['intro_outreach', 'intro_pitch', 'affiliate_intro', 'inbound_inquiry_response']);

/**
 * Ensure the CS signature convention: "Jamie Alexander, RUBIES Founder" is
 * followed by a rubyshines.com line linking to the store. Appended at send
 * time when the advisor didn't write it, in the same markdown-link form the CS
 * advisor signs with (`SIGNATURE_BLOCK_MD`), so both MIME parts agree: the
 * HTML part renders it as an anchor, the plain part flattens it back to the
 * bare domain. An existing site line, bare or linked, is left alone. Pure.
 */
function normalizeSignature(text) {
  const body = String(text || '');
  if (!body.includes(SIGNATURE_NAME)) return body;
  const name = SIGNATURE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bareSite = '(https?:\\/\\/)?(www\\.)?rubyshines\\.com';
  const linkedSite = `\\[${bareSite}\\]\\(https?:\\/\\/(www\\.)?rubyshines\\.com\\/?\\)`;
  const sigLineRe = new RegExp(`${name}(\\r?\\n(${linkedSite}|${bareSite}))?`);
  return body.replace(sigLineRe, (m, hasSite) => hasSite ? m : SIGNATURE_BLOCK_MD);
}

/**
 * Plain text → minimal personal-looking HTML: escaped, markdown links
 * ("[Onboarding Survey](https://…)") rendered as anchors on their label, bare
 * URLs + rubyshines.com linkified, line breaks preserved. When `introLink`
 * (brand-introduction message types), the FIRST standalone body mention of
 * "RUBIES" also links to the store — the signature's "RUBIES Founder" never
 * counts. Pure.
 */
function toHtmlBody(text, { introLink = false } = {}) {
  let html = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Markdown links are rendered first and parked behind placeholders, so the
  // bare-URL and rubyshines.com passes below cannot re-link the href or the
  // label and nest an anchor inside an anchor. Restored last.
  const anchors = [];
  html = html.replace(MD_LINK, (m, label, url) => {
    anchors.push(`<a href="${url}">${label}</a>`);
    return `\u0000${anchors.length - 1}\u0000`;
  });
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
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => anchors[Number(i)]);
  // Quoted lines ("> ...", the way rung 2 of the follow-up ladder quotes the
  // message it chases) become a blockquote with the marker stripped; the plain
  // part keeps the markers, which is ordinary mail quoting. A blank line either
  // side of the quote is absorbed — a block element already breaks the flow.
  const out = [];
  let quote = null;
  const flush = () => {
    if (!quote) return;
    if (out.length && out[out.length - 1] === '') out.pop();
    out.push(`<blockquote style="${QUOTE_STYLE}">${quote.join('<br>\r\n')}</blockquote>`);
    quote = null;
  };
  const lines = html.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^&gt;(?: ?(.*))?$/);
    if (m) { (quote ||= []).push(m[1] || ''); continue; }
    if (quote) {
      flush();
      if (lines[i] === '') continue;
    }
    out.push(lines[i]);
  }
  flush();
  // A block element already ends its line; a <br> straight after it would be a
  // second blank line the plain-text part does not have.
  return out.join('<br>\r\n').replace(/<\/blockquote><br>\r\n/g, '</blockquote>');
}

// Matches the CS follow-up's quote styling (customer-service/lib/followUp.js).
const QUOTE_STYLE = 'border-left: 3px solid #ccc; padding-left: 12px; margin: 16px 0; color: #555;';

/**
 * RFC 2047 encode a filename if it has non-ASCII, so an org name with an
 * accent doesn't produce a mangled attachment name. Pure.
 */
function encodeFilename(name) {
  const s = String(name || 'attachment');
  if (/^[\x20-\x7e]*$/.test(s)) return `"${s.replace(/"/g, '')}"`;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Gmail rejects a message over 25 MB, and that ceiling is on the ENCODED
 * message — base64 inflates every attachment by a third — so the raw bytes have
 * to stay under roughly 18 MB. Refusing here, with the numbers, beats letting
 * the operator hit Send and get an opaque API error back from Google.
 */
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;

/** Why these attachments cannot be sent, or null if they can. Pure. */
function attachmentSizeError(attachments, { max = MAX_ATTACHMENT_TOTAL_BYTES } = {}) {
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return null;
  const total = files.reduce((n, a) => n + (a?.content?.length || 0), 0);
  if (total <= max) return null;
  const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${files.length} attachment${files.length === 1 ? '' : 's'} total ${mb(total)}, over the ${mb(max)} `
    + `that fits in an email (Gmail's limit is 25 MB once encoded). Remove one, or send a link instead. `
    + `Largest: ${files.slice().sort((a, b) => (b?.content?.length || 0) - (a?.content?.length || 0))
      .slice(0, 2).map(a => `${a.filename} (${mb(a.content?.length || 0)})`).join(', ')}.`;
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

  // The plain part has no way to render a link, so markdown flattens to
  // "label (url)" — or just the label when it already says the URL, as the
  // signature's site line does.
  const alternative = `--${altBoundary}\r\n`
    + 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'
    + markdownToPlainText(body) + '\r\n\r\n'
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
/**
 * The panel writes "Ok, I just sent an invite for …" into the draft the moment a
 * slot is CLICKED, but only Book & Send actually creates the event — and the
 * ordinary Send button sits right beside it. On 2026-08-20 that sent a partner a
 * message promising an invite that did not exist, with nothing anywhere to catch
 * it. This is the deterministic backstop: a claim about a booked call has to be
 * backed by a booked call.
 *
 * Deliberately here rather than in the UI, because it also covers the console,
 * the MCP tool, and a draft sent after a page refresh (where the panel has
 * forgotten a slot was ever picked). `invite_created` is how scheduleMeeting
 * says "I made the event moments ago" — its b2b_meetings row is written after
 * this call, so the row cannot be the evidence on the legitimate path.
 */
const INVITE_CLAIM = /\bI (just sent an invite for|moved our call to)\b/i;

/**
 * A recipient verified undeliverable gets refused BEFORE the Gmail call: the
 * bounce it would produce is already on record, so sending anyway only spends
 * sender reputation to relearn it. Deliberately fail-open in every other case —
 * no verification row, a failed lookup, the table not yet migrated — because
 * unverified is the book's default state and blocking real mail over missing
 * infrastructure is worse than what this guards against. Bypass with
 * `allow_undeliverable: true` when the operator knows better (e.g. the mailbox
 * was just fixed and the stale verdict hasn't been re-probed).
 */
async function assertRecipientDeliverable(sb, toField) {
  const { fetchVerifications, isUndeliverable, normalizeEmail } = require('./emailVerify');
  const addresses = String(toField || '').split(',').map(normalizeEmail).filter(Boolean);
  if (!addresses.length) return null;
  const { byEmail } = await fetchVerifications(sb, addresses);
  const dead = addresses.filter(a => isUndeliverable(byEmail.get(a)));
  if (!dead.length) return null;
  const detail = dead.map(a => `${a} (${byEmail.get(a)?.reason || 'no reason recorded'}, verified ${byEmail.get(a)?.verified_at})`).join('; ');
  return {
    ok: false,
    phase: 'undeliverable_address',
    error: `Refusing to send: ${detail} is verified undeliverable. Fix the contact record `
      + '(b2b_update_contact), or re-send with allow_undeliverable: true if you know the mailbox works.',
  };
}

async function assertInviteClaimIsBacked(sb, { company_id, body }) {
  if (!INVITE_CLAIM.test(body || '')) return null;
  const { data, error } = await sb.from('b2b_meetings')
    .select('id, starts_at')
    .eq('company_id', company_id)
    .eq('status', 'booked')
    .gte('starts_at', new Date().toISOString())
    .limit(1);
  if (error) return null; // never block a send on a failed lookup
  if (data?.length) return null;
  return {
    ok: false,
    phase: 'unbacked_invite_claim',
    error: 'This message says you just sent an invite, but no meeting is booked for '
      + `${company_id}. Use "Book & Send" in the Schedule panel so the event is actually created, `
      + 'or remove that sentence. (If you booked it by hand in Google Calendar, re-send with '
      + 'allow_unbacked_invite_claim: true.)',
  };
}

async function sendB2bEmail(p = {}) {
  const { company_id, thread_id, message_type, variant_id, body, confirmed, next_touch_days, attachments, cc, to_override, test_send, invite_created, allow_unbacked_invite_claim, completes_commitment_id } = p;
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

  // Cc: a reply is a conversation with everyone on it. When the caller says
  // nothing about cc (undefined/null) and this is a thread reply, default to
  // reply-all from the stored conversation so a cc'd colleague is never
  // silently dropped. An explicit empty string means "cc nobody" — that is how
  // a draft whose operator cleared the Cc field opts out of the default.
  let effectiveCc = cc;
  if (effectiveCc == null && thread) {
    effectiveCc = await defaultReplyCc(sb, { thread_id: thread.id, our_email: FROM_EMAIL });
    // Whoever the reply is addressed TO never also rides the cc line.
    if (effectiveCc) {
      const toSet = new Set(splitAddresses(recipient.email));
      effectiveCc = splitAddresses(effectiveCc).filter(a => !toSet.has(a)).join(', ') || null;
    }
  }
  if (typeof effectiveCc === 'string' && !effectiveCc.trim()) effectiveCc = null;

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
    cc: addressList(effectiveCc) || null,
    from: FROM_EMAIL,
    subject,
    body,
    message_type,
    variant_id: variant_id || null,
    thread_id: thread?.id || null,
    threading: inReplyTo ? `reply (In-Reply-To ${inReplyTo})` : 'new thread',
  };

  // Checked ahead of BOTH sends, and reported on the preview rather than only
  // at the moment of sending: an oversized attachment is a fact about the draft,
  // not about the click.
  const sizeError = attachmentSizeError(attachments);
  if (sizeError) preview.attachment_error = sizeError;
  if (!confirmed) return preview;
  if (sizeError) return { ok: false, phase: 'too_large', error: sizeError, preview };

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
      would_cc: addressList(effectiveCc) || null,
      attachments: (attachments || []).map(a => a.filename),
      note: 'Sent to you only. Nothing was recorded against the company, and the draft is still pending.',
    };
  }

  // ---- PHASE 2: the gate ---------------------------------------------------
  // A template's call-notes placeholder still in the body means the one part
  // only the operator can write was never written. No bypass: the fix is
  // always to type the two lines (or delete the marker), never to send it.
  // Lazy require — messageTemplates sits above this module in the import graph.
  {
    const { CALL_NOTES_PLACEHOLDER } = require('./messageTemplates');
    if ((body || '').includes(CALL_NOTES_PLACEHOLDER)) {
      return {
        ok: false,
        phase: 'template_placeholder',
        error: `The body still contains "${CALL_NOTES_PLACEHOLDER}" — replace it with your notes from the call before sending.`,
      };
    }
  }

  // Checked before the send gate: a draft claiming a call that was never booked
  // is wrong whether or not sending is enabled.
  if (!invite_created && !allow_unbacked_invite_claim) {
    const unbacked = await assertInviteClaimIsBacked(sb, { company_id, body });
    if (unbacked) return unbacked;
  }

  if (!p.allow_undeliverable) {
    const dead = await assertRecipientDeliverable(sb, recipient.email);
    if (dead) return dead;
  }

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
  const raw = buildRawMessage({ to: recipient.email, cc: effectiveCc, subject, body: sentBody, inReplyTo, references: inReplyTo, message_type, attachments });
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
  const { data: sentRow, error: mErr } = await sb.from('b2b_messages').insert({
    thread_id: threadRowId, company_id, direction: 'outbound', message_type,
    variant_id: variant_id || null, gmail_message_id: gmailMessageId,
    gmail_thread_id: gmailThreadId, in_reply_to: inReplyTo,
    from_email: FROM_EMAIL, to_email: recipient.email,
    cc_email: addressList(effectiveCc) || null, body_text: sentBody,
    sent_at: sentAt, source: 'send_tool',
  }).select('id').single();
  if (mErr) console.error(`[sendB2bEmail] b2b_messages insert failed (sent ok): ${mErr.message}`);

  // What this send settles on the commitments list (2026-09-10): the item the
  // composer was opened from ("Done, write to them") and any "reply to them"
  // claim on this thread. Nothing else — sending Le JAG their codes does not
  // ship the stand. Fail-soft: the email is gone, and a bookkeeping miss must
  // not fail the send.
  let settled = [];
  try {
    const { settleOnSend } = require('./commitments');
    settled = (await settleOnSend(sb, {
      company_id, thread_id: threadRowId, message_id: sentRow?.id || null,
      draft: { structured: { completes_commitment_id: completes_commitment_id || null } },
    })).completed;
  } catch (err) {
    console.error(`[sendB2bEmail] commitments settle failed (sent ok): ${err.message}`);
  }

  // Gmail read state: we just answered, so nothing in this thread is waiting
  // on a person any more. Only for a reply into an existing Gmail thread — a
  // fresh intro has no inbound to un-bold. After the message insert on purpose,
  // since the verdict is computed from the record (readState.js), and
  // fail-soft inside: the email is already gone, a Gmail hiccup here must not
  // fail the send.
  if (thread?.gmail_thread_id) {
    const { settleThreadReadState } = require('./readState');
    await settleThreadReadState({ sb, gmail, gmail_thread_id: thread.gmail_thread_id });
  }

  // Cadence bookkeeping. On Me is not cleared here any more: it is derived from
  // the commitments list, and settleOnSend above closed what this send settled.
  // Snooze and pause are untouched: a send during either is one deliberate
  // message, not a decision to resume chasing.
  // A date they stated ("reach out in September") outranks the per-type table
  // now that this send closes the conversation; one that is past or about to be
  // acted on by this very send is consumed so it cannot resurface us as overdue.
  const { data: cadenceRow } = await sb.from('b2b_companies').select('metadata').eq('id', company_id).maybeSingle();
  const resolved = resolveNextActionDate({ message_type, sentAt: new Date(sentAt), next_touch_days: next_touch_days ?? null, company: cadenceRow });
  const consumed = !!cadenceRow?.metadata?.stated_next_touch && resolved.source !== 'stated';
  await sb.from('b2b_companies').update({
    last_outbound_at: sentAt,
    next_action_date: resolved.date,
    updated_at: sentAt,
    ...(consumed ? { metadata: withoutStatedNextTouch(cadenceRow.metadata) } : {}),
  }).eq('id', company_id);

  return { ok: true, phase: 'sent', gmail_message_id: gmailMessageId, gmail_thread_id: gmailThreadId, thread_id: threadRowId, to: recipient.email, cc: addressList(effectiveCc) || null, sent_at: sentAt, next_action_date: resolved.date, next_action_source: resolved.source, settled_commitments: settled };
}

module.exports = { sendB2bEmail, assertInviteClaimIsBacked, assertRecipientDeliverable, INVITE_CLAIM, buildRawMessage, toHtmlBody, normalizeSignature, resolveRecipient, resolveDelivery, deliveryMode, addressList, encodeSubject, attachmentSizeError, MAX_ATTACHMENT_TOTAL_BYTES, FROM_EMAIL, SEND_FLAG };
