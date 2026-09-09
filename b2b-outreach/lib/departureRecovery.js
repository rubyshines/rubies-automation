/**
 * departureRecovery.js — turn a "X is no longer with the organization" notice
 * into a contact change and a retry, the way bounceRecovery turns a DSN into one.
 *
 * Before this, a departure notice set `contact_unknown` and stopped. That was
 * the designed behaviour ("the operator resolves it with update_contact"), and
 * it produced the worst version of the panel: a Tier-1 row with an empty
 * composer, a header saying the last send "bounced", the departed person still
 * shown as primary, and the notice itself folded into the closed-thread archive
 * because the autoresponder gave it a new subject. Everything the engine knew
 * was true, and none of it was where the operator would look.
 *
 * A departure is a bounce's sibling, with one difference that makes it BETTER
 * information: the org usually names where to write instead. Bounce recovery
 * refuses to pick an alternate address on its own because a guessed address is
 * what drives the bounce rate. An address the organisation itself printed in
 * its own autoresponder is not a guess, so this module acts on it — through a
 * deterministic gate (the address must be at the company's own domain, or
 * already on file) and the existing `updateCompanyContact`, which refuses an
 * address registered to another company.
 *
 * The extraction is a narrow Sonnet task on purpose (CLAUDE.md model policy):
 * who left, and which address the notice says to use. It fails closed — no
 * usable redirect means the company keeps today's behaviour (contact_unknown,
 * Tier-1 "no working address") with a reason that at least names who left.
 *
 * The retry rides the follow-up ladder's own mechanism: an initiating message
 * that Jamie sent unedited is re-rendered for the new recipient (initiating
 * drafts are locked templates, so a fresh render fixes the greeting with no
 * model risk) and stamped with a scheduled send, so it goes out in the org's
 * morning window under the same daily cap and pre-send guards as a follow-up,
 * visible under the dashboard's follow-ups pill with a cancel until then. A
 * message Jamie had edited is bespoke text: it is revived as a pending draft
 * for review instead, seeded from what he actually sent.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { normalizeAddress, splitAddresses, reachableAlternates } = require('./bounceRecovery');
const { identifyingDomain, isSystemMailbox } = require('./emailDomains');

const UNDELIVERED_REASON = 'recipient left the organisation';

const EXTRACT_TOOL = {
  name: 'submit_departure',
  description: 'Submit what the departure notice says: who has left, and which address (if any) it tells the sender to use instead.',
  input_schema: {
    type: 'object',
    properties: {
      departed_name: { type: ['string', 'null'], description: 'Full name of the person who has left, exactly as the notice gives it. null if not named.' },
      departed_email: { type: ['string', 'null'], description: 'Email address of the person who has left, ONLY if the notice states it. null otherwise.' },
      redirect_email: { type: ['string', 'null'], description: 'The ONE address the notice tells the sender to contact instead. null when the notice gives none, gives several with no clear instruction, or only lists a website or phone number.' },
      redirect_name: { type: ['string', 'null'], description: 'Name of the person at the redirect address, if the notice gives one (a person, not a team). null for a general inbox.' },
      redirect_title: { type: ['string', 'null'], description: 'Their role or title if given. null otherwise.' },
    },
    required: ['departed_name', 'departed_email', 'redirect_email', 'redirect_name', 'redirect_title'],
  },
};

const SYSTEM_PROMPT = `You read an automatic email reply that says someone has left an organization, and extract two facts: who left, and which single email address the notice says to use instead.

Rules:
- Copy addresses and names exactly as written. Never invent, complete, or guess an address.
- redirect_email is ONLY an address the notice explicitly directs the sender to ("please contact X", "reach out to Y going forward", "direct all inquiries to Z"). A signature block, a footer, or a list of departments is not a direction. If the notice names more than one address without saying which to use, return null.
- The departed person's own address is never the redirect.
- A website, phone number, or contact form is not an email address: return null for redirect_email.
- When unsure about any field, return null for it.`;

/**
 * Ask Sonnet who left and where the notice says to write. Fail-closed: any
 * error or malformed answer reads as "nothing extracted".
 */
async function extractDeparture({ subject, body, sender, companyName } = {}) {
  const empty = { departed_name: null, departed_email: null, redirect_email: null, redirect_name: null, redirect_title: null };
  const text = String(body || '').trim();
  if (!text) return empty;
  let response;
  try {
    response = await callClaude({
      // Sonnet on purpose: narrow structured extraction, deterministic gate
      // after it, and the send that follows is reviewed or template-locked.
      component: 'b2b_departure_extract',
      model: MODELS.SONNET,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_departure' },
      messages: [{ role: 'user', content:
        `[ORGANIZATION] ${companyName || '(unknown)'}\n` +
        `[FROM] ${sender || '(unknown)'}\n` +
        `[SUBJECT] ${subject || ''}\n\n` +
        `[NOTICE]\n${text.slice(0, 3000)}` }],
    });
  } catch (err) {
    console.warn(`[departure] extraction failed: ${err.message}`);
    return empty;
  }
  const toolUse = (response.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_departure');
  if (!toolUse?.input) return empty;
  const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 200) : null;
  return {
    departed_name: str(toolUse.input.departed_name),
    departed_email: normalizeAddress(str(toolUse.input.departed_email)) || null,
    redirect_email: normalizeAddress(str(toolUse.input.redirect_email)) || null,
    redirect_name: str(toolUse.input.redirect_name),
    redirect_title: str(toolUse.input.redirect_title),
  };
}

/**
 * Should the engine write to the address the notice names? PURE.
 *
 * The bar: the address belongs to this organisation. Same identifying domain
 * as the company's site or the departed mailbox, or an address the company
 * already has on file (a contact, or its general inbox). Anything else — a
 * personal Gmail, a parent org, a consultant — is left for the operator, who
 * can see the notice and decide. A system mailbox (noreply@) is never a person
 * to write to.
 */
function acceptRedirect({ redirect, departed, company, contacts } = {}) {
  const r = normalizeAddress(redirect);
  if (!r) return { ok: false, why: 'no redirect address in the notice' };
  const d = normalizeAddress(departed);
  if (d && r === d) return { ok: false, why: 'redirect is the departed address itself' };
  if (isSystemMailbox(r)) return { ok: false, why: `${r} is a system mailbox` };

  const onFile = (contacts || []).some(c => normalizeAddress(c.email) === r)
    || normalizeAddress(company?.general_email) === r;
  if (onFile) return { ok: true, why: 'already on file for this company' };

  const rDomain = identifyingDomain(r);
  if (!rDomain) return { ok: false, why: `${r} is at a free-mail or generic domain` };
  const ours = new Set([identifyingDomain(company?.website), identifyingDomain(d)].filter(Boolean));
  if (ours.has(rDomain)) return { ok: true, why: `same domain as the organisation (${rDomain})` };
  return { ok: false, why: `${r} is at a domain this company is not known by (${[...ours].join(', ') || 'none on record'})` };
}

/** The Tier-1 reason for the retry or the residual. PURE. */
function departureReason({ departedName, departedAddress, redirect, retry, noticeAt, now = new Date() } = {}) {
  const who = departedName || departedAddress || 'the contact';
  // The day the notice ARRIVED, not the day it was processed: the nightly
  // replay can act a day late, and the record should say when they told us.
  const day = new Date(noticeAt || now).toISOString().slice(0, 10);
  if (redirect && retry === 'scheduled') {
    return `${who} has left (auto-reply ${day}); the org says write to ${redirect} — contact updated, retry scheduled`;
  }
  if (redirect) {
    return `${who} has left (auto-reply ${day}); the org says write to ${redirect} — contact updated, your text revived: check the greeting before sending`;
  }
  return `${who} has left (auto-reply ${day}) and the notice gives no forwarding address`;
}

/** The outbound the notice is answering. Thread + recipient first, then newest to that address. */
async function findAnsweredSend(sb, { companyId, address, gmail_thread_id }) {
  const cols = 'id, company_id, sent_at, message_type, undelivered_at, thread_id, to_email';
  if (gmail_thread_id) {
    const { data } = await sb.from('b2b_messages').select(cols)
      .eq('gmail_thread_id', gmail_thread_id).eq('direction', 'outbound')
      .order('sent_at', { ascending: false }).limit(5);
    const hit = (data || []).find(m => !address || splitAddresses(m.to_email).includes(address));
    if (hit) return hit;
  }
  if (!address) return null;
  const { data } = await sb.from('b2b_messages').select(cols)
    .eq('company_id', companyId).eq('direction', 'outbound')
    .ilike('to_email', `%${address}%`)
    .order('sent_at', { ascending: false }).limit(5);
  return (data || []).find(m => splitAddresses(m.to_email).includes(address)) || null;
}

/**
 * handleDeparture — one notice → contact change, undelivered mark, retry.
 *
 * Idempotent on the answered send's `undelivered_at`, same as handleBounce:
 * the replay re-reads stored mail by design, and Pub/Sub redelivers, so a
 * second pass must find nothing left to do rather than retire a contact twice
 * or schedule a second retry.
 *
 * @returns {{ handled: boolean, ... }} what changed, or why nothing did.
 */
async function handleDeparture(sb, { company_id, sender, subject, body, gmail_thread_id = null, received_at = null, now = new Date() } = {}) {
  if (!company_id) return { handled: false, reason: 'no company' };
  const nowIso = new Date(now).toISOString();
  const noticeAt = received_at || nowIso;
  const from = normalizeAddress(sender);

  const [{ data: company }, { data: contacts }] = await Promise.all([
    sb.from('b2b_companies').select('*').eq('id', company_id).maybeSingle(),
    sb.from('b2b_contacts').select('email, full_name, is_primary, is_active, bounced_at').eq('company_id', company_id),
  ]);
  if (!company) return { handled: false, reason: `company '${company_id}' not found` };
  const known = (contacts || []).map(c => normalizeAddress(c.email));

  const extracted = await extractDeparture({ subject, body, sender: from, companyName: company.name });

  // Who left. The autoresponder almost always speaks from the departed
  // mailbox itself; a colleague announcing it names them; failing both, the
  // send this notice answers says who we wrote to.
  let departed = null;
  if (from && known.includes(from) && !isSystemMailbox(from)) departed = from;
  else if (extracted.departed_email && known.includes(extracted.departed_email)) departed = extracted.departed_email;
  const message = await findAnsweredSend(sb, { companyId: company_id, address: departed, gmail_thread_id });
  if (!departed && message) {
    const to = splitAddresses(message.to_email).filter(a => known.includes(a));
    if (to.length === 1) departed = to[0];
  }
  if (!departed) return { handled: false, reason: 'could not tell which contact left', extracted };
  if (message?.undelivered_at) {
    return { handled: false, already: true, reason: 'already recorded', address: departed, company_id };
  }

  const changed = { address: departed, company_id, message_id: message?.id || null, extracted };
  const departedRow = (contacts || []).find(c => normalizeAddress(c.email) === departed);
  const departedName = extracted.departed_name || departedRow?.full_name || null;

  // 1. The contact change. A redirect that passes the gate goes through the
  //    same operation the operator would use, so the three things it moves
  //    (new primary, old one retired, contact_unknown cleared) move together.
  const gate = acceptRedirect({ redirect: extracted.redirect_email, departed, company, contacts });
  let redirect = null;
  if (gate.ok) {
    try {
      const { updateCompanyContact } = require('./updateContact');
      const r = await updateCompanyContact(sb, {
        company_id, email: extracted.redirect_email,
        full_name: extracted.redirect_name || undefined,
        title: extracted.redirect_title || undefined,
        replaces: departed,
      });
      redirect = r.contact.email;
      changed.new_contact = redirect;
      if (r.warning) changed.warning = r.warning;
    } catch (err) {
      // "already on another company" and friends: the operator decides.
      changed.redirect_refused = `${extracted.redirect_email}: ${err.message}`;
    }
  } else {
    changed.redirect_refused = gate.why;
  }
  if (!redirect) {
    // Retire the departed mailbox on the org's own word, as a bounce would on
    // the mail server's. `contact_unknown` only when nothing else is reachable
    // — resolveRecipient falls through to a live colleague or the general inbox
    // by itself, and the flag would mute a partner we can still write to.
    const { error: rErr } = await sb.from('b2b_contacts')
      .update({ is_active: false, is_primary: false, updated_at: nowIso })
      .eq('company_id', company_id).eq('email', departed);
    if (rErr) throw new Error(`retire contact: ${rErr.message}`);
    const { alternates, contact_form_url } = await reachableAlternates(sb, company_id, departed);
    changed.alternates = alternates;
    changed.contact_unknown = alternates.length === 0 && !contact_form_url;
  } else {
    changed.contact_unknown = false;
  }
  changed.retired_contact = departed;
  // Why the row is retired, on the row — the panel's "former" group and the
  // next person reading the record should not have to find the notice.
  await sb.from('b2b_contacts')
    .update({ notes: `Left the organisation per auto-reply ${new Date(noticeAt).toISOString().slice(0, 10)}${redirect ? `; org directs contact to ${redirect}` : ''}`, updated_at: nowIso })
    .eq('company_id', company_id).eq('email', departed);

  // 2. The send is not a send — marked BEFORE the retry is drafted, so the
  //    draft's context does not read "we already wrote to them". A departure
  //    notice is authoritative in the same way a 5.x.x is: nobody read it.
  if (message) {
    const { error: mErr } = await sb.from('b2b_messages')
      .update({ undelivered_at: nowIso, undelivered_reason: UNDELIVERED_REASON })
      .eq('id', message.id);
    if (mErr) throw new Error(`mark undelivered: ${mErr.message}`);
    changed.marked_undelivered = message.id;
  }

  // 3. Company state, mirroring handleBounce: the cadence date the failed send
  //    bought is cleared, and the denormalized last_outbound_at is rolled back
  //    to the newest send that actually landed.
  const update = { next_action_date: null, contact_unknown: changed.contact_unknown, updated_at: nowIso };
  if (message) {
    const { data: prior } = await sb.from('b2b_messages')
      .select('sent_at').eq('company_id', company_id).eq('direction', 'outbound')
      .is('undelivered_at', null).neq('id', message.id)
      .order('sent_at', { ascending: false }).limit(1);
    update.last_outbound_at = prior?.[0]?.sent_at || null;
    changed.last_outbound_at = update.last_outbound_at;
  }
  const { error: cErr } = await sb.from('b2b_companies').update(update).eq('id', company_id);
  if (cErr) throw new Error(`company update: ${cErr.message}`);

  // 4. The retry. Only when we have somewhere to send it and know what we sent.
  let source = null;
  if (message?.sent_at) {
    const { data } = await sb.from('b2b_drafts').select('*')
      .eq('company_id', company_id).eq('status', 'sent').eq('sent_at', message.sent_at)
      .order('id', { ascending: false }).limit(1);
    source = data?.[0] || null;
  }
  if (source) changed.answered_draft_id = source.id;
  if (redirect && source) {
    const { data: existing } = await sb.from('b2b_drafts').select('id')
      .eq('bounced_from_draft_id', source.id).eq('status', 'pending').maybeSingle();
    if (existing) {
      changed.retry_draft_id = existing.id;
    } else {
      const { INITIATING_TYPES } = require('./cadence');
      const templated = !source.operator_edited && INITIATING_TYPES.includes(source.message_type);
      let scheduled = false;
      if (templated) {
        // Fresh render of the locked template for the new recipient — the
        // greeting names whoever resolveRecipient now returns — carrying the
        // A/B subject arm the first attempt was assigned (a retry is not a new
        // sample). Then the follow-up ladder's schedule, cap and guards.
        try {
          const { generateDraftForCompany } = require('./queueService');
          const { scheduleFor } = require('./autoFollowUp');
          const reason = departureReason({ departedName, departedAddress: departed, redirect, retry: 'scheduled', noticeAt, now });
          const d = await generateDraftForCompany(sb, {
            company_id, message_type: source.message_type, variant_id: source.variant_id || undefined,
            force: true, reason,
          });
          if (d?.draft_id) {
            const schedule = scheduleFor(company, new Date(now));
            const { error: sErr } = await sb.from('b2b_drafts').update({
              bounced_from_draft_id: source.id, queue_tier: 1, queue_reason: reason,
              scheduled_send_at: schedule.scheduled_send_at,
              schedule_reason: `retry to ${redirect} after departure — ${schedule.schedule_reason}`,
            }).eq('id', d.draft_id);
            if (sErr) throw new Error(`schedule retry: ${sErr.message}`);
            changed.retry_draft_id = d.draft_id;
            changed.retry = 'scheduled';
            changed.scheduled_send_at = schedule.scheduled_send_at;
            scheduled = true;
          }
        } catch (err) {
          console.warn(`[departure] retry draft for ${company_id} failed, reviving the sent text instead: ${err.message}`);
          changed.retry_error = err.message;
        }
      }
      if (!scheduled) {
        // Bespoke text (or a template render that failed): revive what Jamie
        // sent, as a pending draft for review, exactly as a bounce would.
        const reason = departureReason({ departedName, departedAddress: departed, redirect, retry: 'review', noticeAt, now });
        const { data: revived, error: dErr } = await sb.from('b2b_drafts').insert({
          company_id, thread_id: source.thread_id, message_type: source.message_type,
          variant_id: source.variant_id, subject: source.sent_subject ?? source.subject,
          body: source.sent_body ?? source.body, structured: source.structured,
          queue_tier: 1, queue_reason: reason, advisor: source.advisor, status: 'pending',
          bounced_from_draft_id: source.id, generated_at: nowIso,
        }).select('id').single();
        if (dErr && dErr.code !== '23505') throw new Error(`revive draft: ${dErr.message}`);
        if (dErr) {
          const { data: raced } = await sb.from('b2b_drafts').select('id')
            .eq('bounced_from_draft_id', source.id).eq('status', 'pending').maybeSingle();
          changed.retry_draft_id = raced?.id || null;
        } else {
          changed.retry_draft_id = revived.id;
        }
        changed.retry = 'review';
      }
    }
  }
  changed.queue_reason = departureReason({
    departedName, departedAddress: departed, redirect, retry: changed.retry || 'review', noticeAt, now,
  });
  return { handled: true, ...changed };
}

module.exports = {
  handleDeparture, extractDeparture, acceptRedirect, departureReason, findAnsweredSend,
  UNDELIVERED_REASON, EXTRACT_TOOL, SYSTEM_PROMPT,
};
