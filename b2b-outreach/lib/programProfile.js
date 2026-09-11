/**
 * programProfile.js — what an LGBTQ+ org's own gender-affirming programme
 * actually looks like, in one scannable line.
 *
 * The panel could already tell you everything about our relationship with an
 * org and almost nothing about the org. Whether they run a closet you can walk
 * into, hand gear out by appointment, do a pop-up twice a year, or hold nothing
 * at all changes what there is to talk about — and the answer was sitting in
 * three places nobody reads before a call: a survey write-up from 2026, a call
 * recording folded inside a <details>, and a reply halfway down a thread.
 *
 * Two things are deliberate here:
 *
 *   1. NO MODEL CALL, ANYWHERE. Gathering evidence is a query; writing the
 *      profile is a write. The reading in between is done by whoever is holding
 *      the evidence — a Claude session at the console, or Jamie. This started
 *      as a cost decision (Jamie, 2026-09-11: do the backfill in-session) and
 *      stayed because it is also the right shape: ~70 orgs have evidence, the
 *      line is written once and changes only when new evidence lands, and a
 *      nightly Opus sweep over text that has not moved in six months buys
 *      nothing. If this ever needs to run unattended, the classify step is the
 *      one thing to add — the gather and the write are already the tool.
 *
 *   2. Their words only. Evidence is what the ORG said: their survey write-up,
 *      what they said on a call, their own replies. The website scrape
 *      (b2b_companies.description) is deliberately excluded — it is marketing
 *      copy, and several rows hold the text of a 403 error. An org with no
 *      evidence reads as unknown, which is the honest answer (2026-08-28: an
 *      absent fact is not neutral; say which kind of nothing it is).
 */
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { normalizeDomain } = require('../sync/syncB2bCompanyState');

/**
 * The five shapes an org's programme takes. Jamie named the first, third and
 * fourth; `by_request` and `no_program` were added because the real data has
 * plenty of both and forcing them into the others misdescribes them (an
 * appointment-only gear room is not a closet and not an event).
 *
 * Ordered loosely by how much standing capacity they imply, which is also how
 * they sort in the panel.
 */
const PROGRAM_TYPES = {
  standing_closet: {
    label: 'standing closet',
    hint: 'A space people can come to on a regular schedule and take what they need.',
  },
  by_request: {
    label: 'by request',
    hint: 'Gear goes out on request, by appointment, by mail, or handed over privately by staff. No open door.',
  },
  events: {
    label: 'events',
    hint: 'Periodic pop-ups, drives or tabling. Nothing standing between them.',
  },
  no_program: {
    label: 'no programme',
    hint: 'They hold and distribute nothing themselves. They may still refer people on, or want product for something else.',
  },
  unknown: {
    label: 'unknown',
    hint: 'Nothing on record says. Not the same as no programme.',
  },
};

const EVIDENCE_KINDS = ['survey', 'call', 'email'];

/** How much of a message body is worth reading for this. */
const BODY_CHARS = 1500;
/** Newest N inbound messages. Older than this and it is not what they do today. */
const EMAIL_CAP = 12;
/** One line, and a line has to fit on one line. */
const MAX_LINE_CHARS = 160;

const COMPANY_COLUMNS = 'id, name, website, relationship_type, relationship_state, program_flags, program_profile, program_profile_at';

/**
 * Is `type` one of ours? PURE.
 */
function isProgramType(type) {
  return Object.prototype.hasOwnProperty.call(PROGRAM_TYPES, type);
}

/**
 * The newest `at` across a set of evidence, as an ISO string, or null. PURE.
 * This is the watermark: evidence landing after it makes a profile stale.
 */
function evidenceThrough(evidence) {
  return (evidence || [])
    .map(e => e.at)
    .filter(Boolean)
    .sort()
    .pop() || null;
}

/**
 * Has evidence landed since the profile was written? PURE.
 * A profile with no watermark is treated as stale the moment any evidence
 * exists — it predates the watermark and we cannot tell what it read.
 */
function isStale(profile, evidence) {
  const newest = evidenceThrough(evidence);
  if (!newest) return false;
  if (!profile) return true;
  if (!profile.evidence_through) return true;
  return new Date(newest) > new Date(profile.evidence_through);
}

/**
 * The line the panel shows, from a stored profile. PURE.
 * Returns null rather than inventing a line for an org we know nothing about,
 * because "unknown" with no line is a truthful blank and a fabricated
 * "programme unclear" is one more thing to read.
 */
function programLine(profile) {
  if (!profile || !isProgramType(profile.type) || profile.type === 'unknown') return null;
  const label = PROGRAM_TYPES[profile.type].label;
  return profile.line ? `${label} · ${profile.line}` : label;
}


/**
 * The donation_partners row for a company, or null. PURE.
 *
 * Domain first, always — name matching across these two stores has fused two
 * unrelated orgs before, which is why every join in the engine keys on domain
 * (2026-08-11). The narrow exception: a company with NO identifying domain at
 * all cannot be matched on domain by definition, and some real partners have
 * none — McMinnville Trans Network's only published link is a Bitly bio page
 * whose sole destination is Instagram. For those, an exact normalised name
 * match against exactly one partner row is allowed, and the evidence is
 * labelled as such so whoever reads it knows the join is the weaker kind.
 *
 * Two partners sharing a name means no match, not the first one: the whole
 * hazard of name matching is confidently picking the wrong org.
 */
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchPartnerRow(company, partners) {
  const domain = normalizeDomain(company.website);
  if (domain) {
    const byDomain = partners.find(p => normalizeDomain(p.website_url) === domain);
    return byDomain ? { row: byDomain, via: 'domain' } : null;
  }
  const name = normalizeName(company.name);
  if (!name) return null;
  const byName = partners.filter(p => normalizeName(p.name) === name);
  return byName.length === 1 ? { row: byName[0], via: 'name' } : null;
}

/**
 * Gather everything the org has told us about its own programme.
 *
 * Three sources, newest first within each:
 *   survey — the donation onboarding write-up, matched to the company the way
 *            everything else matches across these two stores: on domain, never
 *            on name (2026-08-11). A name match here would put one org's
 *            programme on another org's record.
 *   call   — Wispr notes on b2b_meetings. The richest source by far: a call is
 *            where someone says "we don't have a closet of our own".
 *   email  — their inbound replies. Never our outbound: we would be reading
 *            our own pitch back and calling it evidence.
 */
async function gatherProgramEvidence(companyId, { sb = getSupabaseClient() } = {}) {
  const { data: company, error: cErr } = await sb
    .from('b2b_companies').select(COMPANY_COLUMNS).eq('id', companyId).maybeSingle();
  if (cErr) throw new Error(`b2b_companies: ${cErr.message}`);
  if (!company) return null;

  const evidence = [];

  // --- survey -------------------------------------------------------------
  const { data: partners, error: pErr } = await sb
    .from('donation_partners')
    .select('id, name, website_url, description, description_short, active, updated_at, created_at');
  if (pErr) throw new Error(`donation_partners: ${pErr.message}`);
  const match = matchPartnerRow(company, partners || []);
  if (match && match.row.description) {
    evidence.push({
      kind: 'survey',
      // The write-up is not re-dated when the row is touched for an address
      // fix, so created_at is when they actually told us this.
      at: match.row.created_at,
      label: `donation onboarding survey${match.row.active === false ? ' (partner since ended)' : ''}`
        + `${match.via === 'name' ? ', matched on name — no domain on either row' : ''}`,
      text: match.row.description,
    });
  }

  // --- calls --------------------------------------------------------------
  const { data: meetings, error: mErr } = await sb
    .from('b2b_meetings')
    .select('id, title, starts_at, status, outcome, summary')
    .eq('company_id', companyId)
    .not('summary', 'is', null)
    .neq('status', 'ignored')
    .order('starts_at', { ascending: false });
  if (mErr) throw new Error(`b2b_meetings: ${mErr.message}`);
  for (const m of meetings || []) {
    evidence.push({
      kind: 'call',
      at: m.starts_at,
      label: `${m.title || 'call'}`,
      text: typeof m.summary === 'string' ? m.summary : JSON.stringify(m.summary),
    });
  }

  // --- their replies ------------------------------------------------------
  const messages = await fetchAllPaginated(() =>
    sb.from('b2b_messages')
      .select('id, direction, from_email, body_text, sent_at')
      .eq('company_id', companyId)
      .eq('direction', 'inbound')
      .order('id'),
  );
  messages.sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')));
  for (const msg of (messages || []).slice(0, EMAIL_CAP)) {
    const text = (msg.body_text || '').trim();
    if (!text) continue;
    evidence.push({
      kind: 'email',
      at: msg.sent_at,
      label: `reply from ${msg.from_email || 'them'}`,
      text: text.slice(0, BODY_CHARS),
    });
  }

  evidence.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  return {
    company,
    evidence,
    evidence_through: evidenceThrough(evidence),
    stale: isStale(company.program_profile, evidence),
  };
}

/**
 * Write the profile. The caller has read the evidence and made the call; this
 * validates and stores it.
 *
 * `evidence_through` must be passed from the gather that produced the reading,
 * not recomputed here — recomputing would stamp the profile as current against
 * evidence that landed while it was being written, and nothing would ever
 * report it stale.
 */
async function setProgramProfile(companyId, {
  type, line = null, sources = [], evidence_through = null, sb = getSupabaseClient(),
} = {}) {
  if (!isProgramType(type)) {
    throw new Error(`program type must be one of ${Object.keys(PROGRAM_TYPES).join(', ')} (got ${JSON.stringify(type)})`);
  }
  const clean = (line || '').trim().replace(/\s+/g, ' ');
  if (clean.length > MAX_LINE_CHARS) {
    throw new Error(`line is ${clean.length} characters; the panel shows one line, so keep it under ${MAX_LINE_CHARS}`);
  }
  if (type === 'unknown' && clean) {
    throw new Error('unknown takes no line: a line about a programme we cannot describe is a guess');
  }
  for (const s of sources) {
    if (!EVIDENCE_KINDS.includes(s?.kind)) {
      throw new Error(`source kind must be one of ${EVIDENCE_KINDS.join(', ')} (got ${JSON.stringify(s?.kind)})`);
    }
  }

  const profile = {
    type,
    line: clean || null,
    sources: sources.map(s => ({ kind: s.kind, at: s.at || null, label: s.label || null })),
    evidence_through: evidence_through || null,
  };

  const { data, error } = await sb.from('b2b_companies')
    .update({ program_profile: profile, program_profile_at: new Date().toISOString() })
    .eq('id', companyId)
    .select(COMPANY_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`b2b_companies update: ${error.message}`);
  if (!data) throw new Error(`no company ${companyId}`);
  return data;
}

/**
 * The orgs and where they stand on this. Used by the console tool and by the
 * backfill to find what is left.
 *
 * `needs` is the working list: an org holding evidence whose profile is missing
 * or stale. Without it, new evidence (a call recorded last night) would sit
 * behind a profile written before it and nothing would ever say so.
 */
async function listProgramProfiles({ needsOnly = false, sb = getSupabaseClient() } = {}) {
  const companies = await fetchAllPaginated(() =>
    sb.from('b2b_companies').select(COMPANY_COLUMNS).eq('relationship_type', 'lgbtq_org').order('id'),
  );
  companies.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  // One pass per source rather than one gather per company: 193 companies
  // times three round trips is a minute of waiting for a list.
  const { data: partners } = await sb.from('donation_partners').select('name, website_url, description, created_at');
  const withDescription = (partners || []).filter(p => p.description);
  const { data: meetings } = await sb.from('b2b_meetings')
    .select('company_id, starts_at, summary').not('summary', 'is', null).neq('status', 'ignored');
  const messages = await fetchAllPaginated(() =>
    sb.from('b2b_messages').select('company_id, sent_at, body_text').eq('direction', 'inbound').order('id'),
  );

  const newestByCompany = new Map();
  const kindsByCompany = new Map();
  const note = (id, kind, at) => {
    if (!id) return;
    if (!kindsByCompany.has(id)) kindsByCompany.set(id, new Set());
    kindsByCompany.get(id).add(kind);
    const prev = newestByCompany.get(id);
    if (at && (!prev || String(at) > String(prev))) newestByCompany.set(id, at);
  };
  for (const m of meetings || []) note(m.company_id, 'call', m.starts_at);
  for (const m of messages || []) { if ((m.body_text || '').trim()) note(m.company_id, 'email', m.sent_at); }

  const rows = companies.map(c => {
    const survey = matchPartnerRow(c, withDescription);
    if (survey) note(c.id, 'survey', survey.row.created_at);
    const kinds = [...(kindsByCompany.get(c.id) || [])];
    const newest = newestByCompany.get(c.id) || null;
    const profile = c.program_profile || null;
    const stale = !!newest && (!profile || !profile.evidence_through
      || new Date(newest) > new Date(profile.evidence_through));
    return {
      id: c.id,
      name: c.name,
      relationship_state: c.relationship_state,
      type: profile?.type || null,
      line: programLine(profile),
      evidence_kinds: kinds,
      evidence_through: newest,
      has_evidence: kinds.length > 0,
      stale,
      needs: kinds.length > 0 && (!profile || stale),
    };
  });

  return needsOnly ? rows.filter(r => r.needs) : rows;
}

module.exports = {
  PROGRAM_TYPES, EVIDENCE_KINDS, MAX_LINE_CHARS,
  isProgramType, evidenceThrough, isStale, programLine, matchPartnerRow, normalizeName,
  gatherProgramEvidence, setProgramProfile, listProgramProfiles,
};
