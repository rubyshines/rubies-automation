/**
 * messageTemplates.js — operator message templates for the composer.
 *
 * Continuations are operator-written (initiate-vs-continue, 2026-09-02), but
 * the common continuation shapes are near-boilerplate, so a template types the
 * predictable part and leaves the human part explicit. Every fill here is a
 * DETERMINISTIC lookup — contact first name, org name, country discount,
 * meeting day — and never a model call: the facts that matter in a
 * continuation happened on a call or in a thread the model cannot see, which
 * is the same reasoning that made continuations operator-written in the first
 * place. Call-specific content gets a highlighted placeholder the operator
 * fills; the send path refuses a body still carrying it.
 *
 * Bodies are drawn from Jamie's real sent mail (Youth OUTright + Le JAG
 * 2026-09-03 for setup_call; Trans Closet of the Hudson Valley 2026-08-10 for
 * partner_onboarding), not an invented register. Adding a template is adding
 * an entry to TEMPLATES plus its fill function.
 *
 * A template application lands in the SAME pending compose row the composer
 * autosaves into (advisor: null — a human owns the words), with
 * `structured.template_id` + `structured.template_body` recording what the
 * template produced so the sent_body diff measures template drift the same way
 * it measures advisor drift.
 */
const { partnerDiscountPercent } = require('./donationAgreement');
const { SIGNATURE_BLOCK_MD, SIGNATURE_NAME } = require('../../customer-service/lib/signatures');

const ONBOARDING_SURVEY_URL = 'https://forms.gle/1Hq93BSiPrhJkgfB8';

// The operator-fills-this marker. sendB2bEmail refuses any body still carrying
// it, so a distracted click can never mail a partner the placeholder. Plain
// hyphen on purpose — customer-facing copy never carries em dashes, and this
// string is one send-guard lapse away from being customer-facing.
const CALL_NOTES_PLACEHOLDER = '[NOTES FROM THE CALL - one or two lines]';

// The CS advisor's signature block verbatim: name line, then the site as a
// markdown link, which the send path renders as an anchor in the HTML part and
// flattens to the bare domain in the plain part. Same convention everywhere.
const SIGN_OFF = `Talk soon,\n\n${SIGNATURE_BLOCK_MD}`;

// Message types whose template already presented the program summary. Manual
// Gmail sends carry message_type null, so a hand-sent intro is undetectable —
// the paragraph then appears and the operator deletes it, which is the cheap
// direction to be wrong in.
const INTRO_TYPES = ['intro_outreach', 'intro_pitch'];

// Past this, "Great talking with you on Monday" stops naming an unambiguous
// day, so the sentence drops the day rather than guessing.
const MEETING_DAY_MAX_AGE_DAYS = 6;

// After this many no-shows on a company, no reschedule ask is offered: the
// annual October check-in carries the relationship instead. Chasing a third
// call is the shape of a partner who has said no without saying it.
const MAX_NO_SHOWS = 2;

/** May we still ask this company for a call? Pure. */
function meetingAsksAllowed(noShowCount) {
  return (Number(noShowCount) || 0) < MAX_NO_SHOWS;
}

/**
 * "Monday" — the meeting's weekday in the OTHER party's timezone (that is the
 * day the sentence names for them), falling back to ET. Null when the meeting
 * is too old for a bare weekday to be unambiguous, or absent. Pure.
 */
function meetingDayName(meeting, now = new Date()) {
  if (!meeting?.starts_at) return null;
  const start = new Date(meeting.starts_at);
  if (Number.isNaN(start.getTime())) return null;
  if ((now - start) / 86400000 > MEETING_DAY_MAX_AGE_DAYS) return null;
  const timeZone = meeting.their_timezone || 'America/Toronto';
  try {
    return start.toLocaleDateString('en-US', { weekday: 'long', timeZone });
  } catch {
    return start.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Toronto' });
  }
}

/** First word of a full name, for the greeting. Pure. */
function greetingName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * "Let's set up a call" — a Tier-1 reply to an interested org or retailer,
 * whether they answered our intro (Youth OUTright) or wrote in cold (Le JAG).
 * The program paragraph appears only when we never sent them an intro: someone
 * replying to our own pitch has already read it. Times are always theirs to
 * suggest, never proposed (standing scheduling decision). Pure.
 */
function fillSetupCall({ firstName, companyName, discount, introEverSent }) {
  const program = introEverSent ? '' : (
    ` I'd be happy to explore a partnership with ${companyName}. We have a donation program `
    + 'where we route refunds and exchanges to orgs as well as a bulk purchase program for '
    + `${discount}% off our retail prices. I am sure we can find other ways to work together.`
  );
  const body = `Hi ${firstName},\n\n`
    + `Great to hear from you.${program}\n\n`
    + 'Let me know if you have 30 mins sometime next week to chat. Feel free to suggest some times.\n\n'
    + SIGN_OFF;
  return { body, attachments: [] };
}

/**
 * Post-call partner onboarding: agreement attached + survey link in the SAME
 * email (the Hudson Valley precedent; purchase reminder reworded by Jamie
 * 2026-09-08), with the call-notes placeholder for the one part only the
 * operator knows. The survey link hangs off its label as a markdown link, the
 * same grammar the CS advisor uses. The agreement rides as a generated spec,
 * rendered fresh at send so it can never carry a stale org name or rate. Pure.
 */
function fillPartnerOnboarding({ firstName, discount, meetingDay }) {
  const talked = meetingDay ? `Great talking with you on ${meetingDay}.` : 'Great talking with you.';
  const body = `Hi ${firstName},\n\n`
    + `${talked} ${CALL_NOTES_PLACEHOLDER}\n\n`
    + `I've attached the agreement to sign and return, and here is the [Onboarding Survey](${ONBOARDING_SURVEY_URL}). `
    + 'Once I have the signed copy and the survey back, we can list you on our site and start routing items your way.\n\n'
    + `Also just a reminder that partner organizations can buy anything on the site at ${discount}% off retail. `
    + "So if you are ever looking to place an order, you can send it my way and I'll take care of it.\n\n"
    + SIGN_OFF;
  return { body, attachments: [{ kind: 'partner_agreement' }] };
}

/**
 * The reply that goes with a booked call (Book & Send in the Schedule panel).
 * `confirmationLine` is scheduleMeeting's one deterministic sentence naming the
 * time in both zones; this wraps it in Jamie's own reply (2026-09-08) so the
 * composer opens with the whole message rather than one sentence dropped into
 * an empty box. Pure.
 */
function fillMeetingConfirmation({ firstName, confirmationLine }) {
  const body = `Hi ${firstName},\n\n`
    + `${confirmationLine}\n\n`
    + 'Looking forward to chatting.\n\n'
    + SIGN_OFF;
  return { body, attachments: [] };
}

/**
 * After a no-show: a neutral reschedule ask. Blame-free in both directions
 * ("we missed each other", never "you missed"), and the times stay theirs to
 * suggest (standing scheduling decision). The day is named only while a bare
 * weekday is unambiguous, same rule as the onboarding template. Pure.
 */
function fillMissedCall({ firstName, meetingDay }) {
  const missed = meetingDay ? `Sorry we missed each other on ${meetingDay}.` : 'Sorry we missed each other.';
  const body = `Hi ${firstName},\n\n`
    + `${missed} Let me know if you would like to find another time. Feel free to suggest a few.\n\n`
    + SIGN_OFF;
  return { body, attachments: [] };
}

// ---------------------------------------------------------------------------
// The follow-up ladder (2026-09-08)
//
// followup_1 / followup_2 were Opus drafts that auto-sent unreviewed, and the
// prompt that shaped them ("add one new hook", never "just circling back") is
// precisely the instruction that produces a sales pitch. Nothing customer-facing
// leaves unreviewed unless it is fixed text, so the rungs are now the CS auto
// follow-up's shape: rung 1 is one line; rung 2 says the earlier notes may have
// gone to spam and quotes the message being chased, so a reader who sees only
// this email still gets the whole ask. Both go as replies in the thread. Zero
// model calls, same greeting resolution as every other template.
// ---------------------------------------------------------------------------

const FOLLOW_UP_TYPES = new Set(['followup_1', 'followup_2']);

/**
 * The quotable part of one of our outbound messages: everything above the
 * valediction and signature. The signature is dropped because the send path
 * normalises the FIRST "Jamie Alexander, RUBIES Founder" it finds — inside a
 * quote that would splice a bare site line between two "> " lines — and
 * because quoting your own sign-off is noise. Pure.
 */
function quotableBody(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let end = lines.findIndex(l => l.includes(SIGNATURE_NAME));
  if (end === -1) end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  // "Talk soon," / "Take care," sits on its own line just above the signature.
  if (end > 0 && /^[A-Za-z][A-Za-z' ]{0,30},$/.test(lines[end - 1].trim())) end--;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join('\n').trim();
}

/** "> " on every line, the way every mail client quotes. Pure. */
function quoteLines(text) {
  return String(text || '').split('\n').map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
}

/**
 * The two rungs. `original` is the body of the message being chased; without
 * one (thread lost, message never mirrored) rung 2 falls back to the one-liner
 * rather than promising a quote it cannot show. Pure.
 */
function fillFollowUp({ firstName, message_type, original }) {
  const greeting = `Hi ${firstName},`;
  const quote = message_type === 'followup_2' ? quotableBody(original) : '';
  if (quote) {
    return {
      body: `${greeting}\n\n`
        + 'I wanted to follow up in case my earlier notes ended up in your spam folder. This is what I wrote:\n\n'
        + `${quoteLines(quote)}\n\n`
        + SIGN_OFF,
      attachments: [],
    };
  }
  return { body: `${greeting}\n\nI am following up on this.\n\n${SIGN_OFF}`, attachments: [] };
}

/**
 * The message a rung is chasing: the newest outbound in the thread that is not
 * itself a rung (so rung 2 quotes the intro, not rung 1). Null when the thread
 * holds none we can show.
 */
async function chasedMessage(sb, { company_id, thread_id } = {}) {
  if (!thread_id) return null;
  const { data, error } = await sb.from('b2b_messages')
    .select('id, body_text, message_type, sent_at')
    .eq('company_id', company_id).eq('thread_id', thread_id).eq('direction', 'outbound')
    .order('sent_at', { ascending: false }).limit(10);
  if (error) throw new Error(`chased message lookup: ${error.message}`);
  return (data || []).find(m => !FOLLOW_UP_TYPES.has(m.message_type) && (m.body_text || '').trim()) || null;
}

/**
 * Build and store a rung as the company's pending draft. Same landing as an
 * applied composer template: advisor null (fixed text, no model), thread
 * inherited, provenance in structured.template_id / template_body. Called from
 * generateDraftForCompany whenever the live queue entry is a rung, so every
 * path that used to reach the advisor for a follow-up (nightly pass, panel
 * Draft, console tool) gets the template instead. Returns the same shape the
 * advisor path returns, as far as callers read it.
 */
async function composeFollowUp(sb, { company_id, entry } = {}) {
  if (!FOLLOW_UP_TYPES.has(entry?.message_type)) throw new Error(`'${entry?.message_type}' is not a follow-up rung`);
  const { resolveRecipient } = require('./sendB2bEmail');
  const recipient = await resolveRecipient(sb, company_id);
  const chased = await chasedMessage(sb, { company_id, thread_id: entry.thread_id });
  const { body } = fillFollowUp({
    firstName: greetingName(recipient?.name),
    message_type: entry.message_type,
    original: chased?.body_text || null,
  });

  // Lazy require: queueService sits above this module in the import graph.
  const { composeDraft } = require('./queueService');
  const composed = await composeDraft(sb, {
    company_id, body, message_type: entry.message_type, thread_id: entry.thread_id || undefined,
  });
  const { data: row, error } = await sb.from('b2b_drafts')
    .select('id, structured').eq('id', composed.draft_id).maybeSingle();
  if (error) throw new Error(`draft readback: ${error.message}`);
  const structured = {
    ...(row?.structured || {}),
    template_id: entry.message_type,
    template_body: body,
    ...(chased ? { quoted_message_id: chased.id } : {}),
  };
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', composed.draft_id);
  if (uErr) throw new Error(`template structured update: ${uErr.message}`);

  return {
    draft_id: composed.draft_id, company_id, message_type: entry.message_type,
    template_id: entry.message_type, email_subject: null, email_body: body, advisor: null,
  };
}

const TEMPLATES = [
  { id: 'setup_call', label: 'Set up a call', fill: fillSetupCall },
  // The agreement is the LGBTQ+ org donation-program contract, so this
  // template only makes sense for orgs.
  { id: 'partner_onboarding', label: 'Partner onboarding (agreement + survey)', orgOnly: true, fill: fillPartnerOnboarding },
  // Offered only once the last call on record is a recorded no-show, and never
  // past MAX_NO_SHOWS. Sent as its own message_type so the ladder chases it,
  // with a next touch of a week so the company comes back as a reminder.
  { id: 'missed_call', label: 'Missed call (ask to reschedule)', afterNoShow: true, fill: fillMissedCall, message_type: 'missed_call', next_touch_days: 7 },
];

/** Everything the fills need for one company, gathered once. */
async function templateContext(sb, company_id) {
  if (!company_id) throw new Error('company_id required');
  const { data: company, error } = await sb.from('b2b_companies')
    .select('id, name, country, relationship_type').eq('id', company_id).maybeSingle();
  if (error) throw new Error(`company lookup: ${error.message}`);
  if (!company) throw new Error(`company '${company_id}' not found`);

  // Same resolution the send path uses, so the greeting names whoever the
  // email will actually go to.
  const { resolveRecipient } = require('./sendB2bEmail');
  const recipient = await resolveRecipient(sb, company_id);

  const { data: intros, error: iErr } = await sb.from('b2b_messages')
    .select('id').eq('company_id', company_id).eq('direction', 'outbound')
    .in('message_type', INTRO_TYPES).limit(1);
  if (iErr) throw new Error(`intro lookup: ${iErr.message}`);

  const { lastHeldMeetingsByCompany, noShowCount } = require('./scheduleMeeting');
  const held = await lastHeldMeetingsByCompany(sb, [company_id]);
  const noShows = await noShowCount(sb, company_id);

  return {
    company,
    firstName: greetingName(recipient?.name),
    introEverSent: !!intros?.length,
    lastMeeting: held.get(company_id) || null,
    noShowCount: noShows,
  };
}

/** Why a no-show template is or is not on offer for this context. Pure. */
function missedCallAvailability(ctx) {
  if (ctx.lastMeeting?.outcome !== 'no_show') return { ok: false, reason: 'the last call on record was not marked a no-show' };
  if (!meetingAsksAllowed(ctx.noShowCount)) {
    return { ok: false, reason: `${ctx.noShowCount} no-shows on record — no more call asks; the October check-in carries this one` };
  }
  return { ok: true, reason: null };
}

/** The picker's list for one company: [{ id, label, note }]. */
async function listTemplates(sb, { company_id } = {}) {
  const ctx = await templateContext(sb, company_id);
  const discount = partnerDiscountPercent(ctx.company.country);
  const out = [];
  for (const t of TEMPLATES) {
    if (t.orgOnly && ctx.company.relationship_type !== 'lgbtq_org') continue;
    if (t.afterNoShow && !missedCallAvailability(ctx).ok) continue;
    let note;
    if (t.id === 'missed_call') {
      const day = meetingDayName(ctx.lastMeeting);
      note = `reschedule ask${day ? ` for the missed ${day} call` : ''}, chased after 5 business days`;
    } else if (t.id === 'setup_call') {
      note = ctx.introEverSent ? 'call ask only (they already have our intro)' : `includes the program summary (${discount}%)`;
    } else if (t.id === 'partner_onboarding') {
      const day = meetingDayName(ctx.lastMeeting);
      note = `attaches the agreement (${discount}%) + survey link${day ? `, references your ${day} call` : ''}`;
    }
    out.push({ id: t.id, label: t.label, note });
  }
  return out;
}

/**
 * Fill a template and land it as the company's pending compose row —
 * attachments and provenance included, so the composer opens ready to edit and
 * a refresh loses nothing.
 */
async function applyTemplate(sb, { company_id, template_id } = {}) {
  const template = TEMPLATES.find(t => t.id === template_id);
  if (!template) throw new Error(`unknown template '${template_id}'`);
  const ctx = await templateContext(sb, company_id);
  if (template.orgOnly && ctx.company.relationship_type !== 'lgbtq_org') {
    throw new Error(`'${template_id}' is for LGBTQ+ orgs; ${ctx.company.name} is a ${ctx.company.relationship_type}`);
  }
  if (template.afterNoShow) {
    const avail = missedCallAvailability(ctx);
    if (!avail.ok) throw new Error(`'${template_id}' is not offered for ${ctx.company.name}: ${avail.reason}`);
  }

  const { body, attachments } = template.fill({
    firstName: ctx.firstName,
    companyName: ctx.company.name,
    discount: partnerDiscountPercent(ctx.company.country),
    introEverSent: ctx.introEverSent,
    meetingDay: meetingDayName(ctx.lastMeeting),
  });

  // composeDraft supersedes any prior pending row and inherits thread +
  // message_type from the company's live queue entry (a post_call_followup
  // entry carries the meeting's thread), so the follow-up lands threaded on
  // the conversation it continues. Lazy require: queueService sits above this
  // module in the import graph.
  const { composeDraft } = require('./queueService');
  const composed = await composeDraft(sb, {
    company_id,
    body,
    // A template that is its own message type (missed_call) says so, so the
    // send stamps the right next-touch and the ladder knows what to chase.
    ...(template.message_type ? { message_type: template.message_type } : {}),
    // The onboarding follow-up belongs on the meeting's own thread even when
    // the queue has no entry for the company (e.g. applied from the directory).
    thread_id: ['partner_onboarding', 'missed_call'].includes(template.id) ? (ctx.lastMeeting?.thread_id || undefined) : undefined,
  });

  const { data: row, error } = await sb.from('b2b_drafts')
    .select('id, structured').eq('id', composed.draft_id).maybeSingle();
  if (error) throw new Error(`draft readback: ${error.message}`);
  const { withAttachment } = require('./draftAttachments');
  let structured = {
    ...(row?.structured || {}),
    template_id: template.id,
    template_body: body,
    ...(template.next_touch_days ? { next_touch_days: template.next_touch_days } : {}),
  };
  for (const spec of attachments) structured = withAttachment(structured, spec);
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured }).eq('id', composed.draft_id);
  if (uErr) throw new Error(`template structured update: ${uErr.message}`);

  return { draft_id: composed.draft_id, template_id: template.id, company_id };
}

module.exports = {
  TEMPLATES,
  ONBOARDING_SURVEY_URL,
  CALL_NOTES_PLACEHOLDER,
  MEETING_DAY_MAX_AGE_DAYS,
  meetingDayName,
  greetingName,
  fillSetupCall,
  fillPartnerOnboarding,
  fillMeetingConfirmation,
  fillMissedCall,
  MAX_NO_SHOWS,
  meetingAsksAllowed,
  missedCallAvailability,
  FOLLOW_UP_TYPES,
  quotableBody,
  quoteLines,
  fillFollowUp,
  chasedMessage,
  composeFollowUp,
  templateContext,
  listTemplates,
  applyTemplate,
};
