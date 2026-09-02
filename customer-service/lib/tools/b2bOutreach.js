/**
 * MCP Tools: B2B Outreach engine — queue, drafting, send (Design #4: the
 * operator console IS the V1 surface; no dashboard panel).
 *
 * Tools:
 *   b2b_queue        — today's outreach queue (6-tier, locked decision #6)
 *   b2b_search       — find any company (incl. ones with nothing due) by name,
 *                      email, domain, contact, or thread subject
 *   b2b_activity     — recent messages across all companies, newest first
 *   b2b_reopen_thread— reopen a concluded thread + draft the follow-up in it
 *   b2b_draft        — generate/regenerate the advisor draft for a company
 *                      (optional steer), or list pending drafts
 *   send_b2b_email   — two-phase send; phase 2 HARD-GATED on b2b_send_enabled
 *                      (default OFF — go-live is a Jamie cowork act)
 *
 * Agent-agnostic per house rules: tools own operations, agents own judgment.
 */
const path = require('path');
const { getSupabaseClient } = require('../../../shared/supabaseClient');

const B2B_LIB = path.join(__dirname, '../../../b2b-outreach/lib');

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

const SCHEMA_HINT = "Outreach schema not yet applied — run gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor first.";
function isMissingTable(err) {
  return /Could not find the table 'public\.b2b_(messages|threads|drafts)'/.test(err?.message || '');
}

async function handleQueue(input = {}) {
  try {
    const { fetchOutreachQueue, fetchOnMe } = require(path.join(B2B_LIB, 'queueService'));
    const sb = getSupabaseClient();

    // The companies Jamie has claimed are not "nothing due" — they are work he
    // took out of the queue on purpose, and asking for them by name has to be
    // possible from here too, or the console can only ever see two thirds of
    // what he is holding.
    if (input.view === 'on_me') {
      const { entries } = await fetchOnMe(sb, { channel: input.channel });
      if (!entries.length) return text('Nothing is on you right now.');
      const rows = entries.slice(0, input.limit || 25).map(e =>
        `${e.days_on_you}d · ${e.channel} · **${e.company_name}** (${e.company_id})`
        + `${e.replied_since_claim ? ' — THEY REPLIED SINCE (also in the queue at Tier 1)' : ''}`
        + `${e.next_step ? ` — next: ${e.next_step}${e.next_step_owner === 'them' ? ' (waiting on them)' : ''}` : ''}`
        + `${e.draft ? ' — draft ready' : ''}`);
      return text(`On you (${entries.length}, oldest first):\n${rows.join('\n')}`);
    }

    const queue = await fetchOutreachQueue(sb, { channel: input.channel });
    const top = queue.slice(0, input.limit || 25);

    if (!top.length) return text('Outreach queue is empty — nothing due today.');
    const lines = top.map(e =>
      `T${e.tier} · ${e.channel} · **${e.company_name}** (${e.company_id}) — ${e.message_type || 'reply needed'} — ${e.reason}`);
    return text(`Outreach queue (${queue.length} total, showing ${top.length}):\n${lines.join('\n')}\n\nUse b2b_draft with a company_id to generate the message.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleDraft(input = {}) {
  try {
    const sb = getSupabaseClient();
    if (input.all_due) {
      const { draftAllDue } = require(path.join(B2B_LIB, 'queueService'));
      const { INITIATING_TYPES } = require(path.join(B2B_LIB, 'cadence'));
      // Initiating types only, always: continuations (Tier-1 replies) are
      // operator-written by decision (2026-09-02) and are never batch-drafted.
      const res = await draftAllDue(sb, { channel: input.channel, types: INITIATING_TYPES });
      if (!res.total) return text('Every due initiating-type entry already has a pending draft — nothing to generate. (Tier-1 replies are never AI-drafted; Jamie writes those.)');
      const lines = res.results.map(r => r.ok
        ? `✓ ${r.company_name} — draft #${r.draft_id}`
        : `✗ ${r.company_name} — ${r.error}`);
      const failed = res.results.filter(r => !r.ok).length;
      return text(`Drafted ${res.total - failed} of ${res.total} due compan${res.total === 1 ? 'y' : 'ies'}${failed ? ` (${failed} failed)` : ''}:\n${lines.join('\n')}\n\nReview in the Outreach panel or via b2b_draft list:true. Drafts are NEVER auto-sent.`);
    }
    if (input.list || !input.company_id) {
      const { data, error } = await sb.from('b2b_drafts')
        .select('id, company_id, message_type, subject, queue_tier, queue_reason, advisor, generated_at')
        .eq('status', 'pending').order('queue_tier').limit(25);
      if (error) throw new Error(error.message);
      if (!data?.length) return text('No pending outreach drafts.');
      return text('Pending drafts:\n' + data.map(d =>
        `#${d.id} T${d.queue_tier} ${d.company_id} — ${d.message_type} — "${d.subject}" (${d.advisor})`).join('\n'));
    }

    // Generate (or regenerate with steer) for one company
    const { generateDraftForCompany } = require(path.join(B2B_LIB, 'queueService'));
    const d = await generateDraftForCompany(sb, { company_id: input.company_id, steer: input.steer, message_type: input.message_type });
    if (!d) return text(`Company '${input.company_id}' has nothing due (and no message_type was forced). Pass message_type to draft anyway.`);

    const s = d.facts_to_verify?.length ? `\n\nFACTS TO VERIFY: ${d.facts_to_verify.join(' · ')}` : '';
    const c = d.open_commitments?.length ? `\nCOMMITMENTS: ${d.open_commitments.join(' · ')}` : '';
    return text(`Draft #${d.draft_id} (${d.advisor}, ${d.message_type}, confidence ${d.confidence})\n\nSubject: ${d.email_subject}\n\n${d.email_body}${s}${c}\n\nSend with: send_b2b_email { company_id: "${input.company_id}", ... } — preview first, confirmed:true to send (currently gated OFF).`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleSend(input = {}) {
  try {
    const { sendB2bEmail } = require(path.join(B2B_LIB, 'sendB2bEmail'));
    const res = await sendB2bEmail(input);
    if (res.phase === 'preview') {
      return text(`PREVIEW (nothing sent):\nTo: ${res.to}${res.to_name ? ` (${res.to_name})` : ''} [via ${res.resolved_via}]\nFrom: ${res.from}\nSubject: ${res.subject}\nThreading: ${res.threading}\n\n${res.body}\n\nPass confirmed: true to send — note phase 2 is gated by the b2b_send_enabled flag.`);
    }
    if (res.phase === 'blocked') return text(`BLOCKED: ${res.error}`);
    if (res.phase === 'sent') return text(`SENT to ${res.to} (gmail ${res.gmail_message_id}, thread ${res.thread_id}).`);
    return text(`Not sent: ${res.error || JSON.stringify(res)}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

// Eastern Time everywhere an operator reads a date.
function etDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  });
}

async function handleSearch(input = {}) {
  try {
    const { searchCompanies } = require(path.join(B2B_LIB, 'queueService'));
    const res = await searchCompanies(getSupabaseClient(), {
      q: input.q, status: input.status || 'all', channel: input.channel, limit: input.limit || 25,
    });
    if (!res.companies.length) {
      return text(res.query ? `No companies match "${res.query}".` : 'No companies found.');
    }
    const lines = res.companies.map(c => {
      const state = [c.relationship_state, c.thread_status === 'never' ? 'never contacted' : `${c.threads_open} open / ${c.threads_closed} closed`]
        .filter(Boolean).join(', ');
      const last = c.last_message_at ? ` — last activity ${etDate(c.last_message_at)}` : '';
      const why = c.matched_on ? ` [${c.matched_on}]` : '';
      const draft = c.has_pending_draft ? ' · DRAFT PENDING' : '';
      // The relationship summary is the whole point of looking a company up —
      // without it the console answers "does this company exist" while the
      // dashboard answers "what is going on with them". Same data, both surfaces.
      const summary = c.relationship_summary
        ? `\n  ${c.relationship_summary}${c.relationship_summary_at ? ` _(as of ${etDate(c.relationship_summary_at)})_` : ''}`
        : '';
      const next = c.relationship_next_step ? `\n  NEXT: ${c.relationship_next_step}` : '';
      return `**${c.name}** (${c.id}) · ${c.relationship_type} · ${state}${last}${why}${draft}${summary}${next}`;
    });
    const shown = res.companies.length < res.total ? ` (showing ${res.companies.length} of ${res.total})` : '';
    return text(`Companies${res.query ? ` matching "${res.query}"` : ''}${shown}:\n${lines.join('\n')}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleActivity(input = {}) {
  try {
    const { fetchActivity } = require(path.join(B2B_LIB, 'queueService'));
    const res = await fetchActivity(getSupabaseClient(), {
      direction: input.direction, channel: input.channel, limit: input.limit || 25,
    });
    if (!res.messages.length) return text('No outreach messages on record.');
    const lines = res.messages.map(m => {
      const arrow = m.direction === 'outbound' ? '→' : '←';
      const via = m.source === 'manual_send' ? ' (sent from Gmail)' : m.source === 'gmail_backfill' ? ' (backfilled)' : '';
      return `${etDate(m.sent_at)} ${arrow} **${m.company_name}** — ${m.message_type || 'message'}${via}${m.thread_subject ? ` — "${m.thread_subject}"` : ''}`;
    });
    const syncing = res.gmail_sync === 'started'
      ? '\n\n(Gmail reconcile is running — messages sent by hand in the last few minutes may not be listed yet.)' : '';
    return text(`Outreach activity, newest first:\n${lines.join('\n')}${syncing}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleReopen(input = {}) {
  try {
    const { reopenThread } = require(path.join(B2B_LIB, 'queueService'));
    const res = await reopenThread(getSupabaseClient(), {
      thread_id: input.thread_id, steer: input.steer, message_type: input.message_type,
    });
    if (res.existing_draft_id) {
      return text(`Thread #${res.thread.id} ("${res.thread.subject}") reopened. ${res.thread.company_id} already had pending draft #${res.existing_draft_id} — review that one rather than drafting over it.`);
    }
    const d = res.draft;
    return text(`Thread #${res.thread.id} ("${res.thread.subject}") reopened and follow-up draft #${d.draft_id} written on it (${d.message_type}, confidence ${d.confidence}).\n\nSubject: ${d.email_subject}\n\n${d.email_body}\n\nIt will send inside the existing thread. Review in the Outreach panel or send with send_b2b_email.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleAddProspect(input = {}) {
  try {
    const { addProspect } = require(path.join(B2B_LIB, 'addProspect'));
    const res = await addProspect(getSupabaseClient(), input);
    if (res.warning) return text(`⚠ ${res.warning}`);
    const draftNote = res.draft_id
      ? ` — intro draft #${res.draft_id} is waiting in the Outreach queue (Tier 4)`
      : ' (no draft generated)';
    // Say plainly that this one cannot be sent from the panel, so nobody hunts
    // for a Send button that is deliberately absent.
    const formNote = res.delivery === 'form'
      ? `\n\nNo email published — submit the draft through their form: ${res.form_url}`
      : '';
    return text(`${res.existed ? 'Updated' : 'Added'} '${res.id}'${draftNote}.${formNote}`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleTriage(input = {}) {
  try {
    const { triageCompany } = require(path.join(B2B_LIB, 'triage'));
    const res = await triageCompany(getSupabaseClient(), input);
    const detail = {
      keep: `admitted to the outreach queue (vetted ${res.vetted_at})`,
      drop: `marked lost — ${res.triage_reason}`,
      snooze: `snoozed until ${res.snoozed_until} — no outreach until then, and any reply already sitting there stops showing as waiting on us`,
      pause: `outreach paused — ${res.outreach_paused_reason}. Still fully visible and searchable; nothing will be drafted or chased, but a NEW reply still surfaces.`,
      // Was missing, so `on_me` rendered "undefined" — the one action whose
      // whole point is that it is a one-click decision worth confirming.
      on_me: 'claimed by you — off the queue, still ageing on your On Me list, and the pending draft is kept',
      resume: 'outreach resumed — back on the normal cadence',
    }[input.action];
    return text(`**${res.name}** (${res.company_id}) — ${detail}. No draft generated.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleInbound(input = {}) {
  try {
    const lib = require(path.join(B2B_LIB, 'inboundTriage'));
    const sb = getSupabaseClient();
    const action = input.action || 'list';

    if (action === 'add') {
      const res = await lib.admitInboundSender(sb, {
        domain: input.domain, name: input.name, email: input.email,
        contact_name: input.contact_name, channel: input.channel || 'lgbtq_org',
        country: input.country || null,
      });
      if (res.warning) return text(`**${res.id}** — ${res.warning}`);
      return text(`**${res.id}** admitted (${res.threads_discovered} thread${res.threads_discovered === 1 ? '' : 's'} imported from Gmail). If they were waiting on a reply, they are now in the queue at Tier 1.`);
    }

    if (action === 'ignore') {
      const res = await lib.dismissInboundSender(sb, {
        domain: input.domain, name: input.name, reason: input.reason,
      });
      return text(`**${res.id}** dismissed — ${input.domain} will not be listed again. Reverse by deleting the stub row or admitting the org deliberately.`);
    }

    const rows = await lib.fetchInboundCandidates(sb);
    if (!rows.length) return text('No unmatched org/retailer inbound — everything that wrote in is already on the books.');
    const lines = rows.map(c =>
      `${c.channel === 'wholesale' ? 'retailer' : 'org'} · **${c.inferred_name}** (${c.domain}) — ${c.sender_name || c.sender_email}, ${c.message_count} message${c.message_count === 1 ? '' : 's'}, latest ${c.last_seen.slice(0, 10)}: "${c.subject || ''}"`);
    return text(`New inbound — wrote to us, matches no company (${rows.length}):\n${lines.join('\n')}\n\nAdmit with action:'add' (domain + name + email), dismiss with action:'ignore'.`);
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

/** Local-time rendering for a scheduled slot, or a plain hint if unscheduled. */
function scheduleLine(draft) {
  if (!draft.scheduled_send_at) return 'not scheduled — waiting for an operator';
  const { describeSlot } = require(path.join(B2B_LIB, 'sendWindow'));
  const { timezoneFromLocation } = require(path.join(B2B_LIB, 'meetingTimezone'));
  const tz = timezoneFromLocation({ region: draft.region, country: draft.country }).timeZone;
  const when = describeSlot({ at: draft.scheduled_send_at, timeZone: tz })
    || new Date(draft.scheduled_send_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const due = new Date(draft.scheduled_send_at) <= new Date() ? ' — DUE, next sweep will send it' : '';
  return `sends ${when}${due}`;
}

async function handleFollowUps(input = {}) {
  try {
    const sb = getSupabaseClient();
    const { runDraftPass, runSendPass } = require(path.join(B2B_LIB, 'autoFollowUp'));

    if (input.action === 'preview') {
      const r = await runDraftPass(sb, { dry: true });
      const lines = ['**Follow-up preview** (nothing written)', ''];
      if (!r.scheduled.length && !r.retired.length && !r.handed_off.length) lines.push('Nothing due.');
      for (const s of r.scheduled) lines.push(`- **${s.name}** → ${s.message_type}: ${s.reason}. ${s.sends || ''}`);
      for (const s of r.retired) lines.push(`- **${s.name}** → RETIRE: ${s.reason}`);
      for (const s of r.handed_off) lines.push(`- **${s.name}** → ON ME: ${s.note}`);
      for (const s of r.skipped) lines.push(`- ${s.name} — skipped: ${s.why}`);
      for (const e of r.errors) lines.push(`- ${e.name || e.company_id} — ERROR: ${e.error}`);
      return text(lines.join('\n'));
    }

    if (input.action === 'run_now') {
      // The manual override for "send it now, do not wait for their morning".
      // Guards still run — this skips the CLOCK, not the checks.
      const r = await runSendPass(sb, { cap: input.cap || undefined });
      const lines = [`**Follow-up send pass** — sent ${r.sent.length}, held ${r.held.length}, errors ${r.errors.length}`, ''];
      if (r.capped) lines.push(`_${r.capped}_`, '');
      for (const s of r.sent) lines.push(`- sent #${s.draft_id} ${s.company_id} → ${s.to}`);
      for (const h of r.held) lines.push(`- held #${h.draft_id} ${h.company_id}: ${h.why}${h.withdrawn ? ' (draft withdrawn)' : ''}`);
      for (const e of r.errors) lines.push(`- error #${e.draft_id} ${e.company_id}: ${e.error}`);
      return text(lines.join('\n'));
    }

    if (input.action === 'cancel') {
      if (!input.draft_id) return text('draft_id required to cancel a scheduled send.');
      const { error } = await sb.from('b2b_drafts')
        .update({ scheduled_send_at: null, schedule_reason: 'cancelled by operator' })
        .eq('id', input.draft_id).eq('status', 'pending');
      if (error) throw new Error(error.message);
      return text(`Draft #${input.draft_id} unscheduled — it stays pending in the queue and will not auto-send.`);
    }

    // Default: list what is scheduled, plus what the cadence has retired or claimed.
    const { data: drafts, error } = await sb.from('b2b_drafts')
      .select('id, company_id, message_type, subject, scheduled_send_at, schedule_reason, queue_reason')
      .eq('status', 'pending').not('scheduled_send_at', 'is', null)
      .order('scheduled_send_at', { ascending: true });
    if (error) throw new Error(error.message);

    const ids = [...new Set((drafts || []).map(d => d.company_id))];
    const { data: cos } = ids.length
      ? await sb.from('b2b_companies').select('id, name, region, country').in('id', ids)
      : { data: [] };
    const byId = new Map((cos || []).map(c => [c.id, c]));

    const lines = [`**Scheduled follow-ups** — ${drafts?.length || 0}`, ''];
    for (const d of drafts || []) {
      const c = byId.get(d.company_id) || {};
      lines.push(`- **${c.name || d.company_id}** #${d.id} [${d.message_type}] — ${scheduleLine({ ...d, region: c.region, country: c.country })}`);
      if (d.queue_reason) lines.push(`  _${d.queue_reason}_`);
    }

    const { data: retired } = await sb.from('b2b_companies')
      .select('id, name, outreach_paused_at, outreach_paused_reason')
      .eq('outreach_paused_source', 'cadence').order('outreach_paused_at', { ascending: false }).limit(25);
    if (retired?.length) {
      lines.push('', `**Retired by the cadence** — ${retired.length} (reversible: b2b_triage action:'resume')`, '');
      for (const c of retired) lines.push(`- ${c.name} — ${c.outreach_paused_reason} (${String(c.outreach_paused_at).slice(0, 10)})`);
    }
    const { data: handed } = await sb.from('b2b_companies')
      .select('id, name, on_me_at, on_me_note')
      .eq('on_me_source', 'cadence').order('on_me_at', { ascending: false }).limit(25);
    if (handed?.length) {
      lines.push('', `**Handed to you by the cadence** — ${handed.length}`, '');
      for (const c of handed) lines.push(`- ${c.name} — ${c.on_me_note} (claimed ${String(c.on_me_at).slice(0, 10)})`);
    }
    return text(lines.join('\n'));
  } catch (err) {
    if (/column .* does not exist|scheduled_send_at|outreach_paused_source|on_me_source/.test(err?.message || '')) {
      return text('Follow-up scheduling columns not yet applied — run the b2b_drafts / b2b_companies ALTERs '
        + 'in gmail-management/b2b-outreach-schema.sql in the Supabase SQL Editor first.');
    }
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleUpdateContact(input = {}) {
  try {
    const { updateCompanyContact } = require(path.join(B2B_LIB, 'updateContact'));
    const r = await updateCompanyContact(getSupabaseClient(), input);
    const bits = [`**${r.company_name}** now writes to **${r.contact.email}**`
      + (r.contact.full_name ? ` (${r.contact.full_name}${r.contact.title ? `, ${r.contact.title}` : ''})` : '')];
    if (r.previous_recipient && r.previous_recipient !== r.contact.email) {
      bits.push(`Was: ${r.previous_recipient}.`);
    }
    if (r.deactivated.length) bits.push(`Retired: ${r.deactivated.join(', ')} (kept on the record for history).`);
    return text(bits.join(' '));
  } catch (err) {
    return text(isMissingTable(err) ? SCHEMA_HINT : `Error: ${err.message}`);
  }
}

async function handleAgreement(input = {}) {
  try {
    const { renderAgreementPdf } = require(path.join(B2B_LIB, 'donationAgreement'));
    const sb = getSupabaseClient();

    // Country decides the discount, so prefer the company record over anything
    // typed in — a wrong rate here is a wrong contract.
    let country = input.country || null;
    let orgName = input.org_name || null;
    if (input.company_id) {
      const { data: c, error } = await sb.from('b2b_companies')
        .select('name, country').eq('id', input.company_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!c) throw new Error(`company '${input.company_id}' not found`);
      orgName = orgName || c.name;
      country = country || c.country;
    }
    if (!orgName) throw new Error('org_name or company_id required');

    const { filename, buffer, discountPercent } = await renderAgreementPdf({ orgName, country });

    const fs = require('fs');
    const os = require('os');
    const outPath = path.join(input.out_dir || os.tmpdir(), filename);
    fs.writeFileSync(outPath, buffer);

    const rateNote = discountPercent === 50
      ? 'US/Australia rate'
      : `international rate (country: ${country || 'unknown — defaulted to the conservative rate'})`;
    return text(`Generated **${filename}** — ${discountPercent}% discount, ${rateNote}.\n\nSaved to: ${outPath}\n\nPre-signed by Jamie; the counter-signature line is blank for the partner. Attach it alongside the Onboarding Survey: https://forms.gle/1Hq93BSiPrhJkgfB8`);
  } catch (err) {
    return text(`Error: ${err.message}`);
  }
}

async function handleDraftAttach(input = {}) {
  try {
    const { attachToDraft, detachFromDraft, describeAttachment, attachmentKey } = require(path.join(B2B_LIB, 'draftAttachments'));
    const { storagePathFromUrl } = require(path.join(__dirname, '../../../shared/operatorUploads'));
    const sb = getSupabaseClient();
    const kind = input.kind || 'partner_agreement';

    if (input.remove) {
      const res = await detachFromDraft(sb, { draft_id: input.draft_id, key: input.key || kind });
      return text(`Removed **${input.key || kind}** from draft #${res.draft_id}. ${res.attachments.length} attachment(s) remain.`);
    }

    // A file the operator dropped into the console is already in storage; all
    // an agent holds is its public URL, so accept either form.
    const uploadPath = kind === 'upload'
      ? (input.path || storagePathFromUrl(input.url))
      : undefined;
    if (kind === 'upload' && !uploadPath) {
      return text("Error: attaching an uploaded file needs its storage `path`, or a `url` in the operator-uploads bucket. Files are uploaded by dropping them into the Outreach panel or the operator console — this tool only points a draft at bytes that already exist.");
    }

    const res = await attachToDraft(sb, {
      draft_id: input.draft_id, kind, org_name: input.org_name, country: input.country,
      path: uploadPath, filename: input.filename, mime_type: input.mime_type,
    });
    const { data: d } = await sb.from('b2b_drafts').select('company_id').eq('id', res.draft_id).maybeSingle();
    const { data: company } = await sb.from('b2b_companies').select('name, country').eq('id', d.company_id).maybeSingle();
    const lines = res.attachments.map(a => {
      const { filename, note } = describeAttachment(a, company);
      return `- ${filename} (${note}) — key \`${attachmentKey(a)}\``;
    });
    return text(`Draft #${res.draft_id} will send with:\n${lines.join('\n')}\n\nGenerated documents are rendered fresh at send time, so they can never go out with a stale name or discount.`);
  } catch (err) {
    return text(`Error: ${err.message}`);
  }
}

module.exports = [
  {
    name: 'b2b_draft_attach',
    description: "Attach one or more files to a pending B2B draft so they go out with the email — or remove one with remove:true. Two kinds. 'partner_agreement' (default) is the LGBTQ+ Organization Donation Program agreement for that draft's company: the draft stores a recipe, not bytes, and the PDF is rendered fresh at send time so it can never be sent with a stale org name or the wrong discount — attaching it twice replaces rather than duplicates. 'upload' points the draft at a file already in the operator-uploads bucket (pass its storage `path`, or the public `url` the operator console returns for a dropped file); uploads are plural, so several can ride on one email and each is removed by its own `key`. Operators normally add uploads by dropping them onto the draft in the Outreach panel — this tool is for a file that is already in storage.",
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'number', description: 'b2b_drafts id (must be pending).' },
        kind: { type: 'string', description: "'partner_agreement' (default) or 'upload'." },
        org_name: { type: 'string', description: "partner_agreement only: override the org name printed in the agreement. Defaults to the company's name." },
        country: { type: 'string', description: 'partner_agreement only: override the country that sets the discount. Defaults to the company record.' },
        path: { type: 'string', description: "upload only: storage path of the bytes inside the email-attachments bucket, e.g. 'operator-uploads/<uuid>/pricelist.pdf'." },
        url: { type: 'string', description: 'upload only: public URL of a file in that bucket — the storage path is derived from it. Use when you have the URL the console handed back rather than the path.' },
        filename: { type: 'string', description: 'upload only: the name the recipient sees. Defaults to the last segment of the path.' },
        mime_type: { type: 'string', description: "upload only: content type, e.g. 'application/pdf'. Defaults to application/octet-stream." },
        remove: { type: 'boolean', description: 'Remove an attachment instead of adding one.' },
        key: { type: 'string', description: "With remove: which attachment. 'partner_agreement' for the agreement, or the 'upload:<path>' key shown when it was attached. Defaults to `kind`." },
      },
      required: ['draft_id'],
    },
    handler: handleDraftAttach,
  },
  {
    name: 'donation_partner_agreement',
    description: "Generate the RUBIES LGBTQ+ Organization Donation Program Partnership Agreement as a pre-signed PDF for one org. Deterministic — same clause wording every time; the only variables are the org name and the discount rate, which is set by country (US/Australia 50%, everywhere else 30%). Pass company_id to take the name and country from the company record (preferred — a wrong country means a wrong contract), or org_name + country directly. Returns the file path, ready to attach to the onboarding email alongside the survey link.",
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id — name and country are read from the record.' },
        org_name: { type: 'string', description: 'Org name as it should read in the agreement. Overrides the company record.' },
        country: { type: 'string', description: 'Overrides the company record. Drives the discount rate.' },
        out_dir: { type: 'string', description: 'Directory to write the PDF into (defaults to the system temp dir).' },
      },
    },
    handler: handleAgreement,
  },
  {
    name: 'b2b_triage',
    description: "Vet a company for outreach WITHOUT generating a draft. keep (admit it to the Tier-4 first-touch queue), drop (they are gone or said no — marks lost), snooze (come back on a date: 'we just spoke, not yet'), pause (indefinite, ours to reverse: 'not working this market right now'), on_me (Jamie owes them an answer but not today — moves it out of the queue onto his own list, where it keeps ageing and shows the relationship's suggested next step; the pending draft is kept, unlike snooze and pause which clear it, and the claim is cleared only by sending or by resume, never by them writing back), resume (put it back in the queue, lifting whichever of the three is set). Tier-4 first-touch only surfaces companies that have been kept, so this is how imported prospects are admitted, cohort by cohort. All three deferrals leave the company fully visible and searchable and stop it being chased; none of them can hide a reply that arrives afterwards.",
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id.' },
        action: { type: 'string', description: "'keep' | 'drop' | 'snooze' | 'pause' | 'on_me' | 'resume'." },
        reason: { type: 'string', description: "Why. Required on drop and on pause — in six months 'why is this paused?' is the only question that matters. Optional otherwise, and ignored on on_me (that row explains itself with the relationship's suggested next step)." },
        until: { type: 'string', description: 'Snooze only: YYYY-MM-DD, must be in the future.' },
      },
      required: ['company_id', 'action'],
    },
    handler: handleTriage,
  },
  {
    name: 'b2b_followups',
    description: "The automatic follow-up ladder: what is scheduled to chase itself, what the cadence retired, and what it handed to Jamie. An unanswered engine send is chased once after 5 business days (10 for a relationship check-in — a partner is not a lead being worked), once more 10 business days later, and then the ladder ENDS: a lead is retired (an indefinite, reversible outreach pause — never relationship_state 'lost', which would claim they said no) while a live partner is claimed onto Jamie's On Me list with a note, because a partner going quiet has to be visible now rather than next season. Sends are scheduled into the RECIPIENT's mid-morning and go out unattended, but only after a fresh reply re-check, an address-health check and a daily cap. Only engine-sent threads under 90 days old are ever chased — manual Gmail sends carry no record of what was asked, so chasing one would be guessing. Actions: list (default), preview (what a draft pass would do, writes nothing), run_now (run the send pass immediately — skips the clock, NOT the guards), cancel (unschedule one draft; it stays pending for a human).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "'list' (default) | 'preview' | 'run_now' | 'cancel'." },
        draft_id: { type: 'number', description: 'Required for cancel: the b2b_drafts id to unschedule.' },
        cap: { type: 'number', description: 'run_now only: override the daily auto-send cap (default 10).' },
      },
    },
    handler: handleFollowUps,
  },
  {
    name: 'b2b_update_contact',
    description: "Change who we write to at a B2B company. Use whenever a thread reveals the person has moved on ('X is no longer with us, please contact Y') or Jamie names a new contact. Sets them as the single primary contact, so the next draft and send address them; pass `replaces` with the old address to retire that person at the same time (they stay on the record so their history still reads correctly). Also clears contact_unknown, which otherwise keeps the cadence from drafting at all. Refuses an address already registered to a different company.",
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id.' },
        email: { type: 'string', description: 'The new contact address.' },
        full_name: { type: 'string', description: "The person's name, as they sign off." },
        title: { type: 'string', description: 'Their role/title, if the thread gives one.' },
        replaces: { type: 'string', description: 'Email of the person they are taking over from. Only pass this when someone has genuinely left — it deactivates that contact. Omit to simply add a person.' },
      },
      required: ['company_id', 'email'],
    },
    handler: handleUpdateContact,
  },
  {
    name: 'b2b_add_prospect',
    description: "The referred-prospect intake: 'someone recommended this org/store' → company record with referral provenance + optional contact + the channel's intro draft waiting in the Outreach queue. Use whenever Jamie names a new org, retailer, or affiliate to reach out to. Never auto-sends. Refuses to re-open companies marked lost.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization/store/person name.' },
        channel: { type: 'string', description: "'lgbtq_org' (default) | 'wholesale' | 'affiliate'." },
        website: { type: 'string', description: 'Website URL if known.' },
        email: { type: 'string', description: 'Contact or general email if known.' },
        contact_form_url: { type: 'string', description: "Their contact-form URL, for orgs that publish no email address. Use this instead of guessing info@ — a guessed address risks a bounce against our sending reputation, and a form is usually the channel a small org actually monitors. The draft is still written; the panel shows it as copy-paste text plus this link." },
        contact_name: { type: 'string', description: 'Named contact person, if any.' },
        referred_by: { type: 'string', description: "Who recommended them + their exact words/context. Provenance matters: it's what lets future drafts reference the referral honestly." },
        blurb: { type: 'string', description: 'What the org does, in the referrer\'s words.' },
        country: { type: 'string', description: 'Country, e.g. "United Kingdom".' },
        draft: { type: 'boolean', description: 'Generate the intro draft immediately (default true).' },
        steer: { type: 'string', description: 'Extra guidance for the intro draft.' },
      },
      required: ['name'],
    },
    handler: handleAddProspect,
  },
  {
    name: 'b2b_inbound',
    description: "The 'New inbound' triage list: orgs/retailers whose email the Gmail intake classified (lgbtq_org / wholesale) but who match NO company on the books — the cold-inbound gap where a new org writing in was invisible to the outreach engine. action:'list' (default) shows them, one row per sender domain. action:'add' admits one (creates the company + contact, imports their Gmail thread so they surface at Tier 1 'waiting on us' — no cold intro draft, they wrote to US). action:'ignore' dismisses one permanently via a lost stub row (for vendor pitches and misclassifications). Free-mail senders are never listed — an individual's address identifies no organisation.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "'list' (default) | 'add' | 'ignore'." },
        domain: { type: 'string', description: "add/ignore: the sender domain from the list, e.g. 'bluemountainclinic.org'." },
        name: { type: 'string', description: "add/ignore: the organisation's real name — fix the domain-inferred guess before admitting, it becomes the company id." },
        email: { type: 'string', description: 'add: the sender address, becomes the primary contact.' },
        contact_name: { type: 'string', description: "add: the sender's name, if the email signs one." },
        channel: { type: 'string', description: "add: 'lgbtq_org' (default) | 'wholesale'." },
        country: { type: 'string', description: "add: country if known — the list's AI extraction usually fills it; it drives the partner discount tier." },
        reason: { type: 'string', description: 'ignore: why (recorded on the stub row).' },
      },
    },
    handler: handleInbound,
  },
  {
    name: 'b2b_queue',
    description: "Today's B2B outreach queue across all channels (retailers, LGBTQ+ orgs, affiliates), 6-tier priority: T1 they-replied, T2 time-sensitive signals, T3 healthy cadence, T4 prospect first-touch, T5 overdue, T6 cold revival. Pass view:'on_me' instead for the companies Jamie has claimed out of the queue to answer himself, oldest first, each with how many days he has been holding it and the relationship summary's suggested next step. A claimed company that has since replied appears on BOTH views — flagged there, and at Tier 1 here.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        view: { type: 'string', description: "'queue' (default, what is due) | 'on_me' (what Jamie has claimed and not yet answered)." },
        limit: { type: 'number', description: 'Max entries to show (default 25).' },
      },
    },
    handler: handleQueue,
  },
  {
    name: 'b2b_search',
    description: "Find a B2B company (retailer, LGBTQ+ org, affiliate) by name, id, website, email address, contact name, or thread subject — including companies with nothing due, which never appear in b2b_queue. Use whenever Jamie names a company or asks about one by email. Also browses by conversation state: status:'inactive' lists relationships whose threads are all concluded, 'never' lists prospects never written to.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search term: company name, slug, domain, email address, contact name, or thread subject. Omit to browse all.' },
        status: { type: 'string', description: "Conversation state: 'all' (default) | 'open' (a live thread) | 'inactive' (all threads concluded) | 'never' (no thread yet) | 'lost' (operator-closed relationship)." },
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        limit: { type: 'number', description: 'Max companies to show (default 25).' },
      },
    },
    handler: handleSearch,
  },
  {
    name: 'b2b_activity',
    description: "Recent B2B outreach messages across every company, newest first — what was sent and what came back. Use for 'what did we send this week', 'has anyone replied', or catching up after time away. Covers engine sends AND emails Jamie sent by hand from Gmail (most outbound is manual).",
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: "'outbound' (what we sent) | 'inbound' (what came back). Omit for both." },
        channel: { type: 'string', description: "Filter: 'wholesale' | 'lgbtq_org' | 'affiliate'. Omit for all." },
        limit: { type: 'number', description: 'Max messages (default 25).' },
      },
    },
    handler: handleActivity,
  },
  {
    name: 'b2b_reopen_thread',
    description: 'Reopen a concluded outreach thread and draft the follow-up inside it, so the email lands in the existing conversation instead of starting a new one. Use when Jamie wants to pick an old conversation back up. Never auto-sends.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'number', description: 'b2b_threads id to reopen (find it with b2b_search, then the company detail).' },
        steer: { type: 'string', description: "What the follow-up should say or reference (final authority on intent)." },
        message_type: { type: 'string', description: 'Force a catalog message type. Omit to let the advisor read the thread and decide.' },
      },
      required: ['thread_id'],
    },
    handler: handleReopen,
  },
  {
    name: 'b2b_draft',
    description: 'Generate (or regenerate with steer) the outreach advisor draft for a company, batch-draft due INITIATING-type entries lacking one (all_due:true — intros/check-ins/re-approaches/reorder nudges only; Tier-1 replies are operator-written, never AI-drafted), or list pending drafts (pass list:true / no company_id). Drafts are NEVER auto-sent. The nightly daily-sync pass already does what all_due does.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id (slug). Omit to list pending drafts.' },
        steer: { type: 'string', description: 'Operator steer applied to regeneration (final authority on intent).' },
        message_type: { type: 'string', description: 'Force a specific catalog message type when nothing is due.' },
        list: { type: 'boolean', description: 'List pending drafts.' },
        all_due: { type: 'boolean', description: 'Draft every due initiating-type entry that has no pending draft yet (skips replies and stuck scheduled sends). Sequential model calls — expect ~10-30s per company.' },
        channel: { type: 'string', description: "With all_due: restrict to 'wholesale' | 'lgbtq_org' | 'affiliate'." },
      },
    },
    handler: handleDraft,
  },
  {
    name: 'send_b2b_email',
    description: 'Send a B2B outreach email as jamie@rubyshines.com. TWO-PHASE: default returns a preview; confirmed:true sends. Phase 2 is HARD-GATED on the b2b_send_enabled system flag (default OFF) — flipping that flag is a Jamie-only go-live decision.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id.' },
        thread_id: { type: 'number', description: 'b2b_threads id to reply within. Omit for a new thread.' },
        message_type: { type: 'string', description: 'Catalog message type being sent.' },
        variant_id: { type: 'string', description: 'A/B variant id, if any.' },
        subject: { type: 'string', description: 'Required for new threads; inherited (Re:) for replies.' },
        body: { type: 'string', description: 'Plain-text email body exactly as it should send.' },
        confirmed: { type: 'boolean', description: 'true = actually send (subject to the gate). Default false = preview.' },
      },
      required: ['company_id', 'message_type', 'body'],
    },
    handler: handleSend,
  },
];
