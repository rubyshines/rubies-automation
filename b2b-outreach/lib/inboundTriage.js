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
      body: null,
    };
    entry.message_count += 1;
    if (m.date < entry.first_seen) entry.first_seen = m.date;
    if (m.date >= entry.last_seen) {
      entry.last_seen = m.date;
      entry.sender_email = sender;
      entry.sender_name = m.from_name || entry.sender_name;
      entry.subject = m.subject || entry.subject;
      entry.snippet = (m.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 140) || entry.snippet;
      // The full latest message, so the operator can read what was actually
      // asked before deciding — a 140-char snippet is not context. Capped:
      // a reply drags the whole quoted chain and disclaimers behind it.
      entry.body = (m.body_text || '').trim().slice(0, 2000) || entry.body;
    }
    if (!prev) byDomain.set(domain, entry);
  }
  return [...byDomain.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}

// ── AI name/country extraction ──────────────────────────────────────────────
// The domain guess ("Lejag", "Bluemountainclinic") is a poor display name and
// a worse company id, while the message itself almost always states the real
// one — in the signature, the body, or both. One Haiku call per new domain
// pulls {org_name, country, city, region}; Haiku deliberately (narrow
// structured extraction, and the operator reviews the name in the strip's
// editable field before it becomes a record — a miss costs an edit, never a
// wrong send). Cached per process: candidates are few and a domain's answer
// doesn't change.
//
// City and region ride along on the call the strip already makes, so where the
// sender signs off with an address the company is placed the moment it is
// created rather than sitting as a bare country until the background scrape
// lands. They are the weaker source by design: enrichOrgs' geocode of the
// address the org publishes on its own site overwrites them.
const ENRICH_CACHE = new Map(); // domain → {org_name, country, city, region} | false

function buildEnrichPrompt(c) {
  return [
    'An email arrived at a small clothing brand. Extract the ORGANISATION the sender represents.',
    '',
    `From: ${c.sender_name || ''} <${c.sender_email}>`,
    `Sender domain: ${c.domain}`,
    `Subject: ${c.subject || ''}`,
    '',
    '--- MESSAGE ---',
    (c.body || '').slice(0, 1500),
    '--- END ---',
    '',
    'Reply with ONLY a JSON object, no explanation:',
    '{"org_name": "the organisation\'s proper name as they would write it", "country": "country they are in, or null if the message does not say or imply one", "city": "the city they are in, or null", "region": "the state or province they are in, spelled out, or null", "pitch": true or false}',
    'If the sender is a company/store, org_name is the company/store name. Use the message\'s own wording — do not invent or expand names beyond what is stated or clearly implied by the domain.',
    'city and region come ONLY from an address or location the message itself states, usually in a signature block. NEVER derive them from the organisation\'s name, its web domain, a phone area code, or your own knowledge of the organisation. If the message states no location, both are null — that is a normal and useful answer.',
    'pitch is true when the sender is selling a product or service TO the brand (software, marketing, agencies, cold sales pitches, marketplace notifications) rather than a store wanting to stock its products or a community organisation wanting to partner. When genuinely unsure, use false.',
  ].join('\n');
}

/** A nullable free-text field off the model. '', 'null' and junk → null. Pure. */
function enrichString(value, max = 80) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.toLowerCase() === 'null' || v.length > max) return null;
  return v;
}

/** Parse the model's reply. Returns {org_name, country, city, region, pitch}
 * or null. Pure. */
function parseEnrichment(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const name = typeof parsed.org_name === 'string' ? parsed.org_name.trim() : '';
  if (name.length < 2 || name.length > 80) return null;
  // Anything but literal true reads as false — a spam guess must fail toward
  // "show it normally", never toward hiding a real org.
  return {
    org_name: name,
    country: enrichString(parsed.country),
    city: enrichString(parsed.city),
    region: enrichString(parsed.region),
    pitch: parsed.pitch === true,
  };
}

async function enrichCandidate(c) {
  if (ENRICH_CACHE.has(c.domain)) return ENRICH_CACHE.get(c.domain) || null;
  let result = null;
  try {
    const { callClaude } = require('../../shared/aiClient');
    const { MODELS } = require('../../shared/aiPricing');
    const response = await callClaude({
      component: 'b2b_inbound_enrich',
      model: MODELS.HAIKU,
      max_tokens: 150,
      messages: [{ role: 'user', content: buildEnrichPrompt(c) }],
    });
    const text = (response?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    result = parseEnrichment(text);
  } catch (err) {
    console.warn(`[inboundTriage] enrich failed for ${c.domain}: ${err.message}`);
  }
  // Failures cache too (as false) — a domain that errors must not re-bill on
  // every queue load; a restart clears it.
  ENRICH_CACHE.set(c.domain, result || false);
  return result;
}

/** Apply AI extraction on top of the domain guess. Fail-soft throughout. */
async function enrichCandidates(candidates) {
  await Promise.all(candidates.map(async c => {
    const e = await enrichCandidate(c);
    if (!e) { c.name_source = 'domain'; return; }
    c.inferred_name = e.org_name;
    c.country = e.country;
    c.city = e.city;
    c.region = e.region;
    c.pitch = e.pitch;
    c.name_source = 'ai';
  }));
  // Likely vendor pitches and known retail customers sink to the bottom,
  // badged — flagged rather than hidden, because a wrong guess that silently
  // drops a real org is the worse failure. Stable sort keeps newest-first
  // inside each group.
  candidates.sort((a, b) => (a.pitch || a.customer_orders ? 1 : 0) - (b.pitch || b.customer_orders ? 1 : 0));
  return candidates;
}

// ── Retail-customer flag ────────────────────────────────────────────────────
// A customer answering our newsletter from a work address is, on headers
// alone, a company writing in: identifying domain, corporate signature, no
// order talk. The classifier reads as wholesale, the strip lists them, and
// Haiku names their employer as the prospect (COA Group of Companies, a
// five-order customer, 2026-09-06). The orders table settles it and the
// operator cannot see it from the strip, so the row carries the fact.
// Mechanical lookup (CLAUDE.md exception 1); the decision stays with the
// operator, who now knows what they are looking at.

/**
 * Attach order history to candidates. Pure — `byEmail` is the lookup result
 * (lowercased email → {orders, last_order_at}). Mutates and returns the list.
 */
function applyOrderHistory(candidates, byEmail) {
  for (const c of candidates || []) {
    const h = byEmail?.get(String(c.sender_email || '').toLowerCase());
    c.customer_orders = h ? h.orders : 0;
    c.customer_last_order_at = h ? h.last_order_at : null;
  }
  return candidates;
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
  const candidates = deriveInboundCandidates(messages, known);
  const { orderHistoryByEmail } = require('../../customer-service/lib/knownCustomer');
  applyOrderHistory(candidates, await orderHistoryByEmail(sb, candidates.map(c => c.sender_email)));
  return enrichCandidates(candidates);
}

// ── Admit ───────────────────────────────────────────────────────────────────
// Split into what the operator is waiting on and what they are not. The fast
// path is the company, the contact, and the Gmail threads: without the threads
// the row would land in the queue claiming nobody has ever written to us,
// which is the opposite of why it is being admitted. Everything after that —
// the relationship summary, the location scrape — changes nothing about how
// the row reads in the queue, so it runs after the response goes out.
//
// The click used to wait on all of it (tens of seconds: Gmail, a Sonnet
// summary), with no response until it finished, which reads as a dead button.

/**
 * The half of admitting nobody is waiting on: a relationship summary, and the
 * location enrichment that turns a bare country into a city and a state. Both
 * fail soft and both are repaired by a later pass, so neither may fail the
 * admit that scheduled them.
 *
 * Exported and awaitable so it can be tested and re-run by hand; the endpoint
 * reaches it through `startAdmitFinish`.
 */
async function finishAdmittedCompany(sb, companyId) {
  const out = { summary: false, enrich_status: null };
  try {
    const { refreshCompanySummary } = require('./relationshipSummary');
    await refreshCompanySummary(sb, companyId, { force: true });
    out.summary = true;
  } catch (err) {
    console.warn(`[inboundTriage] summary failed for ${companyId}: ${err.message}`);
  }
  try {
    const { enrichCompany, fetchTargets } = require('../../b2b-discovery/enrichOrgs');
    const [row] = await fetchTargets(sb, { companyId, anyChannel: true });
    // The row is gone, or the fetch found nothing to work with. Not an error:
    // enrichment is a best effort on a company that already exists.
    if (row) out.enrich_status = (await enrichCompany(sb, row)).status;
  } catch (err) {
    console.warn(`[inboundTriage] enrichment failed for ${companyId}: ${err.message}`);
  } finally {
    // A one-off scrape must not leave a Chromium process alive in the
    // dashboard server. The batch CLI closes its own at the end of the run.
    try { await require('../../b2b-discovery/lib/scraper').closePuppeteer(); } catch (_) { /* never launched */ }
  }
  return out;
}

/** Kick `finishAdmittedCompany` in the background. Returns 'started'. */
function startAdmitFinish(sb, companyId) {
  finishAdmittedCompany(sb, companyId)
    .catch(err => console.error(`[inboundTriage] finish failed for ${companyId}: ${err.message}`));
  return 'started';
}

/**
 * Admit one candidate: company row + contact, then pull their Gmail thread(s)
 * in so the queue reads "replied — waiting on us" rather than offering a cold
 * intro to someone who wrote to US. No draft is generated — the Tier-1 flow
 * drafts the reply with the thread in context when the operator opens it.
 *
 * Returns with `background: 'started'` once the summary and the location
 * scrape are under way; the client re-polls the company after they land.
 */
async function admitInboundSender(sb, { domain, name, email, contact_name = null, channel = 'lgbtq_org', country = null, city = null, region = null } = {}) {
  if (!domain) throw new Error('domain is required');
  if (!email) throw new Error('email is required');
  const { addProspect } = require('./addProspect');
  const res = await addProspect(sb, {
    name: name?.trim() || inferNameFromDomain(domain),
    channel,
    website: domain,
    email,
    contact_name,
    country,
    city,
    region,
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
    return {
      ...res,
      background: startAdmitFinish(sb, res.id),
      warning: `admitted, but thread import failed (${err.message}) — the nightly sweep will pick it up`,
    };
  }
  return {
    ...res,
    threads_discovered: discovered?.discovered ?? 0,
    background: startAdmitFinish(sb, res.id),
  };
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
  // Stub ids come from the DOMAIN, not the display name: a name-derived slug
  // ('info', from info.faire.com's inferred name) is generic enough for a
  // real company to collide with later, and the domain is what suppression
  // matches on anyway.
  const id = slugify(domain);
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
  finishAdmittedCompany,
  deriveInboundCandidates,
  applyOrderHistory,
  enrichCandidates,
  buildEnrichPrompt,
  parseEnrichment,
  fetchInboundCandidates,
  admitInboundSender,
  dismissInboundSender,
  inferNameFromDomain,
  normalizeSender,
  CHANNEL_BY_CLASSIFICATION,
  DEFAULT_WINDOW_DAYS,
};
