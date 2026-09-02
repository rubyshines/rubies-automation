/**
 * inboundTriage.js — the "New inbound" strip: org/retailer email that reached
 * the inbox, classified by the Gmail intake, but matching NO company on the
 * books. correlateInbound can only attach mail to companies that already
 * exist, so a brand-new org writing in cold was invisible to the engine —
 * labeled in Gmail, listed in the daily digest, and nowhere in the panel
 * (Blue Mountain Clinic wrote twice before anyone noticed, 2026-09).
 *
 * The list is admission-gated, not auto-created, on the same reasoning as
 * Tier-4 vetting: the classifier will occasionally tag a vendor pitch as an
 * org, and a wrong auto-created row starts getting cadence treatment. One
 * click keeps the operator as the gate.
 *
 * Only identifying-domain senders are listed. A free-mail sender is an
 * individual, never evidence of an organisation (see emailDomains.js), and a
 * company row keyed on gmail.com is exactly the junk the 2026-07 cleanup
 * removed. Free-mail org mail still reaches the daily digest.
 */
const { identifyingDomain } = require('./emailDomains');
const { slugify } = require('./addProspect');

// Which intake classifications are outreach material, and which channel each
// one admits into.
const CHANNEL_BY_CLASSIFICATION = { lgbtq_org: 'lgbtq_org', wholesale: 'wholesale' };

// How far back the strip looks. Wide enough that an org from a quiet month
// still surfaces, narrow enough that day one doesn't replay all of history.
const DEFAULT_WINDOW_DAYS = 120;

/** "fearne@bluemountainclinic.org" → "Bluemountainclinic". A starting point
 * for the editable name field, never a final answer. Pure. */
function inferNameFromDomain(domain) {
  const base = String(domain || '').replace(/\.[a-z.]{2,10}$/i, '');
  return base.split(/[.\-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || domain;
}

/** "Name <A@Foo.ORG>" → "a@foo.org". Pure. */
function normalizeSender(address) {
  return String(address || '').toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();
}

/**
 * Group unmatched org/retailer inbound into one candidate per sender domain.
 * Pure — the fetch wrapper feeds it. `known` carries what the book already
 * holds: any domain or address on file (INCLUDING lost rows — a lost stub is
 * how a dismissal is recorded, and a real lost company was a deliberate no).
 *
 * @param {Array} messages email_messages rows, any order
 * @param {{domains: Set<string>, emails: Set<string>}} known
 * @returns candidates, newest first
 */
function deriveInboundCandidates(messages, known) {
  const byDomain = new Map();
  for (const m of messages || []) {
    const channel = CHANNEL_BY_CLASSIFICATION[m.classification];
    if (!channel) continue;
    if (m.is_sent || m.is_auto_reply) continue;
    const sender = normalizeSender(m.from_address);
    const domain = identifyingDomain(sender);
    if (!domain) continue;                    // free mail / no identity — not listable
    if (known.domains.has(domain)) continue;  // already a company (any state)
    if (known.emails.has(sender)) continue;   // already a contact or general inbox
    const prev = byDomain.get(domain);
    const entry = prev || {
      domain,
      inferred_name: inferNameFromDomain(domain),
      channel,
      message_count: 0,
      first_seen: m.date,
      last_seen: m.date,
      sender_email: sender,
      sender_name: m.from_name || null,
      subject: m.subject || null,
      snippet: null,
    };
    entry.message_count += 1;
    if (m.date < entry.first_seen) entry.first_seen = m.date;
    if (m.date >= entry.last_seen) {
      entry.last_seen = m.date;
      entry.sender_email = sender;
      entry.sender_name = m.from_name || entry.sender_name;
      entry.subject = m.subject || entry.subject;
      entry.snippet = (m.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 140) || entry.snippet;
    }
    if (!prev) byDomain.set(domain, entry);
  }
  return [...byDomain.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}

/** What the book already holds, as sets the pure derivation can check. */
async function fetchKnown(sb) {
  const domains = new Set();
  const emails = new Set();
  // Both tables are small (hundreds of rows); paginate anyway per the standing
  // rule — a silent 1000-row truncation here would resurface known companies
  // as "new inbound".
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('b2b_companies')
      .select('website, general_email').range(from, from + 999);
    if (error) throw new Error(`b2b_companies: ${error.message}`);
    for (const c of data) {
      const d = identifyingDomain(c.website) || identifyingDomain(c.general_email);
      if (d) domains.add(d);
      if (c.general_email) emails.add(String(c.general_email).toLowerCase());
    }
    if (data.length < 1000) break;
  }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('b2b_contacts')
      .select('email').range(from, from + 999);
    if (error) throw new Error(`b2b_contacts: ${error.message}`);
    for (const c of data) {
      if (!c.email) continue;
      emails.add(String(c.email).toLowerCase());
      const d = identifyingDomain(c.email);
      if (d) domains.add(d);
    }
    if (data.length < 1000) break;
  }
  return { domains, emails };
}

/** The strip's rows: classified org/retailer inbound matching no company. */
async function fetchInboundCandidates(sb, { days = DEFAULT_WINDOW_DAYS } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  let messages = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('email_messages')
      .select('gmail_message_id, from_address, from_name, subject, date, body_text, classification, is_sent, is_auto_reply')
      .in('classification', Object.keys(CHANNEL_BY_CLASSIFICATION))
      .eq('is_sent', false).eq('is_auto_reply', false)
      .gte('date', since)
      .order('date', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(`email_messages: ${error.message}`);
    messages = messages.concat(data);
    if (data.length < 1000) break;
  }
  const known = await fetchKnown(sb);
  return deriveInboundCandidates(messages, known);
}

/**
 * Admit one candidate: company row + contact, then pull their Gmail thread(s)
 * in so the queue reads "replied — waiting on us" rather than offering a cold
 * intro to someone who wrote to US. No draft is generated — the Tier-1 flow
 * drafts the reply with the thread in context when the operator opens it.
 */
async function admitInboundSender(sb, { domain, name, email, contact_name = null, channel = 'lgbtq_org' } = {}) {
  if (!domain) throw new Error('domain is required');
  if (!email) throw new Error('email is required');
  const { addProspect } = require('./addProspect');
  const res = await addProspect(sb, {
    name: name?.trim() || inferNameFromDomain(domain),
    channel,
    website: domain,
    email,
    contact_name,
    source: 'inbound_email',
    draft: false,
  });
  if (res.warning && res.existed) return res; // lost row — surfaced, not re-opened
  // Fail-soft from here: the company exists and the nightly sweep repairs both
  // of these, so a Gmail hiccup must not fail the admit.
  let discovered = null;
  try {
    const { discoverCompanyThreads } = require('./manualSendReconcile');
    discovered = await discoverCompanyThreads(sb, { companyId: res.id, emails: [email], force: true });
  } catch (err) {
    return { ...res, warning: `admitted, but thread import failed (${err.message}) — the nightly sweep will pick it up` };
  }
  try {
    const { refreshCompanySummary } = require('./relationshipSummary');
    await refreshCompanySummary(sb, res.id, { force: true });
  } catch (_) { /* summary refreshes on open */ }
  return { ...res, threads_discovered: discovered?.discovered ?? 0 };
}

/**
 * Dismiss one candidate: a stub row marked lost, keyed on the domain, so the
 * strip (which checks every state) never lists the sender again. Same motion
 * as donation_partner_mark_out — "reviewed, don't ingest" recorded as data.
 * Refuses to touch a live company: the strip should never have shown one, so
 * a collision means the strip is wrong, not the company.
 */
async function dismissInboundSender(sb, { domain, name = null, reason = null } = {}) {
  if (!domain) throw new Error('domain is required');
  const id = slugify(name) || slugify(domain);
  const { data: existing } = await sb.from('b2b_companies')
    .select('id, relationship_state').eq('id', id).maybeSingle();
  if (existing && existing.relationship_state !== 'lost') {
    throw new Error(`'${id}' already exists as a live company — it should not be in the inbound strip`);
  }
  const { error } = await sb.from('b2b_companies').upsert({
    id,
    name: name?.trim() || inferNameFromDomain(domain),
    relationship_type: 'lgbtq_org',
    relationship_state: 'lost',
    website: domain,
    source: 'inbound_triage',
    metadata: {
      closed_reason: reason || 'dismissed from inbound triage — not a prospect',
      dismissed_at: new Date().toISOString().slice(0, 10),
    },
  }, { onConflict: 'id' });
  if (error) throw new Error(`dismiss upsert: ${error.message}`);
  return { id, dismissed: true };
}

module.exports = {
  deriveInboundCandidates,
  fetchInboundCandidates,
  admitInboundSender,
  dismissInboundSender,
  inferNameFromDomain,
  normalizeSender,
  CHANNEL_BY_CLASSIFICATION,
  DEFAULT_WINDOW_DAYS,
};
