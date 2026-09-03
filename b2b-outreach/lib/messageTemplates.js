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
const { SIGNATURE_NAME, SITE_LABEL } = require('../../customer-service/lib/signatures');

const ONBOARDING_SURVEY_URL = 'https://forms.gle/1Hq93BSiPrhJkgfB8';

// The operator-fills-this marker. sendB2bEmail refuses any body still carrying
// it, so a distracted click can never mail a partner the placeholder. Plain
// hyphen on purpose — customer-facing copy never carries em dashes, and this
// string is one send-guard lapse away from being customer-facing.
const CALL_NOTES_PLACEHOLDER = '[NOTES FROM THE CALL - one or two lines]';

const SIGN_OFF = `Talk soon,\n\n${SIGNATURE_NAME}\n${SITE_LABEL}`;

// Message types whose template already presented the program summary. Manual
// Gmail sends carry message_type null, so a hand-sent intro is undetectable —
// the paragraph then appears and the operator deletes it, which is the cheap
// direction to be wrong in.
const INTRO_TYPES = ['intro_outreach', 'intro_pitch'];

// Past this, "Great talking with you on Monday" stops naming an unambiguous
// day, so the sentence drops the day rather than guessing.
const MEETING_DAY_MAX_AGE_DAYS = 6;

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
 * email (the Hudson Valley precedent), with the call-notes placeholder for the
 * one part only the operator knows. The agreement rides as a generated spec,
 * rendered fresh at send so it can never carry a stale org name or rate. Pure.
 */
function fillPartnerOnboarding({ firstName, discount, meetingDay }) {
  const talked = meetingDay ? `Great talking with you on ${meetingDay}.` : 'Great talking with you.';
  const body = `Hi ${firstName},\n\n`
    + `${talked} ${CALL_NOTES_PLACEHOLDER}\n\n`
    + `I've attached the agreement to sign and return, and here is the onboarding survey: ${ONBOARDING_SURVEY_URL}. `
    + 'Once I have the signed copy and the survey back, we can list you on our site and start routing items your way.\n\n'
    + `On purchasing: partner organizations buy anything on the site at ${discount}% off retail. `
    + "Once you're set up, send your next order my way and I'll take care of it.\n\n"
    + SIGN_OFF;
  return { body, attachments: [{ kind: 'partner_agreement' }] };
}

const TEMPLATES = [
  { id: 'setup_call', label: 'Set up a call', fill: fillSetupCall },
  // The agreement is the LGBTQ+ org donation-program contract, so this
  // template only makes sense for orgs.
  { id: 'partner_onboarding', label: 'Partner onboarding (agreement + survey)', orgOnly: true, fill: fillPartnerOnboarding },
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

  const { lastHeldMeetingsByCompany } = require('./scheduleMeeting');
  const held = await lastHeldMeetingsByCompany(sb, [company_id]);

  return {
    company,
    firstName: greetingName(recipient?.name),
    introEverSent: !!intros?.length,
    lastMeeting: held.get(company_id) || null,
  };
}

/** The picker's list for one company: [{ id, label, note }]. */
async function listTemplates(sb, { company_id } = {}) {
  const ctx = await templateContext(sb, company_id);
  const discount = partnerDiscountPercent(ctx.company.country);
  const out = [];
  for (const t of TEMPLATES) {
    if (t.orgOnly && ctx.company.relationship_type !== 'lgbtq_org') continue;
    let note;
    if (t.id === 'setup_call') {
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
    // The onboarding follow-up belongs on the meeting's own thread even when
    // the queue has no entry for the company (e.g. applied from the directory).
    thread_id: template.id === 'partner_onboarding' ? (ctx.lastMeeting?.thread_id || undefined) : undefined,
  });

  const { data: row, error } = await sb.from('b2b_drafts')
    .select('id, structured').eq('id', composed.draft_id).maybeSingle();
  if (error) throw new Error(`draft readback: ${error.message}`);
  const { withAttachment } = require('./draftAttachments');
  let structured = { ...(row?.structured || {}), template_id: template.id, template_body: body };
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
  templateContext,
  listTemplates,
  applyTemplate,
};
