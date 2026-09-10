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
const { wholesaleTermsLines, wholesaleDiscountFor, pageViewFor, pageUrlFor, isDomestic, HOW_IT_WORKS_URL } = require('./wholesalePriceList');
const { SIGNATURE_BLOCK_MD, SIGNATURE_NAME } = require('../../customer-service/lib/signatures');

const ONBOARDING_SURVEY_URL = 'https://forms.gle/1Hq93BSiPrhJkgfB8';

// The waiting-in-room nudge goes out as a fresh email under this subject: a
// note that has to be seen in the next two minutes cannot hide behind "Re:".
// Jamie's own subject line (Le JAG, 2026-09-10), sentence-cased.
const WAITING_IN_ROOM_SUBJECT = 'In the meeting room right now';

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
 * Wholesale terms for a retailer (2026-09-09): the terms inline and the
 * storefront page linked. The terms sentences come from wholesalePriceList.js,
 * the same lines the page prints, so the two surfaces cannot drift. Pure.
 */
function fillWholesaleTerms({ firstName, discount, country }) {
  // Bulleted (Jamie 2026-09-10): a hyphen bullet reads the same in the plain
  // part and the HTML part, which preserves line breaks and nothing more.
  const terms = wholesaleTermsLines(discount, { international: !isDomestic(country) }).map(t => `- ${t}`).join('\n');
  // The page IS the price list (Jamie 2026-09-10: no PDF), and it is
  // country-aware: the link carries their country so it shows their rate and
  // terms. A negotiated rate the page cannot show (a stored
  // wholesale_discount_percent off the country rule) is stated plainly next
  // to the link rather than carried by a separate document.
  const pageRate = pageViewFor(country).rate;
  const negotiated = Number(discount) !== pageRate
    ? `The page shows our standard ${pageRate}% rate. Your pricing is ${Number(discount)}% off, as agreed, so take that off the retail prices shown.\n\n`
    : '';
  const body = `Hi ${firstName},\n\n`
    + 'Thanks for your interest in carrying RUBIES. Here are our wholesale terms, and the price list is here: '
    + `[Wholesale pricing](${pageUrlFor(country)}). `
    + `If you are new to RUBIES, here is [how it works](${HOW_IT_WORKS_URL}).\n\n`
    + `${terms}\n\n`
    + negotiated
    + 'Let me know if you have any questions. It would be great to set up a quick call to discuss.\n\n'
    + SIGN_OFF;
  return { body, attachments: [] };
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

/**
 * Sent from inside the meeting room when they have not joined (Jamie's note to
 * Le JAG, 2026-09-10, word for word). A question and the link, nothing else.
 * The link is the calendar event's; when the event has none the sentence points
 * at the invite rather than inventing a room. The URL is its own label so the
 * HTML part is clickable and the plain part still shows where it goes. Pure.
 */
function fillWaitingInRoom({ firstName, meetUrl }) {
  const link = meetUrl ? `Here is the link: [${meetUrl}](${meetUrl})` : 'The link is in the calendar invite.';
  const body = `Hi ${firstName},\n\n`
    + 'I am in the meeting room - just checking if you still plan to attend.\n\n'
    + `${link}\n\n`
    + `Thanks,\n\n${SIGNATURE_BLOCK_MD}`;
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

// ---------------------------------------------------------------------------
// The retailer re-approach after samples (2026-09-09)
//
// Thirteen stores were sent sample kits in November 2025, then an apology, then
// a wholesale pitch, and never replied. The re-approach is fixed text locked
// with Jamie line by line: pitch first (the reader may not remember the kit,
// so the email says who is writing before it mentions it), then the samples,
// then the terms. Zero model calls, like the follow-up rungs; the only fills
// are the greeting and when the kit went out. The subject is
// one of two fixed A/B strings (fixedSubjects.js).
// ---------------------------------------------------------------------------

const SEASONS = [['winter', [12, 1, 2]], ['spring', [3, 4, 5]], ['summer', [6, 7, 8]], ['fall', [9, 10, 11]]];

/**
 * "last fall" / "last spring" / "in March 2025": when the kit went out, as a
 * person would say it. A season is "last <season>" only once it is over and
 * still within about a year; anything older names the month and year, and a
 * kit from the current season is "recently". Pure.
 */
function whenPhrase(sampledAt, now = new Date()) {
  const d = new Date(sampledAt);
  if (Number.isNaN(d.getTime())) return 'recently';
  const month = d.getUTCMonth() + 1;
  const [season] = SEASONS.find(([, months]) => months.includes(month));
  // Season end: the last day of its final month (winter spans the year).
  const endYear = season === 'winter' && month === 12 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const endMonth = { winter: 2, spring: 5, summer: 8, fall: 11 }[season];
  const seasonEnd = new Date(Date.UTC(endYear, endMonth, 1)); // first day after the season
  const daysSinceEnd = (now - seasonEnd) / 86400000;
  if (daysSinceEnd < 0) return 'recently';
  if (daysSinceEnd <= 400) return `last ${season}`;
  const monthName = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return `in ${monthName} ${d.getUTCFullYear()}`;
}

/** The locked body. Pure. */
function fillRetailerReApproach({ firstName, when }) {
  // "we sent you", never the store name: naming it read as a mail merge (Jamie, 2026-09-09).
  const sent = when ? `${when[0].toUpperCase()}${when.slice(1)} we sent you a sample kit` : 'We sent you a sample kit';
  const body = `Hi ${firstName},\n\n`
    + "I'm Jamie, founder of RUBIES. We make gender-affirming underwear and swimwear for trans women and girls, "
    + 'designed to feel like regular clothing, no tucking or compression needed. '
    + 'The brand started with my own trans daughter, who could not find anything that worked.\n\n'
    + `${sent} and I would love to hear what you thought of the items.\n\n`
    + 'Our wholesale terms are 50% off retail with free shipping. '
    + 'Let me know if you have any questions or if you would like to set up a quick conversation.\n\n'
    + SIGN_OFF;
  return { body, attachments: [] };
}

/**
 * Does this queue entry get the template rather than an advisor draft? Only a
 * RETAILER re_approach with a kit on record: an org re_approach stays an Opus
 * draft (it has to name what the old thread was about), and a retailer
 * re_approach with no samples has nothing fixed to say. Pure.
 */
function isRetailerSamplesReApproach(company, entry) {
  return entry?.message_type === 're_approach'
    && company?.relationship_type === 'wholesale'
    && !!company?.samples_shipped_at;
}

/**
 * Build and store the sampled-retailer re-approach as the company's pending
 * draft: fixed body, fixed A/B subject, new thread, advisor null, provenance in
 * structured.template_id / template_body. Same landing as a follow-up rung.
 */
async function composeRetailerReApproach(sb, { company_id, entry, variant_id, now = new Date() } = {}) {
  const { data: company, error } = await sb.from('b2b_companies')
    .select('id, name, relationship_type, samples_shipped_at').eq('id', company_id).maybeSingle();
  if (error) throw new Error(`company lookup: ${error.message}`);
  if (!isRetailerSamplesReApproach(company, entry)) throw new Error(`'${company?.name || company_id}' is not a sampled retailer re_approach`);
  const { resolveRecipient } = require('./sendB2bEmail');
  const recipient = await resolveRecipient(sb, company_id);
  const when = whenPhrase(company.samples_shipped_at, now);
  const { body } = fillRetailerReApproach({ firstName: greetingName(recipient?.name), when });
  const { fixedSubjectFor } = require('./fixedSubjects');
  const subject = fixedSubjectFor('re_approach', variant_id, company.name, { when });
  if (!subject) throw new Error(`no fixed subject for re_approach variant '${variant_id}'`);

  const { composeDraft } = require('./queueService');
  const composed = await composeDraft(sb, { company_id, body, subject, message_type: 're_approach' });
  const { data: row, error: rErr } = await sb.from('b2b_drafts')
    .select('id, structured').eq('id', composed.draft_id).maybeSingle();
  if (rErr) throw new Error(`draft readback: ${rErr.message}`);
  const structured = { ...(row?.structured || {}), template_id: 'retailer_re_approach', template_body: body };
  const { error: uErr } = await sb.from('b2b_drafts').update({ structured, variant_id }).eq('id', composed.draft_id);
  if (uErr) throw new Error(`template structured update: ${uErr.message}`);

  return {
    draft_id: composed.draft_id, company_id, message_type: 're_approach', variant_id,
    template_id: 'retailer_re_approach', email_subject: subject, email_body: body, advisor: null,
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
  // Offered only while a booked call is live (scheduleMeeting.isMeetingLive)
  // and no outcome is recorded yet. Its own message_type so the activity log
  // says what it was; a fresh thread with its own subject, because mid-meeting
  // the subject line is the message.
  { id: 'waiting_in_room', label: "In the meeting room (they haven't joined)", duringCall: true, fill: fillWaitingInRoom, message_type: 'meeting_nudge', subject: WAITING_IN_ROOM_SUBJECT, new_thread: true },
  // The price list is a retailer document; an org's purchase terms are in the
  // agreement and the onboarding template already states its rate.
  // `subject` is used only when the draft starts a new thread; a reply keeps
  // inheriting the thread's subject like every other template.
  { id: 'wholesale_terms', label: 'Wholesale terms + price list', retailerOnly: true, fill: fillWholesaleTerms, subject: 'RUBIES wholesale terms and pricing' },
];

/** Everything the fills need for one company, gathered once. */
async function templateContext(sb, company_id, now = new Date()) {
  if (!company_id) throw new Error('company_id required');
  const { data: company, error } = await sb.from('b2b_companies')
    .select('id, name, country, relationship_type, wholesale_discount_percent').eq('id', company_id).maybeSingle();
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

  const { lastHeldMeetingsByCompany, noShowCount, liveMeeting } = require('./scheduleMeeting');
  const held = await lastHeldMeetingsByCompany(sb, [company_id], now);
  const noShows = await noShowCount(sb, company_id);
  const live = await liveMeeting(sb, company_id, now);

  return {
    company,
    firstName: greetingName(recipient?.name),
    introEverSent: !!intros?.length,
    lastMeeting: held.get(company_id) || null,
    noShowCount: noShows,
    liveMeeting: live,
  };
}

/** Why the waiting-in-room nudge is or is not on offer for this context. Pure. */
function waitingInRoomAvailability(ctx) {
  if (!ctx.liveMeeting) return { ok: false, reason: 'no call is in progress right now' };
  return { ok: true, reason: null };
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
    if (t.retailerOnly && ctx.company.relationship_type !== 'wholesale') continue;
    if (t.afterNoShow && !missedCallAvailability(ctx).ok) continue;
    if (t.duringCall && !waitingInRoomAvailability(ctx).ok) continue;
    let note;
    if (t.id === 'waiting_in_room') {
      note = ctx.liveMeeting.meet_url ? 'fresh email with the meeting link' : 'fresh email; the event has no link, so it points at the invite';
    } else if (t.id === 'wholesale_terms') {
      const rate = wholesaleDiscountFor(ctx.company);
      // An unknown country quotes the conservative rate; say so, because a US
      // store with no country on file would otherwise be offered 30% in silence.
      const unknown = ctx.company.wholesale_discount_percent == null && !String(ctx.company.country || '').trim();
      note = `terms inline at ${rate}%${unknown ? ' (country unknown: set it in the sidebar for the right rate)' : ''}`
        + ' + link to the pricing page for their country'
        + (rate === pageViewFor(ctx.company.country).rate ? '' : ' (negotiated rate stated in the email; the page shows the standard rate)');
    } else if (t.id === 'missed_call') {
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
  if (template.retailerOnly && ctx.company.relationship_type !== 'wholesale') {
    throw new Error(`'${template_id}' is for retailers; ${ctx.company.name} is a ${ctx.company.relationship_type}`);
  }
  if (template.afterNoShow) {
    const avail = missedCallAvailability(ctx);
    if (!avail.ok) throw new Error(`'${template_id}' is not offered for ${ctx.company.name}: ${avail.reason}`);
  }
  if (template.duringCall) {
    const avail = waitingInRoomAvailability(ctx);
    if (!avail.ok) throw new Error(`'${template_id}' is not offered for ${ctx.company.name}: ${avail.reason}`);
  }

  const { body, attachments } = template.fill({
    firstName: ctx.firstName,
    companyName: ctx.company.name,
    country: ctx.company.country,
    // A retailer's rate honours a stored negotiated figure; the org lookups
    // stay on the country default the agreement is written at.
    discount: template.retailerOnly ? wholesaleDiscountFor(ctx.company) : partnerDiscountPercent(ctx.company.country),
    introEverSent: ctx.introEverSent,
    meetingDay: meetingDayName(ctx.lastMeeting),
    meetUrl: ctx.liveMeeting?.meet_url || null,
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
    ...(template.subject ? { subject: template.subject } : {}),
    // The onboarding follow-up belongs on the meeting's own thread even when
    // the queue has no entry for the company (e.g. applied from the directory).
    // An explicit null is composeDraftRow's "fresh thread, on purpose".
    thread_id: template.new_thread
      ? null
      : (['partner_onboarding', 'missed_call'].includes(template.id) ? (ctx.lastMeeting?.thread_id || undefined) : undefined),
  });

  const { data: row, error } = await sb.from('b2b_drafts')
    .select('id, structured, thread_id, subject').eq('id', composed.draft_id).maybeSingle();
  if (error) throw new Error(`draft readback: ${error.message}`);
  const { withAttachment } = require('./draftAttachments');
  let structured = {
    ...(row?.structured || {}),
    template_id: template.id,
    template_body: body,
    ...(template.next_touch_days ? { next_touch_days: template.next_touch_days } : {}),
    ...(template.duringCall && ctx.liveMeeting ? { meeting_id: ctx.liveMeeting.id } : {}),
  };
  for (const spec of attachments) structured = withAttachment(structured, spec);
  // A draft with no thread starts a new email, and the send path refuses one
  // with no subject; a template that carries a subject supplies it here, and
  // only here, so a reply still inherits the thread's.
  const update = { structured };
  if (template.subject && !row?.thread_id && !row?.subject) update.subject = template.subject;
  const { error: uErr } = await sb.from('b2b_drafts').update(update).eq('id', composed.draft_id);
  if (uErr) throw new Error(`template structured update: ${uErr.message}`);

  return { draft_id: composed.draft_id, template_id: template.id, company_id };
}

module.exports = {
  whenPhrase, fillRetailerReApproach, isRetailerSamplesReApproach, composeRetailerReApproach,
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
  fillWaitingInRoom,
  WAITING_IN_ROOM_SUBJECT,
  waitingInRoomAvailability,
  fillWholesaleTerms,
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
