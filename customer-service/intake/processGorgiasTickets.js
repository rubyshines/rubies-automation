/**
 * Gorgias Ticket Intake
 *
 * Processes Gorgias customer messages (via webhook or manual trigger),
 * runs them through the CS advisor, and stores AI-drafted responses
 * in Supabase for dashboard review.
 *
 * Assigns handled tickets to "AI Bot" in Gorgias so they disappear from
 * Jamie's inbox/unassigned queues.
 *
 * Usage:
 *   node customer-service/intake/processGorgiasTickets.js   (standalone)
 *   npm run cs-intake
 *
 * Exports run() and processTicket() for programmatic use.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { MODELS } = require('../../shared/aiPricing');
const { buildContext } = require('../lib/contextBuilder');
const gorgias = require('../import/gorgiasClient');
const { canonicalMessageType } = require('../lib/messageTypes');
const { classifyThankYou, formatMessagesForClassifier } = require('../lib/thankYouClassifier');
const { stripQuotedContent } = require('../../gmail-management/lib/gmailSync');
const { transplantContinuation, buildTransplantMessages } = require('../lib/ticketContinuation');
const { attachmentOnlyPlaceholder, fetchImagesAsBlocks } = require('../lib/attachmentImages');

// Pull a clean text body off a Gorgias message. Gorgias's own stripper is
// English-biased — for non-English replies (Danish "Den ... skrev :", etc.) it
// returns empty `stripped_text`/`stripped_html`. Fall back to the email-reply
// parser library on the raw body in that case so the AI advisor and dashboard
// don't see the entire quoted campaign. Returns { text, libraryStripped }
// where libraryStripped=true means the library actually removed quote content
// (caller should drop body_html so the dashboard renders the cleaned text).
function extractCleanBody(m) {
  // Gorgias Convert/Automate FLOW transcripts (meta.origin==='flow') pack the
  // whole interaction into one message: bot prompts plus the customer's choices
  // and free-text as `>`-prefixed lines. stripped_text is empty for these and
  // the email-reply-parser treats `>` as quoted-reply markers, DELETING the
  // customer's actual input — leaving only bot prompts for both the dashboard
  // and the advisor. Parse the transcript directly so the request survives.
  // Gated on the flow marker so direct help-center messages (and any that
  // legitimately quote prior content with `>`) keep the normal path below.
  if (m.meta?.origin === 'flow') {
    const raw = (m.body_text || '').trim() || gorgias.stripHtml(m.body_html || '').trim();
    return { text: cleanHelpCenterBody(raw), libraryStripped: true };
  }
  const stripped = (m.stripped_text || '').trim() || gorgias.stripHtml(m.stripped_html || '').trim();
  if (stripped) return { text: stripped, libraryStripped: false };
  const raw = (m.body_text || '').trim() || gorgias.stripHtml(m.body_html || '').trim();
  const cleaned = stripQuotedContent(raw);
  return { text: cleaned, libraryStripped: cleaned.length < raw.length };
}

// Lazy-load AI advisor
let _advisorHandler = null;

function getAdvisorHandler() {
  if (!_advisorHandler) {
    const { aiAdvisor } = require('../lib/aiAdvisor');
    _advisorHandler = aiAdvisor;
  }
  return _advisorHandler;
}

// Auto-place a warehouse hold the moment the advisor classifies a ticket as
// `action_type: warehouse_hold` (reply is past-tense "I've put a hold on the
// order", so the hold must be real before the draft is filed) or
// `action_type: cancellation` (protective freeze — the cancel waits on
// operator confirmation, and the order must not ship in that window).
// Returns an `actions` entry to append to the draft on success, or null on
// skip/failure (failure is logged so the operator agent can still attempt
// the hold itself).
// Auto-hold note text, keyed off the advisor's inquiry classification. Every
// non-cancel modify (item add/swap/remove, or an address change with no new
// address given yet) is proposed as a bare warehouse_hold and lands here. Don't
// special-case 'shipping' as an address change: add-item requests also classify
// as shipping, so guessing "address change" mislabeled those holds. Genuine
// address changes that fall back to a hold get their accurate reason from
// fallbackToHold, not from here — so a generic modify reason is correct.
function autoHoldReason(messageType, actionType) {
  if (messageType === 'cancellation' || actionType === 'cancellation') return 'Auto-hold: customer asked to cancel, holding before we cancel';
  return 'Auto-hold: customer wants to modify the order';
}

async function autoExecuteAdvisorHold(structured) {
  // 'warehouse_hold' is the advisor's explicit hold proposal. 'cancellation'
  // gets the same protective freeze: the cancel only executes when the
  // operator confirms it, and until then nothing stops the warehouse from
  // shipping the order. A hold is reversible; a cancel raced by fulfillment
  // isn't. For cancellation drafts the hold is a side action — it must NOT
  // mark the draft's staged cancel as executed (see the commitDraft call site).
  const actionType = structured?.action_type;
  if (actionType !== 'warehouse_hold' && actionType !== 'cancellation') return null;
  // Prefer the advisor's explicit action target: structured.order echoes the
  // LOADED context, which is the wrong order when a steer redirected the action
  // (ticket 2700: hold landed on the loaded #31533 instead of the steered #31485).
  // Same resolution rule as the backstop sweep — one implementation.
  const { holdTargetOrderNumber } = require('../lib/holdReconcile');
  const orderNumber = holdTargetOrderNumber({
    structured_output: structured,
    order_number: structured?.order?.name,
  });
  if (!orderNumber) {
    recordHoldFailure(structured, '(none)', 'advisor proposed a hold but no order number was on its output');
    return null;
  }

  // Kill switch: skip auto-execution if warehouse_hold auto-actions are disabled
  // (dashboard Auto-actions panel). The hold stays a proposal for the operator.
  const { isAutoactionEnabled, SOURCE } = require('../lib/autoactionGate');
  if (!(await isAutoactionEnabled('warehouse_hold'))) {
    if (!Array.isArray(structured.audit)) structured.audit = [];
    structured.audit.push(`Auto-hold skipped for #${orderNumber}: warehouse_hold auto-action disabled — operator places it`);
    return null;
  }

  const { handleWarehouseHold } = require('../lib/tools/orderNotes');
  const reason = autoHoldReason(structured?.intake?.message_type, actionType);

  try {
    const result = await handleWarehouseHold({ order_number: orderNumber, reason });
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) {
      recordHoldFailure(structured, orderNumber, text);
      return null;
    }
    return {
      executed_at: new Date().toISOString(),
      action_type: 'warehouse_hold',
      summary: text,
      links: [],
      source: SOURCE.HOLD,
    };
  } catch (err) {
    recordHoldFailure(structured, orderNumber, err.message);
    return null;
  }
}

// Record an auto-hold failure where it's actually visible — the draft's audit
// trail (persisted to cs_ai_drafts.audit_trail) plus a server error log. The
// old code only console.warn'd, which rolled off Railway and left a 0% success
// rate invisible for weeks. The backstop sweep (lib/holdReconcile.js) retries
// the hold; this captures WHY the synchronous intake attempt failed.
function recordHoldFailure(structured, order, reason) {
  const msg = `Auto-hold at intake FAILED for #${order}: ${reason} — backstop sweep will retry`;
  if (!Array.isArray(structured.audit)) structured.audit = [];
  structured.audit.push(msg);
  console.error(`[intake] ${msg}`);
}

// Record an advisor flag on the draft's structured output so it surfaces in the
// dashboard (prescription.flags renders as a chip on the ticket). Used when an
// auto-action could NOT complete as the draft prose implies and an operator
// must intervene.
function recordAdvisorFlag(structured, message) {
  if (!structured.prescription) structured.prescription = {};
  if (!Array.isArray(structured.prescription.flags)) structured.prescription.flags = [];
  structured.prescription.flags.push(message);
}

function addressOneLine(addr) {
  return [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
    .filter(Boolean)
    .join(', ');
}

// Auto-apply a SAME-COUNTRY shipping-address change the moment the advisor
// classifies a ticket as `action_type: order_modification` with a new address.
// The advisor reply is past-tense ("I've updated the shipping address"), so the
// edit must land before the draft is filed. Two safety gates fall back to a
// protective hold instead of auto-applying:
//   - cross-border changes (resolved country != current) affect shipping cost +
//     duties, so an operator handles them.
//   - addresses that don't validate (geocode fails / partial match) need a
//     human to confirm with the customer.
// On any fallback we flip action_type to warehouse_hold (so the hold backstop
// sweep guarantees the freeze even if the synchronous hold can't land yet), flag
// the draft so the operator fixes the now-inaccurate reply, and return the hold
// action. Returns an `actions` entry to append to the draft, or null.
async function autoExecuteAddressChange(structured) {
  if (structured?.action_type !== 'order_modification') return null;
  const newAddr = structured?.prescription?.shipping_address;
  // Only handle address changes here — item-swap order_modifications carry no
  // shipping_address and are executed by the operator.
  if (!newAddr || !newAddr.address1) return null;

  // Kill switch: if address-change auto-actions are disabled (dashboard
  // Auto-actions panel), leave the order_modification draft for the operator to
  // apply — no auto-apply and no protective hold.
  const { isAutoactionEnabled, SOURCE } = require('../lib/autoactionGate');
  if (!(await isAutoactionEnabled('address_change'))) {
    if (!Array.isArray(structured.audit)) structured.audit = [];
    structured.audit.push('Auto address-apply skipped: address_change auto-action disabled — operator applies it');
    return null;
  }

  const orderName = structured?.order?.name || '';
  const orderNumber = parseInt(String(orderName).replace(/^#/, ''), 10);
  if (!orderNumber) {
    return fallbackToHold(structured, orderName || '(none)',
      'address change proposed but no order number was on the advisor output');
  }

  const oldCountry = (structured?.customer?.country || structured?.customer?.address?.country || '').toUpperCase();

  const { validateShippingAddress } = require('../lib/addressValidation');
  const verdict = await validateShippingAddress(newAddr);
  const resolvedCountry = (verdict.country_code || newAddr.country || '').toUpperCase();

  // Cross-border → operator handles (shipping cost + duties).
  if (oldCountry && resolvedCountry && resolvedCountry !== oldCountry) {
    return fallbackToHold(structured, orderNumber,
      `Cross-border address change (${oldCountry} -> ${resolvedCountry}) needs an operator (shipping cost + duties). Requested address: ${addressOneLine(newAddr)}`);
  }
  // Unverifiable → operator confirms with the customer.
  if (!verdict.ok) {
    return fallbackToHold(structured, orderNumber,
      `Address could not be auto-applied (${verdict.reason}). Confirm with customer before shipping. Requested address: ${addressOneLine(newAddr)}`);
  }

  // Same-country + validated → apply the customer's address verbatim.
  const { handleEditOrder } = require('../lib/tools/editOrder');
  try {
    const result = await handleEditOrder({
      order_number: orderNumber,
      shipping_address: newAddr,
      note: 'CS auto-applied same-country address change',
    });
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) {
      return fallbackToHold(structured, orderNumber,
        `Auto address update failed (${text}). Requested address: ${addressOneLine(newAddr)}`);
    }
    return {
      executed_at: new Date().toISOString(),
      action_type: 'order_modification',
      summary: text,
      links: [],
      source: SOURCE.ADDRESS,
    };
  } catch (err) {
    return fallbackToHold(structured, orderNumber,
      `Auto address update errored (${err.message}). Requested address: ${addressOneLine(newAddr)}`);
  }
}

// When an address change can't be auto-applied, protect the order with a hold
// instead. Flips action_type to warehouse_hold (so the hold backstop sweep
// covers the not-yet-in-Warehance case), flags the draft for the operator, and
// attempts the hold synchronously. Returns the hold action entry, or null on
// synchronous failure (the sweep retries — action_type is already flipped).
async function fallbackToHold(structured, order, reason) {
  structured.action_type = 'warehouse_hold';
  recordAdvisorFlag(structured, `Address change not auto-applied — ${reason}`);
  if (!Array.isArray(structured.audit)) structured.audit = [];
  const numeric = parseInt(String(order).replace(/^#/, ''), 10);
  if (!numeric) {
    structured.audit.push(`Address auto-apply fell back to hold but no order number: ${reason}`);
    console.error(`[intake] Address auto-apply fell back to hold (no order number): ${reason}`);
    return null;
  }
  structured.audit.push(`Address auto-apply fell back to hold for #${numeric}: ${reason}`);
  console.error(`[intake] Address auto-apply fell back to hold for #${numeric}: ${reason}`);

  const { handleWarehouseHold } = require('../lib/tools/orderNotes');
  const { SOURCE } = require('../lib/autoactionGate');
  try {
    const result = await handleWarehouseHold({
      order_number: numeric,
      reason: 'Auto-hold: address change needs operator review',
    });
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) {
      structured.audit.push(`Fallback hold at intake FAILED for #${numeric}: ${text} — backstop sweep will retry`);
      return null;
    }
    return {
      executed_at: new Date().toISOString(),
      action_type: 'warehouse_hold',
      summary: text,
      links: [],
      source: SOURCE.ADDRESS_FALLBACK,
    };
  } catch (err) {
    structured.audit.push(`Fallback hold at intake FAILED for #${numeric}: ${err.message} — backstop sweep will retry`);
    return null;
  }
}

// AI Bot user ID — cached after first lookup
let _aiBotUserId = null;
const AI_BOT_NAME = 'RUBIES AI';

async function getAiBotUserId() {
  if (_aiBotUserId) return _aiBotUserId;
  const user = await gorgias.findUser(AI_BOT_NAME);
  if (!user) {
    console.warn(`[intake] Could not find Gorgias user "${AI_BOT_NAME}" — tickets will not be assigned`);
    return null;
  }
  _aiBotUserId = user.id;
  return _aiBotUserId;
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

// Gorgias help-center chat flows arrive as one concatenated message: bot
// prompt lines plus customer choices prefixed with `>`. Extract only the
// real customer free-text so the dashboard card isn't full of bot copy.
const HELP_CENTER_BUTTON_LABELS = new Set([
  'help me with a return or exchange',
  'start a return or exchange',
  'learn about our returns and exchanges policy',
  'sign in to continue',
  'no, i need more help',
  'exchange', 'return', 'refund',
  'go back', 'no', 'yes',
]);

// A help-center message is one of two shapes:
//   FLOW transcript  — plain text, one `> `-prefixed line per customer choice
//                      or free-text entry, interleaved with bot copy.
//   Contact form     — the customer's own message, whose `body_text` carries
//                      literal HTML (`<br>`) rather than plain text.
// Both land here, so the `>` test has to tell a flow marker from a tag closer.
// Measured across every help-center message we have stored (57 messages): all
// 189 flow markers sit at line start, no flow body contains markup, and every
// `>` that is NOT at line start is an HTML tag closer. Matching `>` anywhere
// therefore read the `>` of `<br>` as a marker and discarded everything before
// it — the customer's greeting, or on a single-paragraph message (whose only
// `<br>` is the trailing one) the entire message.
function cleanHelpCenterBody(body) {
  if (!body) return body;
  // Normalise markup FIRST, so a tag's `>` can never be mistaken for a marker
  // and the stored body renders as text instead of showing literal "<br>".
  // Gated on a real tag so plain prose ("between <14 and >16") is never mangled.
  const text = /<(?:br|p|div|span|a|ul|ol|li|strong|em|b|i|table|tr|td|h[1-6])\b[^>]*>/i.test(body)
    ? gorgias.stripHtml(body).trim()
    : body;
  const keep = [];
  for (const match of text.matchAll(/^[ \t]*>[ \t]*([^\n]+)/gm)) {
    const text = match[1].trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (HELP_CENTER_BUTTON_LABELS.has(lower)) continue;
    if (/^#\d+\s*[-–]\s*\$[\d.,]+/.test(text)) continue; // order pick
    if (/^\d+\s*x\s+/i.test(text)) continue; // selected line item
    // Order-display variant line: "<PRODUCT NAME> - <Color> / <Size>". Anchored
    // on the trailing " / <size>" so it won't swallow customer free-text.
    if (/^[A-Z0-9].*\s[-–]\s.+\s\/\s\S+$/.test(text)) continue; // variant label
    keep.push(text);
  }
  const cleaned = keep.join('\n').trim();
  // No line-start markers → not a bot-guided flow, so this is the customer's
  // own message. Return the markup-normalised text (not the raw body) so a
  // contact-form submission still comes out as readable plain text.
  return cleaned || text;
}

// ---------------------------------------------------------------------------
// Duplicate ticket detection
// ---------------------------------------------------------------------------

/**
 * Check if a new ticket is a duplicate of an existing open/snoozed ticket
 * from the same customer. Only calls the AI when there IS an existing ticket.
 *
 * Only applies at first contact — a ticket whose latest customer message is
 * its first. Once the customer has sent a second message they are replying on
 * a thread we already ingested (and likely answered); closing that ticket as a
 * "duplicate" eats the unprocessed reply, so it is never a close candidate.
 *
 * A first-contact ticket that CONTINUES an existing conversation (the
 * customer's reply failed to thread and spawned a fresh ticket) is never a
 * plain close either — it returns 'continuation' with the surviving ticket so
 * the caller can transplant the message (2026-07-07 eaten-replies incident).
 *
 * @returns {object|string|null}
 *   { action: 'close_new', survivor }          true duplicate — safe to close
 *   { action: 'continuation', survivor }       reply on a broken thread — transplant it
 *   { action: 'close_existing', ticketsToClose } new ticket supersedes old
 *   'keep_both'                                 different issues
 *   null                                        no dedup applicable
 */
/**
 * True when an email belongs to an internal RUBIES staff address (@rubyshines.com).
 * Internal addresses are never the real customer — when one is the ticket requester it
 * means a staff member forwarded a customer email to us.
 */
function isInternalRubiesAddress(email) {
  return !!email && /@rubyshines\.com$/i.test(String(email).trim());
}

/**
 * Decide whether a ticket's customer (requester) should be re-pointed to the original
 * external sender of a forwarded email. Pure/deterministic — the AI advisor supplies the
 * detected originator (forwardedSenderEmail); this just gates the mechanical redirect.
 *
 * Redirect only when the requester is an internal RUBIES address AND the advisor resolved
 * a syntactically-valid, external, different originator email.
 *
 * @returns {{ redirect: boolean, email?: string, name?: string|null }}
 */
function resolveForwardedCustomer({ ticketCustomerEmail, forwardedSenderEmail, forwardedSenderName }) {
  if (!isInternalRubiesAddress(ticketCustomerEmail)) return { redirect: false };
  const email = String(forwardedSenderEmail || '').trim();
  if (!email) return { redirect: false };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { redirect: false };
  if (isInternalRubiesAddress(email)) return { redirect: false };
  if (email.toLowerCase() === String(ticketCustomerEmail).trim().toLowerCase()) return { redirect: false };
  return { redirect: true, email, name: forwardedSenderName || null };
}

async function checkForDuplicateTicket(supabase, customerEmail, newTicketId, newMessages) {
  const customerMsgCount = newMessages.filter(m => !m.from_agent).length;
  if (customerMsgCount > 1) return null; // established conversation, not a new ticket

  // Quick check: does this customer have any non-closed tickets?
  const { data: existingTickets } = await supabase
    .from('cs_tickets')
    .select('id, gorgias_ticket_id, order_number, status, message_type, conversation_history, created_at')
    .eq('customer_email', customerEmail)
    .in('status', ['open', 'snoozed', 'follow_up'])
    .neq('gorgias_ticket_id', newTicketId);

  if (!existingTickets?.length) return null; // No existing tickets — not a duplicate

  // There IS an existing ticket — ask Opus to compare
  const { callClaude } = require('../../shared/aiClient');

  const newContent = newMessages
    .filter(m => !m.from_agent)
    .map(m => extractCleanBody(m).text)
    .join('\n')
    .substring(0, 800);

  const existingSummaries = existingTickets.map(t => {
    const msgs = t.conversation_history || [];
    const customerMsgs = msgs.filter(m => m.sender === 'customer');
    const agentMsgs = msgs.filter(m => m.sender === 'agent' && !m.is_bot);
    const lastCustomer = customerMsgs[customerMsgs.length - 1]?.body?.substring(0, 300) || '';
    const lastAgent = agentMsgs[agentMsgs.length - 1]?.body?.substring(0, 200) || '';
    return `Ticket #${t.gorgias_ticket_id} (${t.status}, ${t.message_type || 'unknown'}, order ${t.order_number || 'none'}, created ${t.created_at?.substring(0, 10)}):
  Customer: ${lastCustomer}
  Agent reply: ${lastAgent || '(no reply yet)'}`;
  }).join('\n\n');

  const response = await callClaude({
    component: 'cs_intake_classifier',
    ticket_id: newTicketId || null,
    metadata: { customer_email: customerEmail, task: 'duplicate_detection' },
    model: MODELS.OPUS,
    max_tokens: 200,
    messages: [{ role: 'user', content: `A customer (${customerEmail}) just created a new support ticket. They already have existing open ticket(s). Determine how the new ticket relates to the existing conversation.

EXISTING TICKET(S):
${existingSummaries}

NEW TICKET:
${newContent}

Respond with ONLY a JSON object:
{
  "action": "continuation" | "close_new" | "close_existing" | "keep_both",
  "existing_ticket_id": <the related existing ticket's number, or null when action is keep_both>,
  "reason": "brief explanation"
}

Rules:
- "continuation": the new message RESPONDS TO or ADVANCES the existing conversation — it answers a question our agent asked, provides requested information or photos, chases us for a reply, or adds new details about the same issue. This is the common case when the existing ticket already has an agent reply: the customer DID reply, but their email failed to thread onto the existing ticket. The message will be moved onto the existing ticket and answered there.
- "close_new": the new ticket adds NOTHING the existing ticket doesn't already contain — a resend of the same text, an empty or near-empty chat retry, or a double-send minutes apart. If the new message contains ANY new information, answer, or request, it is a continuation, not close_new.
- "close_existing": same issue, but the new ticket has MORE context or detail and the existing ticket has no agent reply yet. Close the old one(s), process the new one.
- "keep_both": tickets are about genuinely different issues (different orders, different problems). Keep both.` }],
  });

  const text = response.content[0]?.text || '';
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    console.log(`[intake] Duplicate check for ${newTicketId}: ${parsed.action} — ${parsed.reason}`);

    // Resolve the survivor: the AI-named existing ticket, else the most recent.
    const survivor =
      existingTickets.find(t => String(t.gorgias_ticket_id) === String(parsed.existing_ticket_id))
      || [...existingTickets].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    if (parsed.action === 'continuation') return { action: 'continuation', survivor };
    if (parsed.action === 'close_new') return { action: 'close_new', survivor };
    if (parsed.action === 'close_existing') {
      return { action: 'close_existing', ticketsToClose: existingTickets };
    }
    return 'keep_both';
  } catch {
    console.warn(`[intake] Could not parse duplicate check response: ${text.substring(0, 100)}`);
    return 'keep_both'; // When in doubt, keep both
  }
}

// ---------------------------------------------------------------------------
// Inline images
//
// Customer photos don't always arrive as Gorgias attachment objects. Phone mail
// clients (iPhone Mail, Gmail) frequently embed the photo inline in the HTML
// body as <img src="…"> instead. Gorgias renders these (so they show in the
// Gorgias UI) and re-hosts them on uploads.gorgias.io, but they're absent from
// the message's `attachments[]`. Without this, our pipeline drops the image
// entirely — no dashboard thumbnail and no advisor [ATTACHMENTS] note — so the
// advisor wrongly tells the customer the photo "didn't come through."
// ---------------------------------------------------------------------------

const GORGIAS_INLINE_IMG_RE = /<img[^>]+src=["'](https:\/\/uploads\.gorgias\.io\/[^"']+)["']/gi;
const EXT_CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
};

// Pull inline images embedded in a message's HTML body. Returns attachment-shaped
// objects ({ name, url, content_type }).
function extractInlineImages(html) {
  if (!html) return [];
  const out = [];
  GORGIAS_INLINE_IMG_RE.lastIndex = 0;
  let m;
  while ((m = GORGIAS_INLINE_IMG_RE.exec(html)) !== null) {
    const url = m[1];
    const file = decodeURIComponent((url.split('/').pop() || 'image').split('?')[0]);
    const ext = (file.split('.').pop() || '').toLowerCase();
    out.push({ name: file, url, content_type: EXT_CONTENT_TYPES[ext] || 'image/jpeg' });
  }
  return out;
}

// Merge each message's real attachments with its inline images, deduped across
// the whole thread by URL (first chronological occurrence wins). Dedup matters
// because a photo gets quoted back in later replies — we want it attributed to
// the message where it's genuinely new, not re-imported on every quote.
// Returns a Map of message id → attachment[].
function buildEffectiveAttachments(messages) {
  const seen = new Set();
  const byId = new Map();
  for (const m of messages) {
    const real = (m.attachments || []).map(a => ({
      name: a.name, url: a.url, content_type: a.content_type,
    }));
    for (const a of real) if (a.url) seen.add(a.url);
    const inline = extractInlineImages(m.body_html).filter(a => !seen.has(a.url));
    for (const a of inline) seen.add(a.url);
    byId.set(m.id, [...real, ...inline]);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Conversation history snapshot — shared between advisor and auto-close paths
// ---------------------------------------------------------------------------

function buildConversationHistorySnapshot(messages) {
  const effectiveAttachments = buildEffectiveAttachments(messages);
  return messages.map(m => {
    const sender = m.from_agent === false ? 'customer' : m.channel === 'internal-note' ? 'note' : 'agent';
    // Prefer Gorgias's stripped_* fields when present. When they're empty
    // (non-English replies — Gorgias's stripper is English-biased), fall back
    // to email-reply-parser on the raw body and drop body_html so the dashboard
    // renders the cleaned text instead of the bloated quoted HTML.
    const clean = extractCleanBody(m);
    let bodyHtml = clean.libraryStripped ? null : (m.stripped_html || m.body_html || null);
    let bodyText = clean.text;
    if (sender === 'customer' && m.channel === 'help-center') {
      // Strip bot copy/button labels from non-flow help-center contact forms.
      // For flow transcripts extractCleanBody already did this (idempotent here).
      bodyText = cleanHelpCenterBody(bodyText);
      bodyHtml = null;
    }
    return {
      id: m.id,
      sender,
      is_bot: m.from_agent !== false && m.via !== 'api' && (
        (m.sender?.email || '').endsWith('@email.gorgias.com') || m.via === 'rule'
      ),
      body_html: bodyHtml,
      body: bodyText,
      created_at: m.created_datetime,
      channel: m.channel,
      attachments: effectiveAttachments.get(m.id) || [],
    };
  });
}

// ---------------------------------------------------------------------------
// Auto-close fast path: thank-you closer
//
// When the customer's latest message is a pure thank-you with no new ask AND
// our last reply already resolved the ticket (no open exchange/refund in
// flight), skip the full advisor draft and just send a templated reply +
// close the ticket. Always-on; failures fall through to the regular advisor.
// ---------------------------------------------------------------------------

const AUTO_CLOSE_TEMPLATES = [
  "You're so welcome! Take care.",
  "Anytime, happy to help.",
  "My pleasure. Reach out anytime.",
];

function pickAutoCloseTemplate() {
  return AUTO_CLOSE_TEMPLATES[Math.floor(Math.random() * AUTO_CLOSE_TEMPLATES.length)];
}

async function tryAutoCloseThankYou({ supabase, ticketId, messages, latestCustomerMsg }) {
  // Precondition: there must be a prior SENT advisor reply on this ticket.
  const { data: lastSentDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, sent_response, draft_response, action_type, action_executed_at, draft_kind, sent_at')
    .eq('gorgias_ticket_id', ticketId)
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastSentDraft) return { handled: false, reason: 'no_prior_sent_reply' };

  // Don't auto-close after a follow-up nudge — that's a different state machine.
  if (lastSentDraft.draft_kind && lastSentDraft.draft_kind !== 'advisor_draft') {
    return { handled: false, reason: `prior_was_${lastSentDraft.draft_kind}` };
  }

  // Open action carve-out: never auto-close if we drafted an action that was never executed.
  if (lastSentDraft.action_type && !lastSentDraft.action_executed_at) {
    return { handled: false, reason: 'open_action_in_flight' };
  }

  const latestText = String(latestCustomerMsg.stripped_text || latestCustomerMsg.body_text || '').trim();
  if (!latestText) return { handled: false, reason: 'empty_message' };

  // Run classifier
  const recent = formatMessagesForClassifier(messages, 6);
  const priorReply = lastSentDraft.sent_response || lastSentDraft.draft_response || '';
  const cls = await classifyThankYou({ recentMessages: recent, priorAgentReply: priorReply });

  if (!cls.auto_close) {
    return { handled: false, reason: 'classifier_negative', classifier: cls };
  }

  const sendResult = await sendAutoCloseReply({
    supabase, ticketId, messages, latestCustomerMsg, lastSentDraft, classifier: cls,
  });
  // claimed=false → a concurrent worker (webhook vs reconcile vs resync) owns
  // this message and is sending the reply — still "handled" for this caller.
  return { handled: true, classifier: cls, claimedElsewhere: sendResult?.claimed === false };
}

async function sendAutoCloseReply({ supabase, ticketId, messages, latestCustomerMsg, lastSentDraft, classifier }) {
  const reply = pickAutoCloseTemplate();
  const replyHtml = `<p>${reply}</p>`;

  // Atomic claim BEFORE any Gorgias write. processTicket can race between the
  // webhook, reconcileTickets, and gorgiasAdvisorResync; check-then-act here
  // sends the customer duplicate replies. UNIQUE(gorgias_ticket_id,
  // gorgias_message_id) makes exactly one caller the owner — a 23505 collision
  // means another worker owns this message, so bail without sending. The claim
  // records ownership only (status 'superseded' keeps it out of dashboard
  // queues); it becomes the real sent row after the Gorgias writes succeed.
  const { data: claim, error: claimErr } = await supabase
    .from('cs_ai_drafts')
    .insert({
      gorgias_ticket_id: ticketId,
      gorgias_message_id: latestCustomerMsg.id,
      draft_response: reply,
      structured_output: { auto_close_path: 'thank_you', claim: true },
      audit_trail: ['auto_close_thank_you: claim'],
      status: 'superseded',
      message_type: 'closing',
    })
    .select('id')
    .single();

  if (claimErr) {
    if (claimErr.code === '23505') return { claimed: false };
    // Can't verify ownership — do NOT send a customer-facing reply blind.
    throw new Error(`auto-close claim failed for ticket ${ticketId}: ${claimErr.message}`);
  }

  // Gorgias writes FIRST (per domain key decision: errors propagate, no split-brain).
  let replyResult;
  try {
    replyResult = await gorgias.createTicketReply(ticketId, {
      body_text: reply,
      body_html: replyHtml,
    });
  } catch (err) {
    // Nothing reached the customer — release the claim so a later pass retries.
    await supabase.from('cs_ai_drafts').delete().eq('id', claim.id);
    throw err;
  }
  await gorgias.closeTicket(ticketId);
  await gorgias.assignTicket(ticketId, null);
  await gorgias.addTicketTag(ticketId, 'ai-resolved');
  await gorgias.addTicketTag(ticketId, 'auto-closed-thank-you');

  // Pull current ticket row so we can preserve fields we don't compute here
  // (customer_email/name/pronouns/country, order_number, history_summary, etc).
  const { data: existingTicket } = await supabase
    .from('cs_tickets')
    .select('id, customer_email, customer_name')
    .eq('gorgias_ticket_id', ticketId)
    .maybeSingle();

  const history = buildConversationHistorySnapshot(messages);
  history.push({
    id: replyResult?.id || null,
    sender: 'agent',
    is_bot: false,
    body: reply,
    body_html: replyHtml,
    created_at: new Date().toISOString(),
    channel: 'email',
  });

  const customerMsgTimes = history
    .filter(m => m.sender === 'customer' && m.created_at)
    .map(m => m.created_at);
  const lastCustomerMessageAt = customerMsgTimes.length
    ? customerMsgTimes.sort().slice(-1)[0]
    : null;

  const now = new Date().toISOString();

  const { data: ticketRow, error: ticketErr } = await supabase
    .from('cs_tickets')
    .upsert({
      gorgias_ticket_id: ticketId,
      status: 'closed',
      closed_at: now,
      message_type: 'closing',
      customer_sentiment: 'positive',
      advisor_status: 'ready',
      confidence: 'high',
      conversation_history: history,
      has_agent_reply: true,
      last_customer_message_at: lastCustomerMessageAt,
      viewed_at: now,
      updated_at: now,
      gorgias_status: 'closed',
      active_draft_id: null,
      auto_close_path: 'thank_you',
    }, { onConflict: 'gorgias_ticket_id' })
    .select('id')
    .single();

  if (ticketErr) {
    console.error(`[intake] Auto-close ticket upsert error for ${ticketId}: ${ticketErr.message}`);
  }

  const draftRow = {
    ticket_id: ticketRow?.id || null,
    customer_email: existingTicket?.customer_email || null,
    customer_name: existingTicket?.customer_name || null,
    draft_response: reply,
    sent_response: reply,
    structured_output: {
      auto_close_path: 'thank_you',
      classifier: {
        model: classifier?._usage?.model || null,
        reason: classifier?.reason || null,
        input_tokens: classifier?._usage?.input_tokens || null,
        output_tokens: classifier?._usage?.output_tokens || null,
      },
    },
    audit_trail: [`auto_close_thank_you: ${classifier?.reason || 'classifier_positive'}`],
    confidence: 'high',
    advisor_status: 'ready',
    message_type: 'closing',
    conversation_history: history,
    status: 'sent',
    reviewed_at: now,
    sent_at: now,
    gorgias_reply_message_id: replyResult?.id || null,
    auto_close_path: 'thank_you',
    previous_draft_id: lastSentDraft.id,
  };

  // Flesh out the claim row into the real sent draft.
  const { data: newDraft, error: insertErr } = await supabase
    .from('cs_ai_drafts')
    .update(draftRow)
    .eq('id', claim.id)
    .select('id')
    .single();

  if (insertErr) {
    console.error(`[intake] Auto-close draft update error for ${ticketId}: ${insertErr.message}`);
    return { claimed: true };
  }

  await supabase.from('cs_ai_feedback_log').insert({
    draft_id: newDraft?.id,
    gorgias_ticket_id: ticketId,
    action: 'auto_close_thank_you',
    original_response: reply,
    final_response: reply,
    advisor_status: 'ready',
    confidence: 'high',
    message_type: 'closing',
  });

  return { claimed: true };
}

// ---------------------------------------------------------------------------
// processTicket — extracted from run() for reuse by webhook handler
// ---------------------------------------------------------------------------

/**
 * Process a single Gorgias ticket through the advisor.
 * Returns { drafted: true } if a draft was created, { skipped: true } otherwise.
 */
async function processTicket(supabase, ticket, aiBotId, existingMessageIds) {
  const ticketId = ticket.id;

  // Fetch messages (only called for tickets that passed pre-filter)
  const messages = await gorgias.getTicketMessages(ticketId);
  if (!messages.length) return { skipped: true };

  // Find latest customer message
  const customerMessages = messages.filter(m => m.from_agent === false);
  if (!customerMessages.length) return { skipped: true };

  const latestCustomerMsg = customerMessages[customerMessages.length - 1];
  const latestCustomerMsgId = latestCustomerMsg.id;

  // Check if we already have a draft for this specific message
  if (existingMessageIds?.has(latestCustomerMsgId)) {
    console.log(`[intake] Skip ${ticketId}: draft exists for this message`);
    return { skipped: true };
  }

  // Check if a real human agent replied AFTER the latest customer message.
  // Skip bot messages (Gorgias rules), AI bot messages (our system), and
  // auto follow-ups sent via API — only skip if a human actually handled it.
  const messagesAfterCustomer = messages.filter(m =>
    new Date(m.created_datetime) > new Date(latestCustomerMsg.created_datetime)
    && m.from_agent === true
  );
  const humanRepliedAfter = messagesAfterCustomer.some(m => {
    if (m.sender?.email?.endsWith('@email.gorgias.com')) return false; // Gorgias rule
    if (m.via === 'rule') return false; // automation rule
    if (m.channel === 'internal-note') return false; // internal notes don't count
    if (aiBotId && m.sender?.id === aiBotId) return false; // our AI bot
    return true;
  });
  if (humanRepliedAfter) {
    console.log(`[intake] Skip ${ticketId}: human agent replied after latest customer message`);
    return { skipped: true };
  }

  const customerEmail = ticket.customer?.email;
  const senderName = [ticket.customer?.firstname, ticket.customer?.lastname]
    .filter(Boolean)
    .join(' ')
    .trim() || ticket.customer?.name || null;

  // Check for duplicate tickets from the same customer.
  // Skip when the requester is an internal RUBIES address: that signals a forwarded
  // customer email (resolved to the real sender after the advisor runs). Deduping on
  // the internal address would falsely collapse distinct forwarded tickets that all
  // share the same staff requester.
  if (customerEmail && !isInternalRubiesAddress(customerEmail)) {
    const dupAction = await checkForDuplicateTicket(supabase, customerEmail, ticketId, messages);
    if (dupAction?.action === 'continuation') {
      // The customer's reply failed to thread and spawned this fresh ticket.
      // Move the message onto the surviving ticket (fires the message webhook,
      // so the advisor drafts a reply there) and close this stray one.
      console.log(`[intake] Ticket ${ticketId}: continuation of #${dupAction.survivor.gorgias_ticket_id} — transplanting`);
      await transplantContinuation({
        gorgias,
        supabase,
        newTicketId: ticketId,
        survivor: dupAction.survivor,
        customerEmail,
        customerName: senderName,
        customerMessages: buildTransplantMessages(messages, m => extractCleanBody(m).text),
      });
      return { skipped: true, reason: 'continuation' };
    }
    if (dupAction?.action === 'close_new') {
      console.log(`[intake] Skip ${ticketId}: duplicate of existing ticket`);
      // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
      await gorgias.addInternalNote(ticketId, `Auto-closed: duplicate of existing open ticket #${dupAction.survivor.gorgias_ticket_id} for this customer.`);
      await gorgias.closeTicket(ticketId);
      return { skipped: true, reason: 'duplicate' };
    }
    if (dupAction?.action === 'close_existing') {
      console.log(`[intake] Closing older ticket(s) — this one has more context`);
      for (const oldTicket of dupAction.ticketsToClose) {
        // Close in Gorgias FIRST — if this fails, operation fails and ticket stays open
        await gorgias.addInternalNote(oldTicket.gorgias_ticket_id, `Auto-closed: superseded by newer ticket #${ticketId} with more context.`);
        await gorgias.closeTicket(oldTicket.gorgias_ticket_id);

        // Update DB only after Gorgias succeeded
        const nowIso = new Date().toISOString();
        await supabase
          .from('cs_tickets')
          .update({ status: 'closed', closed_at: nowIso, updated_at: nowIso })
          .eq('id', oldTicket.id);
      }
    }
    // 'keep_both' or no action → continue processing normally
  }

  // Get previous draft's intake state for multi-turn
  let previousIntake = null;
  let previousDraftId = null;
  const { data: prevDraft } = await supabase
    .from('cs_ai_drafts')
    .select('id, intake_state')
    .eq('gorgias_ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (prevDraft) {
    previousIntake = prevDraft.intake_state;
    previousDraftId = prevDraft.id;
    // NOTE: superseding old pending drafts happens inside commitDraft, AFTER
    // the replacement insert succeeds. Doing it here orphaned the pending
    // draft whenever any early-return / advisor failure bailed before a
    // replacement was created.
  }

  // Extract message text (use stripped version for cleaner input).
  // Attachment-only messages (e.g. a customer replying with just screenshots)
  // have no text at all — substitute a placeholder so they flow through intake
  // instead of being dropped (a dropped message never reaches the mirror or
  // the advisor, and surfaces days later as a drift "real miss").
  const attachments = buildEffectiveAttachments(messages).get(latestCustomerMsg.id) || [];
  let messageText = extractCleanBody(latestCustomerMsg).text;
  if (!messageText.trim()) {
    if (!attachments.length) return { skipped: true };
    messageText = attachmentOnlyPlaceholder(attachments);
  }

  // === Auto-close fast path: pure thank-you closer ===
  // When the customer's latest message is a pure thank-you with no new ask AND
  // our last reply already resolved the ticket, skip the full advisor draft
  // and just send a templated reply + close. Fail-closed: any precondition or
  // classifier error falls through to the normal advisor flow.
  try {
    const gateResult = await tryAutoCloseThankYou({
      supabase,
      ticketId,
      messages,
      latestCustomerMsg,
    });
    if (gateResult.handled) {
      console.log(`[intake] Auto-closed thank-you ticket ${ticketId}: ${gateResult.classifier?.reason || 'positive'}`);
      return { drafted: true, autoClosed: true };
    }
  } catch (err) {
    console.warn(`[intake] Auto-close gate error on ticket ${ticketId}: ${err.message}`);
  }

  // Build conversation context from all previous messages (input preparation)
  const conversationContext = buildConversationContext(messages, latestCustomerMsg.id);
  const previousDraftContext = await buildPreviousDraftContext(supabase, ticketId);

  const contextParts = [];
  if (conversationContext) contextParts.push(`[CONVERSATION HISTORY]\n${conversationContext}`);
  if (previousDraftContext) contextParts.push(`[PREVIOUS AI PROCESSING]\n${previousDraftContext}`);
  // Surface attachment metadata (filenames + types) so the advisor knows what was
  // attached — including inline images embedded in the HTML body (see buildEffectiveAttachments).
  const attachmentNote = attachments.length
    ? `\n[ATTACHMENTS: ${attachments.map(a => `${a.name || 'file'} (${a.content_type || 'unknown type'})`).join(', ')}]`
    : '';
  contextParts.push(`[LATEST CUSTOMER MESSAGE]\n${messageText}${attachmentNote}`);
  const issueDescription = contextParts.join('\n\n');

  // Deterministic context fetch — always have order/customer data regardless of AI parse outcome
  let preContext = null;
  try {
    preContext = await buildContext({
      customer_email: customerEmail,
      customer_name: senderName,
      issue_description: issueDescription,
      existingIntake: previousIntake,
      current_gorgias_ticket_id: ticketId,
    });
  } catch (err) {
    console.warn(`[intake] Pre-context fetch failed for ${ticketId}: ${err.message}`);
  }

  // Fetch the latest message's image attachments as vision blocks so the
  // advisor reads the content (error screenshots, defect photos), not just
  // filenames. Fail-soft: on any fetch problem the draft proceeds text-only.
  const images = await fetchImagesAsBlocks(attachments);

  // Run through hybrid advisor (Opus) with tree fallback
  console.log(`[intake] Processing ticket ${ticketId} — "${messageText.substring(0, 80)}..."${images.length ? ` [+${images.length} image(s)]` : ''}`);

  let result;
  try {
    const advisorHandler = getAdvisorHandler();
    result = await advisorHandler({
      customer_email: customerEmail,
      issue_description: issueDescription,
      intake: previousIntake || undefined,
      preContext,
      ticket_id: ticketId,
      images,
    });
  } catch (err) {
    console.error(`[intake] AI advisor error on ticket ${ticketId}: ${err.message}`);
    return { skipped: true };
  }

  const structured = result?._structured;
  if (!structured) {
    console.warn(`[intake] No structured output for ticket ${ticketId}`);
    return { skipped: true };
  }

  // Forwarded-from-internal redirect: when staff forward a customer email to us,
  // Gorgias makes the forwarder the ticket requester, so the reply would go back to
  // staff. The advisor detects the original external sender (forwarded_sender_email);
  // re-point the Gorgias ticket's customer to them so the reply — and the ticket
  // identity — go to the real customer. Best-effort: a failure here must not block
  // the draft, but we still write the resolved customer to our own row below.
  const forwardRedirect = resolveForwardedCustomer({
    ticketCustomerEmail: customerEmail,
    forwardedSenderEmail: structured.forwarded_sender_email,
    forwardedSenderName: structured.customer?.name,
  });
  if (forwardRedirect.redirect) {
    console.log(`[intake] Ticket ${ticketId}: forwarded by internal ${customerEmail} — re-pointing customer to ${forwardRedirect.email}`);
    try {
      await gorgias.setTicketCustomer(ticketId, { email: forwardRedirect.email, name: forwardRedirect.name });
      try { await gorgias.addTicketTag(ticketId, 'forwarded-resolved'); } catch { /* tag is best-effort */ }
    } catch (err) {
      console.warn(`[intake] Could not re-point Gorgias customer for ticket ${ticketId}: ${err.message}`);
    }
  }

  // Draft response comes from advisor (composed inside the tool)
  const routeToHuman = structured.status === 'route_to_human' || (structured.error && !structured.intake);
  let draftResponse;
  if (routeToHuman && !structured._composedResponse) {
    const routeReason = structured.results?.[0]?.summary || structured.error || 'Unhandled message type';
    draftResponse = `[AI could not draft a response — needs manual reply]\n\nRoute reason: ${routeReason}\n\nCustomer message: ${messageText}`;
    console.log(`[intake] Ticket ${ticketId} routed to human — creating training draft`);
  } else {
    draftResponse = structured._composedResponse || '[No response composed]';
  }

  // Build conversation history snapshot (for dashboard display)
  const conversationHistory = buildConversationHistorySnapshot(messages);

  // Count real messages (customer + non-bot agent, excluding internal notes and bot)
  const messageCount = conversationHistory.filter(m =>
    m.sender === 'customer' || (m.sender === 'agent' && !m.is_bot)
  ).length;

  // Detect if an agent has replied (from conversation history — catches replies made outside dashboard)
  const hasAgentReply = conversationHistory.some(m => m.sender === 'agent' && !m.is_bot);

  // Latest customer message timestamp — drives the unread indicator in the dashboard
  const customerMsgTimes = conversationHistory
    .filter(m => m.sender === 'customer' && m.created_at)
    .map(m => m.created_at);
  const lastCustomerMessageAt = customerMsgTimes.length
    ? customerMsgTimes.sort().slice(-1)[0]
    : null;

  // Upsert cs_tickets row (ticket-centric model)
  // message_type is the canonical inquiry category — read from top-level structured output,
  // validated against the allowed set. Non-canonical values are coerced to 'uncategorized'.
  const messageType = canonicalMessageType(structured.message_type, `ticket ${ticketId}`);
  const confidence = structured.confidence || 'low';

  // Effective customer email — the forwarded originator when we re-pointed, else the
  // Gorgias requester. Everything customer-facing keys off this, not the forwarder.
  const effectiveCustomerEmail = forwardRedirect.redirect ? forwardRedirect.email : customerEmail;

  // Get customer name — AI extraction, then preContext, then Supabase fallback
  let customerName = structured.customer?.name || null;
  if (!customerName && !forwardRedirect.redirect && preContext?.customer) {
    customerName = [preContext.customer.firstName, preContext.customer.lastName].filter(Boolean).join(' ') || null;
  }
  if (!customerName && effectiveCustomerEmail) {
    const { data: custRow } = await supabase
      .from('customers')
      .select('first_name, last_name')
      .eq('email', effectiveCustomerEmail.toLowerCase())
      .maybeSingle();
    if (custRow) customerName = [custRow.first_name, custRow.last_name].filter(Boolean).join(' ') || null;
  }

  // Detect gmail-import source from email_messages (source of truth — not Gorgias tags, which race)
  const { data: gmailOrigin } = await supabase
    .from('email_messages')
    .select('gmail_message_id')
    .eq('gorgias_ticket_id', ticketId)
    .limit(1);
  const ticketSource = gmailOrigin?.length ? 'gmail' : 'gorgias';

  // Build upsert payload — only include fields with non-null values to avoid
  // clobbering good data from a previous turn when the AI parse fails
  // Use resolved email from name fallback if Gorgias has no email (e.g. Facebook Messenger).
  // effectiveCustomerEmail already prefers the forwarded originator when we re-pointed.
  const resolvedEmail = effectiveCustomerEmail || preContext?.customer?.email || null;

  const ticketUpsert = {
    gorgias_ticket_id: ticketId,
    created_at: ticket.created_datetime || new Date().toISOString(),
    status: 'open',
    follow_up_stage: 0, // Reset on every new customer message (restarts follow-up cycle)
    message_count: messageCount,
    customer_email: resolvedEmail,
    conversation_history: conversationHistory,
    message_type: messageType,
    confidence,
    summary: structured.summary || null,
    history_summary: structured.history_summary || null,
    customer_sentiment: structured.customer_sentiment || null,
    advisor_status: structured.status,
    source: ticketSource,
    updated_at: new Date().toISOString(),
    last_customer_message_at: lastCustomerMessageAt,
    gorgias_status: ticket.status || 'open',
    gorgias_updated_at: ticket.updated_datetime || null,
  };
  // Only overwrite these if we got real values — don't clobber prior data with nulls
  // Fall back to preContext for order/customer data when AI parse fails
  if (customerName) ticketUpsert.customer_name = customerName;
  if (structured.customer?.pronouns) ticketUpsert.customer_pronouns = structured.customer.pronouns;
  if (structured.customer?.country || preContext?.customerCountry) {
    ticketUpsert.customer_country = structured.customer?.country || preContext.customerCountry;
  }
  if (structured.order?.name || preContext?.targetOrder?.name) {
    ticketUpsert.order_number = structured.order?.name || preContext.targetOrder.name;
  }
  if (structured.order) ticketUpsert.order_context = structured.order;
  if (structured.customer) ticketUpsert.customer_context = structured.customer;
  // Only set has_agent_reply to true, never back to false (one-way latch)
  if (hasAgentReply) ticketUpsert.has_agent_reply = true;

  const { data: ticketRow, error: ticketErr } = await supabase
    .from('cs_tickets')
    .upsert(ticketUpsert, { onConflict: 'gorgias_ticket_id' })
    .select('id')
    .single();

  if (ticketErr) {
    console.error(`[intake] Ticket upsert error for ${ticketId}: ${ticketErr.message}`);
    return { skipped: true };
  }

  // Auto-execute the warehouse hold the moment the advisor proposes it — the
  // draft response is already past-tense ("I've put a hold on the order"), so
  // the hold needs to be real before the operator sees the ticket. On success
  // we seed the draft's `actions` array; on failure we leave it empty and the
  // operator agent will see the hold isn't placed.
  const autoHoldAction = await autoExecuteAdvisorHold(structured);
  // Same-country address changes auto-apply; cross-border / unverifiable ones
  // fall back to a protective hold inside autoExecuteAddressChange. Mutually
  // exclusive with the hold path above (keyed on a different action_type).
  const autoAddressAction = autoHoldAction ? null : await autoExecuteAddressChange(structured);
  const autoAction = autoHoldAction || autoAddressAction;
  const initialActions = autoAction ? [autoAction] : [];
  // On a cancellation draft the auto-hold is a PROTECTIVE side action: the
  // staged action (the cancel itself) is still pending operator execution, so
  // action_executed_at must stay null — setting it would make the dashboard
  // treat the cancel as done.
  const protectiveHoldOnly = autoHoldAction && structured.action_type === 'cancellation';
  const nowIso = new Date().toISOString();

  // Auto-send shadow phase (#4): mark drafts that WOULD have auto-sent so the
  // dry run is auditable (Closed-tab filter + digest line) before any category
  // goes live. Gated by system_flags (master `autosend_shadow` + per-category
  // allowlist); the never-list is hardcoded in the gate. Nothing is sent.
  let autosendShadow = { eligible: false };
  try {
    const { shouldShadowMark } = require('../lib/autosendGate');
    autosendShadow = await shouldShadowMark({ structured, draftResponse, messageType, confidence });
    if (autosendShadow.eligible) {
      console.log(`[intake] Ticket ${ticketId} draft marked autosend_shadow (${autosendShadow.reason})`);
    }
  } catch (e) {
    console.warn(`[intake] autosend gate error (ignored): ${e.message}`);
  }

  // Insert draft (save advisor result verbatim, no post-processing), supersede
  // the older pending draft, and repoint the ticket — via commitDraft, which
  // owns the concurrency-safe ordering.
  const committed = await commitDraft(supabase, {
    ticketRowId: ticketRow.id,
    gorgiasTicketId: ticketId,
    draftFields: {
      ...(autosendShadow.eligible ? { auto_close_path: 'autosend_shadow' } : {}),
      ticket_id: ticketRow.id,
      gorgias_ticket_id: ticketId,
      gorgias_message_id: latestCustomerMsgId,
      // Use the effective (forward-redirect-aware) email, matching the cs_tickets
      // upsert above — not the raw ticket email, which is the internal forwarder
      // on forwarded tickets.
      customer_email: resolvedEmail || customerEmail,
      customer_name: structured.customer?.name || null,
      customer_pronouns: structured.customer?.pronouns || null,
      customer_country: structured.customer?.country || null,
      order_number: structured.order?.name || null,
      draft_response: draftResponse,
      structured_output: structured,
      intake_state: structured.intake || null,
      audit_trail: structured.audit || [],
      confidence,
      advisor_status: structured.status,
      message_type: messageType,
      conversation_history: conversationHistory,
      order_context: structured.order || null,
      customer_context: structured.customer || null,
      action_type: structured.action_type || null,
      actions: initialActions,
      action_executed_at: autoAction && !protectiveHoldOnly ? nowIso : null,
      previous_draft_id: previousDraftId,
    },
  });
  if (!committed.id) return { skipped: true };
  const newDraft = { id: committed.id };

  console.log(`[intake] Draft created for ticket ${ticketId} (confidence: ${confidence}, status: ${structured.status}, type: ${messageType})`);

  // Auto-dispose business outreach — Gorgias first, then Supabase (consistent with key decision)
  if (messageType === 'business_outreach') {
    await gorgias.addTicketTag(ticketId, 'business-outreach');
    await gorgias.closeTicket(ticketId);
    await gorgias.assignTicket(ticketId, null);

    const now = new Date().toISOString();
    await supabase.from('cs_tickets').update({
      status: 'closed',
      closed_at: now,
      updated_at: now,
      active_draft_id: null,
    }).eq('id', ticketRow.id);

    await supabase.from('cs_ai_drafts').update({ status: 'spam' }).eq('id', newDraft.id);

    console.log(`[intake] Auto-closed business outreach: ticket ${ticketId}`);
    return { drafted: true, outreach: true };
  }

  // Assign to AI Bot in Gorgias
  if (aiBotId) {
    try {
      await gorgias.assignTicket(ticketId, aiBotId);
      await gorgias.addTicketTag(ticketId, 'ai-draft');
    } catch (err) {
      console.warn(`[intake] Could not assign/tag ticket ${ticketId}: ${err.message}`);
    }
  }

  return { drafted: true };
}

// ---------------------------------------------------------------------------
// Draft commit — insert, supersede, repoint (in that order)
// ---------------------------------------------------------------------------

/**
 * Commit a freshly composed draft: insert it, mark the ticket's OLDER pending
 * drafts superseded, then repoint active_draft_id. Insert-first is what makes
 * this safe under concurrent intake runs (webhook retries, multi-message chat
 * bursts): a duplicate run dies on the UNIQUE (gorgias_ticket_id,
 * gorgias_message_id) insert before it can touch the winner's draft. The old
 * supersede-then-insert order let the loser strand a ticket's only draft as
 * 'superseded' with no replacement (2026-07-09). Two runs committing
 * DIFFERENT messages converge on the newest draft regardless of write order:
 * supersede is bounded to id < new id and the active_draft_id update only
 * moves forward.
 */
async function commitDraft(supabase, { ticketRowId, gorgiasTicketId, draftFields }) {
  const { data: newDraft, error: insertErr } = await supabase
    .from('cs_ai_drafts')
    .insert(draftFields)
    .select('id')
    .single();

  if (insertErr) {
    if (insertErr.code === '23505') {
      console.log(`[intake] Ticket ${gorgiasTicketId}: draft for this message already exists (concurrent run) — skipping`);
      return { duplicate: true };
    }
    console.error(`[intake] Insert error for ticket ${gorgiasTicketId}: ${insertErr.message}`);
    return { error: insertErr };
  }

  await supabase
    .from('cs_ai_drafts')
    .update({ status: 'superseded' })
    .eq('gorgias_ticket_id', gorgiasTicketId)
    .eq('status', 'pending')
    .lt('id', newDraft.id);

  await supabase
    .from('cs_tickets')
    .update({ active_draft_id: newDraft.id })
    .eq('id', ticketRowId)
    .or(`active_draft_id.is.null,active_draft_id.lt.${newDraft.id}`);

  return { id: newDraft.id };
}

// ---------------------------------------------------------------------------
// Previous draft context builder
// ---------------------------------------------------------------------------

/**
 * Build structured context from previous AI drafts for this ticket.
 * This tells the AI what was already discussed, decided, and sent.
 */
async function buildPreviousDraftContext(supabase, ticketId) {
  const { data: prevDrafts } = await supabase
    .from('cs_ai_drafts')
    .select('draft_response, sent_response, structured_output, advisor_status, action_type, action_result, status, feedback_notes')
    .eq('gorgias_ticket_id', ticketId)
    .neq('status', 'superseded')
    .order('created_at', { ascending: true });

  if (!prevDrafts?.length) return null;

  const lines = [];
  for (const d of prevDrafts) {
    const s = d.structured_output || {};
    const items = s.intake?.items || [];
    const status = d.advisor_status || 'unknown';

    let summary = `Turn (status: ${status})`;

    // What items were identified
    if (items.length > 0) {
      const itemDescs = items.map(i => {
        let desc = `${i.product || '?'} size ${i.size || '?'}`;
        if (i.issue) desc += ` (${i.issue})`;
        if (i.resolved_size) desc += ` → resolved to ${i.resolved_size}`;
        return desc;
      });
      summary += ` | Items: ${itemDescs.join(', ')}`;
    }

    // What measurements were collected
    if (s.intake?.measurement) summary += ` | Waist: ${s.intake.measurement.value}${s.intake.measurement.unit === 'cm' ? 'cm' : '"'}`;
    if (s.intake?.chest_measurement) summary += ` | Chest: ${s.intake.chest_measurement.value}${s.intake.chest_measurement.unit === 'cm' ? 'cm' : '"'}`;

    // What action was taken
    if (d.action_type) summary += ` | Action: ${d.action_type}`;
    if (d.action_result) summary += ' (executed)';

    // What was actually sent
    if (d.status === 'sent' && d.sent_response) {
      const sentPreview = d.sent_response.substring(0, 200);
      summary += `\nAgent sent: ${sentPreview}`;
    }

    // Donation info already provided?
    const donationMentioned = (d.sent_response || d.draft_response || '').toLowerCase();
    if (donationMentioned.includes('donate') || donationMentioned.includes('rubies returns')) {
      summary += '\n[Donation/return info was already provided to customer]';
    }

    lines.push(summary);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Conversation context builder
// ---------------------------------------------------------------------------

/**
 * Build a summary of all previous messages in a Gorgias ticket
 * (excluding the latest customer message which is handled separately).
 * This gives the AI parser context about what's been discussed.
 */
function buildConversationContext(messages, latestMsgId) {
  // Filter out internal notes and the latest message itself
  const previousMsgs = messages.filter(m =>
    m.id !== latestMsgId && m.channel !== 'internal-note'
  );

  if (previousMsgs.length === 0) return null;

  // Build a compact summary — truncate each message to keep total under 3000 chars
  const maxPerMsg = Math.min(400, Math.floor(3000 / previousMsgs.length));
  const lines = [];

  for (const m of previousMsgs) {
    const sender = m.from_agent === false ? 'Customer' : 'Agent';
    const isBot = m.sender?.email?.endsWith('@email.gorgias.com') || m.via === 'rule';
    if (isBot) continue; // Skip bot auto-replies

    const body = extractCleanBody(m).text.trim();
    if (!body) continue;

    const truncated = body.length > maxPerMsg ? body.substring(0, maxPerMsg) + '...' : body;
    lines.push(`${sender}: ${truncated}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// ---------------------------------------------------------------------------
// Draft formatting
// ---------------------------------------------------------------------------

module.exports = {
  processTicket,
  commitDraft,
  getAiBotUserId,
  buildConversationContext,
  buildPreviousDraftContext,
  checkForDuplicateTicket,
  isInternalRubiesAddress,
  resolveForwardedCustomer,
  tryAutoCloseThankYou,
  buildConversationHistorySnapshot,
  extractInlineImages,
  buildEffectiveAttachments,
  extractCleanBody,
  autoExecuteAdvisorHold,
  autoExecuteAddressChange,
  autoHoldReason,
};
