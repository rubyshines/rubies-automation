/**
 * bounceRecovery.js — a delivery failure is work, not silence.
 *
 * When an outreach email hard-bounces we know three things the rest of the
 * engine does not: the message never arrived, the address is dead, and the text
 * Jamie approved is now stranded. Left alone all three decay into wrong state —
 * the cadence counts the send as contact made, the relationship summary narrates
 * a check-in that never landed, and `next_action_date` buys six months of quiet
 * for a conversation that never happened.
 *
 * This module turns that into a queue entry. It parses the DSN (pure), then
 * marks the outbound message undelivered, retires the dead address, revives the
 * approved text as a fresh pending draft, and rolls back the cadence date.
 *
 * Deliberately NOT here: resending. An address we guessed is exactly what drives
 * bounce rate, and bounce rate is what burns rubyshines.com — the same sending
 * reputation Klaviyo depends on to reach customers. Alternates are offered to
 * the operator and chosen by a human.
 */
const DSN_SENDER = /(?:^|<|\s)(?:mailer-daemon|postmaster)@/i;
/** DMARC / SMTP-TLS aggregate reports — same senders, not delivery failures. */
const AGGREGATE_REPORT = /\b(?:dmarc|tls-rpt|smtp[- ]tls)\b|^\s*Report[- ]Domain\s*:|Aggregate Report/i;

/** Strip display name / angle brackets and normalize. Pure. */
function normalizeAddress(raw) {
  return String(raw || '')
    .replace(/^.*<([^>]*)>.*$/, '$1')
    .replace(/[;,\s]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * One address field → the addresses in it. PURE.
 *
 * `b2b_messages.to_email` is NOT reliably a single address: the send tool writes
 * one, but manual and backfilled rows carry the whole To: header, so a real
 * BAGLY row holds "bsullivan@bagly.org, lflynn@bagly.org". Treating that as one
 * string produced an alternate address that does not exist AND defeated the
 * dedupe, so the dead mailbox we had just retired was offered back as the thing
 * to try instead. Anything reading an address column has to split first.
 */
function splitAddresses(raw) {
  return String(raw || '')
    .split(/[,;]/)
    .map(normalizeAddress)
    .filter(a => a.includes('@'));
}

/**
 * Is this status a permanent failure?
 *
 * `Action: delayed` outranks the status class: Gmail sends "Delivery incomplete"
 * warnings while it is still retrying, and those carry a real recipient and
 * sometimes a 4.x.x status. Retiring a contact off one would take a working
 * address out of service because a mail server was briefly slow. Pure.
 */
function isPermanentFailure({ action, status, diagnostic }) {
  if (action === 'delayed') return false;
  if (status) return status.startsWith('5');
  // No Status: field — fall back to the SMTP reply in the diagnostic. Some
  // servers report only `Diagnostic-Code: smtp; 550 ...`.
  return /\b5\d\d[\s-]/.test(diagnostic || '');
}

/**
 * Parse a delivery status notification into the per-recipient failures it
 * reports. Returns null when the message is not a DSN at all. PURE.
 *
 * `unparsed: true` means it IS a bounce but we could not read a recipient out
 * of it. That case must stay visible rather than returning null: a DSN we
 * cannot parse is a send that failed and a contact we are still treating as
 * good, which is precisely the silence this module exists to end.
 */
function parseBounce({ subject = '', body = '', from = '' } = {}) {
  if (!DSN_SENDER.test(String(from))) return null;
  // DMARC/TLS aggregate reports arrive from mailer-daemon@ addresses at the big
  // providers and are not delivery failures at all — they are daily telemetry
  // about our own domain. Left in, they are ~20 per 120 days of permanent noise
  // in the unreadable-DSN report, which is how a report people are meant to act
  // on becomes one they learn to skim past.
  if (AGGREGATE_REPORT.test(String(subject))) return null;

  const failures = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.address) {
      failures.push({ ...cur, permanent: isPermanentFailure(cur) });
    }
    cur = null;
  };

  for (const line of String(body).split(/\r?\n/)) {
    let m = /^\s*Final-Recipient:\s*(?:[a-z0-9-]+\s*;)?\s*(.+?)\s*$/i.exec(line);
    if (m) {
      flush();
      cur = { address: normalizeAddress(m[1]), action: null, status: null, diagnostic: null };
      continue;
    }
    if (!cur) continue;
    if ((m = /^\s*Action:\s*([a-z]+)/i.exec(line))) { cur.action = m[1].toLowerCase(); continue; }
    if ((m = /^\s*Status:\s*(\d\.\d+\.\d+)/i.exec(line))) { cur.status = m[1]; continue; }
    if ((m = /^\s*Diagnostic-Code:\s*(.+)$/i.exec(line))) { cur.diagnostic = m[1].trim(); continue; }
  }
  flush();

  // Fallback: no machine-readable part, but Gmail's human preamble names the
  // address ("Your message wasn't delivered to X because ..."). Better a parsed
  // address from prose than an unparsed bounce nobody ever sees.
  if (!failures.length) {
    const m = /wasn'?t delivered to\s+([^\s,]+@[^\s,]+)/i.exec(String(body));
    if (m) {
      const cand = { address: normalizeAddress(m[1]), action: null, status: null, diagnostic: String(body).slice(0, 500) };
      failures.push({ ...cand, permanent: isPermanentFailure(cand) });
    }
  }

  return { failures, unparsed: failures.length === 0, subject: subject || null };
}

/**
 * Cheap sender-only test, so the Gmail push path can decide whether to let a
 * message through the auto-reply filter without parsing every body. PURE.
 */
function looksLikeDsn({ from } = {}) {
  return DSN_SENDER.test(String(from || ''));
}

/** Plain-English for the statuses we actually see. Pure. */
function describeStatus(status) {
  if (status === '5.1.1') return 'does not exist';
  if (status === '5.2.1') return 'is inactive';
  if (status === '5.2.2') return 'is full';
  if (status === '5.7.1') return 'rejected our mail';
  return 'is undeliverable';
}

/**
 * The queue reason a bounced draft carries. Pure so the wording is testable and
 * cannot drift between the panel and the console tools.
 *
 * Says what failed, why, and what to try — an operator reading the queue should
 * not have to open the company to find out whether this is recoverable.
 */
function bounceReason({ messageType, address, status, alternates = [], now = new Date() }) {
  const what = messageType ? String(messageType).replace(/_/g, ' ') : 'message';
  const head = `${what} bounced — ${address} ${describeStatus(status)}`;
  if (!alternates.length) return `${head}; no other address on file`;
  // Date the stale ones. Valid USA's only same-domain alternate was last used in
  // 2024 and the org has since renamed; "try tommy@validbybrodie.com" reads as a
  // live address rather than a two-year-old guess, and presenting a stale
  // suggestion confidently is how the next send bounces too.
  const label = (a) => {
    if (!a.last_seen) return a.email;
    const years = (now - new Date(a.last_seen)) / (365 * 86400000);
    return years >= 1 ? `${a.email} (last used ${String(a.last_seen).slice(0, 4)})` : a.email;
  };
  return `${head}; try ${alternates.slice(0, 2).map(label).join(' or ')}`;
}

/**
 * Addresses we could reach this company at instead, best first. DERIVED, never
 * stored: contacts change, and a stored list would be one more thing to keep
 * true. Ranked active contacts, then any address we have actually corresponded
 * with on this company's threads, then the general inbox.
 *
 * SUGGESTIONS ONLY — nothing here is ever sent to automatically. An unverified
 * address is what drives bounce rate, and bounce rate is what burns
 * rubyshines.com, the same sending reputation Klaviyo depends on. The 19 Aug
 * round bounced at 12%; guessing our way out of that makes it worse.
 */
async function reachableAlternates(sb, companyId, deadAddress) {
  const dead = normalizeAddress(deadAddress);
  const out = [];
  const seen = new Set([dead]);
  const add = (email, via, lastSeen = null) => {
    const e = normalizeAddress(email);
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, via, last_seen: lastSeen });
  };

  const { data: contacts } = await sb.from('b2b_contacts')
    .select('email, full_name, is_primary, message_count, bounced_at')
    .eq('company_id', companyId).eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('message_count', { ascending: false, nullsFirst: false })
    .order('email', { ascending: true });
  for (const c of contacts || []) {
    if (c.bounced_at) continue; // known dead — never suggest it back
    add(c.email, 'contact');
  }

  // Addresses that appear in our own correspondence with this company but were
  // never registered. This is where a predecessor or colleague surfaces —
  // agonzales@bagly.org sat on a 2024 thread and nowhere else.
  const { data: msgs } = await sb.from('b2b_messages')
    .select('to_email, from_email, sent_at').eq('company_id', companyId)
    .order('sent_at', { ascending: false }).limit(200);
  const companyDomain = dead.split('@')[1];
  for (const m of msgs || []) {
    for (const raw of [m.to_email, m.from_email]) {
      for (const e of splitAddresses(raw)) {
        // Same domain only. The other addresses on these threads are a school
        // district, a consultant and a free-mail account — third parties whose
        // presence in a thread is not evidence they speak for the org. Offering
        // one as "try this instead" is the wrong-join failure that has already
        // put one org's history on another's record twice.
        if (companyDomain && e.endsWith(`@${companyDomain}`)) add(e, 'seen_in_history', m.sent_at);
      }
    }
  }

  const { data: company } = await sb.from('b2b_companies')
    .select('general_email, contact_form_url').eq('id', companyId).maybeSingle();
  if (company?.general_email) add(company.general_email, 'general_email');

  return { alternates: out, contact_form_url: company?.contact_form_url || null };
}

/**
 * handleBounce — turn one PERMANENT delivery failure into queue work.
 *
 * Idempotent, and deliberately ordered so it converges on retry: every step is
 * a no-op when already done, and the message is marked undelivered LAST so that
 * marker is a truthful "all of this finished". The replay path re-runs over
 * stored mail by design, so a half-applied bounce must never be able to look
 * complete.
 *
 * Returns a summary of what it changed, or { handled: false, reason } — a
 * bounce we could not attribute has to land somewhere visible, because a silent
 * miss here is indistinguishable from having no bounces at all, which is the
 * exact failure this module was written to end.
 */
async function handleBounce(sb, { failure, gmail_thread_id = null, now = new Date() } = {}) {
  const address = normalizeAddress(failure?.address);
  if (!address) return { handled: false, reason: 'no address in DSN' };
  if (!failure.permanent) return { handled: false, reason: `transient (${failure.status || 'no status'})`, address };

  // 1. Which send failed? The bounce lands on the original Gmail thread, so
  //    thread + recipient is the strong match; newest-outbound-to-this-address
  //    covers a bounce that arrived on its own thread.
  let message = null;
  if (gmail_thread_id) {
    const { data } = await sb.from('b2b_messages')
      .select('id, company_id, sent_at, message_type, undelivered_at, thread_id')
      .eq('gmail_thread_id', gmail_thread_id).eq('to_email', address).eq('direction', 'outbound')
      .order('sent_at', { ascending: false }).limit(1);
    message = data?.[0] || null;
  }
  if (!message) {
    const { data } = await sb.from('b2b_messages')
      .select('id, company_id, sent_at, message_type, undelivered_at, thread_id')
      .eq('to_email', address).eq('direction', 'outbound')
      .order('sent_at', { ascending: false }).limit(1);
    message = data?.[0] || null;
  }
  // Last resort: a manual send whose to_email holds the whole To: header, so
  // the exact match above cannot see the address inside it. Engine sends are
  // always single-recipient, so this only ever catches hand-sent mail.
  if (!message) {
    const { data } = await sb.from('b2b_messages')
      .select('id, company_id, sent_at, message_type, undelivered_at, thread_id, to_email')
      .ilike('to_email', `%${address}%`).eq('direction', 'outbound')
      .order('sent_at', { ascending: false }).limit(5);
    message = (data || []).find(m => splitAddresses(m.to_email).includes(address)) || null;
  }

  // 2. Company — from the failed send, else from the address book. A bounce on
  //    a manual Gmail send has no b2b_messages row but still kills an address.
  let companyId = message?.company_id || null;
  if (!companyId) {
    const { data: c } = await sb.from('b2b_contacts')
      .select('company_id').eq('email', address).maybeSingle();
    companyId = c?.company_id || null;
  }
  if (!companyId) return { handled: false, reason: 'address not on any company', address };

  if (message?.undelivered_at) {
    return { handled: false, already: true, reason: 'already recorded', address, company_id: companyId };
  }

  const nowIso = new Date(now).toISOString();
  const changed = { address, company_id: companyId, message_id: message?.id || null };

  // 3. Retire the dead address. Deactivate rather than delete — their own
  //    messages resolve to this company by address, so deleting would orphan
  //    the history that explains the relationship.
  //
  //    Note this deliberately does NOT honour updateContact's "refuse to remove
  //    the last reachable contact" rule. That guard protects an operator from a
  //    mistaken manual retire; a 5.x.x from the recipient's own mail server is
  //    ground truth, and keeping a mailbox that does not exist marked reachable
  //    is a lie that would send the next draft straight back into the same wall.
  const { error: rErr } = await sb.from('b2b_contacts')
    .update({ is_active: false, bounced_at: nowIso, updated_at: nowIso })
    .eq('company_id', companyId).eq('email', address);
  if (rErr) throw new Error(`retire contact: ${rErr.message}`);
  changed.retired_contact = address;

  const { alternates, contact_form_url } = await reachableAlternates(sb, companyId, address);
  changed.alternates = alternates;

  // 4. Revive the approved text as a NEW pending draft. Never flip the original
  //    back to pending: sent_at / operator_edited / sent_body are the
  //    operator-edit training signal and the only record that a first attempt
  //    happened, and a resend through sendDraftById would overwrite sent_body.
  //    Seeded from sent_* (what Jamie actually sent) rather than body/subject
  //    (the AI's original) — on the BAGLY draft those differ substantially.
  let source = null;
  if (message?.sent_at) {
    const { data } = await sb.from('b2b_drafts').select('*')
      .eq('company_id', companyId).eq('status', 'sent').eq('sent_at', message.sent_at)
      .order('id', { ascending: false }).limit(1);
    source = data?.[0] || null;
  }
  if (source) {
    const { data: existing } = await sb.from('b2b_drafts').select('id')
      .eq('bounced_from_draft_id', source.id).eq('status', 'pending').maybeSingle();
    if (existing) {
      changed.revived_draft_id = existing.id;
    } else {
      const reason = bounceReason({
        messageType: source.message_type, address, status: failure.status, alternates, now: new Date(now),
      });
      const { data: revived, error: dErr } = await sb.from('b2b_drafts').insert({
        company_id: companyId,
        thread_id: source.thread_id,
        message_type: source.message_type,
        variant_id: source.variant_id,
        subject: source.sent_subject ?? source.subject,
        body: source.sent_body ?? source.body,
        structured: source.structured,
        // Tier 1: not literally a person waiting, but the same obligation — a
        // message we believe we sent and did not.
        queue_tier: 1,
        queue_reason: reason,
        // Carried forward, not nulled. `advisor: null` means "Jamie composed
        // this himself", and mislabelling a revived advisor draft that way
        // would corrupt the edit-rate signal it exists to distinguish.
        advisor: source.advisor,
        status: 'pending',
        bounced_from_draft_id: source.id,
        generated_at: nowIso,
      }).select('id').single();
      if (dErr && dErr.code !== '23505') throw new Error(`revive draft: ${dErr.message}`);
      if (dErr) {
        const { data: raced } = await sb.from('b2b_drafts').select('id')
          .eq('bounced_from_draft_id', source.id).eq('status', 'pending').maybeSingle();
        changed.revived_draft_id = raced?.id || null;
      } else {
        changed.revived_draft_id = revived.id;
        changed.queue_reason = reason;
      }
    }
    changed.bounced_draft_id = source.id;
  }

  // 5. Company state. next_action_date was stamped by a send that never
  //    arrived, so it is buying quiet for a conversation that did not happen —
  //    clear it and let the cadence re-derive. contact_unknown is set ONLY when
  //    nothing is reachable, because it pauses the company entirely and nothing
  //    in the panel renders it: setting it while info@ is still live would mute
  //    a partner we can perfectly well write to.
  const unreachable = alternates.length === 0 && !contact_form_url;
  const update = { next_action_date: null, contact_unknown: unreachable, updated_at: nowIso };

  // `last_outbound_at` is a denormalized copy that buildContexts SEEDS
  // lastOutboundAt from, so marking the message undelivered is not enough on its
  // own — the company row would still assert contact was made on 19 Aug and the
  // cadence would read it straight back out. Roll it to the newest outbound that
  // actually landed, excluding this one (which is marked undelivered below, so
  // a plain "where undelivered_at is null" would not exclude it yet).
  if (message) {
    const { data: prior } = await sb.from('b2b_messages')
      .select('sent_at').eq('company_id', companyId).eq('direction', 'outbound')
      .is('undelivered_at', null).neq('id', message.id)
      .order('sent_at', { ascending: false }).limit(1);
    update.last_outbound_at = prior?.[0]?.sent_at || null;
    changed.last_outbound_at = update.last_outbound_at;
  }

  const { error: cErr } = await sb.from('b2b_companies').update(update).eq('id', companyId);
  if (cErr) throw new Error(`company update: ${cErr.message}`);
  changed.contact_unknown = unreachable;

  // 6. LAST: the send is not a send. Three readers treat this row as proof of
  //    contact (lastOutboundAt, the relationship summary, Tier 1's
  //    lastInbound > lastOutbound), and leaving it unmarked keeps the record
  //    wrong even after a successful resend.
  if (message) {
    const { error: mErr } = await sb.from('b2b_messages')
      .update({
        undelivered_at: nowIso,
        undelivered_reason: `${failure.status || 'permanent'}: ${describeStatus(failure.status)}`,
      })
      .eq('id', message.id);
    if (mErr) throw new Error(`mark undelivered: ${mErr.message}`);
    changed.marked_undelivered = message.id;
  }

  return { handled: true, ...changed };
}

module.exports = {
  splitAddresses,
  parseBounce, isPermanentFailure, normalizeAddress, looksLikeDsn,
  describeStatus, bounceReason, reachableAlternates, handleBounce,
};
