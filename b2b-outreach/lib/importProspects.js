/**
 * importProspects.js — discovery table → outreach book, as one deterministic
 * motion (retailer plan D7).
 *
 * `retailer_prospects` is where the Google-Maps-and-scrape pipeline ends; the
 * outreach engine only ever reads `b2b_companies`. Until now nothing joined
 * them: the pipeline exported to a Google Sheet, and the 56 retailer rows we
 * had were hand-imported from an older sheet. This is the join. A qualified
 * prospect becomes a `prospect` company, unvetted (Tier 4 only surfaces rows
 * a human has kept), carrying the researcher's notes into `enrich_facts` so
 * the why-this-store slot has something true to work from.
 *
 * Hygiene is deterministic and happens here, at intake, rather than by a
 * merge afterwards:
 *   - one row per website domain within the retailer channel (an org and a
 *     retailer can legitimately share one), and one row per prospect id, so
 *     re-running is safe;
 *   - the scraped email is kept only when it parses as an address and is not a
 *     scrape artefact (an image filename, a `user@domain.com` template
 *     placeholder). Free-mail addresses ARE kept — a Gmail address is often a
 *     small store's real inbox — and labelled, so vetting can see which kind
 *     of address it is;
 *   - a row with no email and no contact form is skipped rather than shown,
 *     because a queue row nobody can deliver looks like work and is not.
 *
 * Zero model calls. Kickbox verifies the kept address on entry, the same as
 * addProspect, and fails soft.
 */
const { isGenericDomain, emailDomain } = require('./emailDomains');
const { companyDomain } = require('./queueContext');
const { EMAIL_RE } = require('./emailVerify');

const PAGE = 1000;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
// `user@domain.com` is what a contact-form template ships with; the scrape
// picked it up on 12 of 119 qualified rows. Wix sites also leak their error
// tracker's address.
const PLACEHOLDER_RE = /(^(user|email|name|yourname|example|test)@)|(@(domain|example|yourdomain|email|sentry|wixpress|sentry-next|mystore|yourstore|mysite|yoursite|yourcompany|mycompany|company|website|store)\.)/i;
// A scrape reads every mailto: on the page, and a boutique's page carries its
// vendors' addresses too: the font foundry, the rewards widget, the pre-order
// app. None of them is the store. Obvious ones are dropped like placeholders;
// the rest surface as "email, other domain" for the vetting eye.
const VENDOR_DOMAIN_RE = /(^|\.)(latofonts|astigmatic|fonts|typekit|myfonts|fontspring|notifyboost|riiwards|klaviyo|mailchimp|shopify|myshopify|wix|squarespace|godaddy|wordpress|weebly|bigcommerce|squareup|sentry|hubspot|zendesk|gorgias)\.(com|net|io|org|co)$/i;
const DESCRIPTOR_RE = /\s+[-|–—]\s+([^-|–—]*\b(store|shop|boutique|retail|adult|sex|lingerie|clothing|apparel|toys?)\b[^-|–—]*)$/i;

/**
 * What kind of address the scrape found. Pure.
 *   own_domain   at the store's own website domain — the real thing
 *   other_domain a real address at some other business domain (kept; flagged,
 *                because one boutique carried its font vendor's address)
 *   free_mail    Gmail and friends (kept; a small store's real inbox, often)
 *   placeholder  a form template's default, never a mailbox
 *   image        an image filename the regex mistook for an address
 *   malformed    does not parse
 *   none         nothing scraped
 */
function classifyEmail(raw, website = null) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) return { email: null, kind: 'none' };
  if (IMAGE_RE.test(email)) return { email: null, kind: 'image' };
  if (!EMAIL_RE.test(email)) return { email: null, kind: 'malformed' };
  if (PLACEHOLDER_RE.test(email)) return { email: null, kind: 'placeholder' };
  const d = emailDomain(email);
  if (isGenericDomain(d)) return { email, kind: 'free_mail' };
  const site = companyDomain(website);
  if (VENDOR_DOMAIN_RE.test(d) && d !== site) return { email: null, kind: 'placeholder' };
  if (site && d !== site && !d.endsWith(`.${site}`) && !site.endsWith(`.${d}`)) return { email, kind: 'other_domain' };
  return { email, kind: 'own_domain' };
}

/** "Stag Shop - Adult Sex Store" → "Stag Shop". Only a trailing generic descriptor goes. Pure. */
function cleanStoreName(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  const m = s.match(DESCRIPTOR_RE);
  if (m && s.slice(0, m.index).trim().length >= 3) return s.slice(0, m.index).trim();
  return s;
}

/** The country is the last comma-separated part of a Google Maps address. Pure. */
function parseCountry(address) {
  const parts = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (/^usa$/i.test(last)) return 'United States';
  if (/^uk$/i.test(last)) return 'United Kingdom';
  return last;
}

/** "Windsor, ON N9E 1S2, Canada" → "ON". Falls back to the pipeline's own state field. Pure. */
function parseRegion(prospect) {
  const state = String(prospect.state || '').trim();
  if (/^[A-Z]{2}$/.test(state)) return state;
  const m = String(prospect.address || '').match(/,\s*([A-Z]{2})\s+[A-Z0-9][A-Z0-9 -]*,\s*[^,]+$/);
  if (m) return m[1];
  return state || null;
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Decide what one prospect becomes. Pure. `index` is mutated so a batch
 * dedupes against itself as well as against the book:
 *   { byDomain: Map<domain, {id,name}>, bySourceId: Set<string>, ids: Set<string> }
 */
function planProspect(p, index, { now = new Date() } = {}) {
  const sourceId = String(p.id);
  const name = cleanStoreName(p.company_name);
  const base = { source_id: sourceId, name, prospect: p };
  if (index.bySourceId.has(sourceId)) return { ...base, action: 'skip', reason: 'already_imported' };
  const domain = companyDomain(p.website);
  if (domain && index.byDomain.has(domain)) {
    const dup = index.byDomain.get(domain);
    return { ...base, action: 'skip', reason: 'duplicate', duplicate_of: dup.id, detail: `${domain} is already ${dup.name} (${dup.id})` };
  }
  const { email, kind } = classifyEmail(p.email, p.website);
  const form = cleanUrl(p.contact_form_url);
  if (!email && !form) return { ...base, action: 'skip', reason: 'no_contact', detail: `email: ${kind}, no contact form` };
  if (!name) return { ...base, action: 'skip', reason: 'bad_name' };

  let id = slug(name);
  if (!id) return { ...base, action: 'skip', reason: 'bad_name' };
  if (index.ids.has(id)) id = `${id}-${slug(p.city)}`;
  if (index.ids.has(id) || !id.includes('-') && index.ids.has(id)) return { ...base, action: 'skip', reason: 'id_collision', detail: id };

  const city = String(p.city || '').trim() || null;
  const region = parseRegion(p);
  const country = parseCountry(p.address);
  const facts = {
    discovery_angle: p.outreach_angle || null,
    discovery_subcategory: p.subcategory || null,
    discovery_score: p.score ?? null,
    discovery_researched_at: p.researched_date || null,
    ...(p.mentions_trans != null ? { mentions_trans: !!p.mentions_trans } : {}),
    ...(p.mentions_lgbtq != null ? { mentions_lgbtq: !!p.mentions_lgbtq } : {}),
    ...(p.carries_underwear_swimwear != null ? { carries_underwear_swimwear: !!p.carries_underwear_swimwear } : {}),
    ...(p.has_physical_store != null ? { has_physical_store: !!p.has_physical_store } : {}),
    ...(p.independently_owned != null ? { independently_owned: !!p.independently_owned } : {}),
  };
  const company = {
    id, name,
    relationship_type: 'wholesale', entity_type: 'company',
    relationship_state: 'prospect', status: 'qualified_lead', temperature: 'cold',
    vetted_at: null,
    website: cleanUrl(p.website) || p.website || null,
    general_email: email,
    contact_form_url: form,
    phone: String(p.phone || '').trim() || null,
    address: String(p.address || '').trim() || null,
    city, region, country,
    // The researcher's profile is the best "About" we hold for a store we have
    // never spoken to; the advisor renders it as such.
    description: typeof p.raw_profile === 'string' && p.raw_profile.trim() ? p.raw_profile.trim() : null,
    source: 'discovery', source_id: sourceId,
    enrich_facts: facts,
    metadata: {
      seeded: `${now.toISOString().slice(0, 10)} discovery import`,
      discovery: {
        prospect_id: p.id, google_name: p.company_name, score: p.score ?? null,
        subcategory: p.subcategory || null, tier: p.discovery_tier || null,
        email_kind: kind,
        // Kept here as well as on the contact row: with no usable address there
        // is no contact row, and the name is still the person to ask for.
        ...(String(p.contact_name || '').trim() ? { contact_name: String(p.contact_name).trim() } : {}),
        ...(String(p.contact_role || '').trim() ? { contact_role: String(p.contact_role).trim() } : {}),
        ...(Array.isArray(p.brands_list) && p.brands_list.length ? { brands: p.brands_list } : {}),
        ...(Array.isArray(p.services_list) && p.services_list.length ? { services: p.services_list } : {}),
      },
    },
  };
  const contactName = String(p.contact_name || '').trim();
  const contact = email && contactName ? {
    id: email, email, company_id: id, full_name: contactName,
    title: String(p.contact_role || '').trim() || null,
    is_primary: true, is_active: true, source: 'discovery',
  } : null;

  index.ids.add(id);
  index.bySourceId.add(sourceId);
  if (domain) index.byDomain.set(domain, { id, name });
  return { ...base, action: 'import', id, company, contact, email_kind: kind, delivery: email ? 'email' : 'form' };
}

/** Plan a whole batch against the book. Pure apart from mutating `index`. */
function planImport(prospects, index, opts) {
  return prospects.map(p => planProspect(p, index, opts));
}

async function pageThrough(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** The book as the planner needs it: retailer domains, imported prospect ids, every id. */
async function loadIndex(sb) {
  const rows = await pageThrough(() => sb.from('b2b_companies').select('id, name, website, relationship_type, source, source_id').order('id'));
  const index = { byDomain: new Map(), bySourceId: new Set(), ids: new Set() };
  for (const c of rows) {
    index.ids.add(c.id);
    if (c.source === 'discovery' && c.source_id) index.bySourceId.add(String(c.source_id));
    const d = c.relationship_type === 'wholesale' ? companyDomain(c.website) : null;
    if (d && !isGenericDomain(d) && !index.byDomain.has(d)) index.byDomain.set(d, { id: c.id, name: c.name });
  }
  return index;
}

/** Qualified discovery rows, best score first. */
async function fetchQualifiedProspects(sb, { minScore = 0, limit = null } = {}) {
  const rows = await pageThrough(() => sb.from('retailer_prospects').select('*')
    .eq('status', 'qualified').gte('score', minScore)
    .order('score', { ascending: false }).order('company_name', { ascending: true }));
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Find the company already holding a website's domain, within a channel.
 * The intake guard addProspect uses so a referral or an inbound admission
 * cannot create a second row for a company we already know under another
 * name. Generic domains (free mail, shorteners, page builders) never match.
 */
async function findCompanyByDomain(sb, { website, channel = null, excludeId = null } = {}) {
  const domain = companyDomain(website);
  if (!domain || isGenericDomain(domain)) return null;
  let q = sb.from('b2b_companies').select('id, name, website, relationship_type, relationship_state').ilike('website', `%${domain}%`);
  if (channel) q = q.eq('relationship_type', channel);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).find(c => c.id !== excludeId && companyDomain(c.website) === domain) || null;
}

/** Write the planned rows. Returns one outcome per plan, including the skips. */
async function applyImport(sb, plans, { verify = true, now = new Date() } = {}) {
  const results = [];
  for (const plan of plans) {
    if (plan.action !== 'import') { results.push(plan); continue; }
    const stamp = now.toISOString();
    const { error } = await sb.from('b2b_companies').insert({ ...plan.company, created_at: stamp, updated_at: stamp });
    if (error) { results.push({ ...plan, action: 'error', reason: `company insert: ${error.message}` }); continue; }
    const notes = [];
    if (plan.contact) {
      const { error: cErr } = await sb.from('b2b_contacts').upsert(plan.contact, { onConflict: 'id' });
      if (cErr) notes.push(`contact not saved: ${cErr.message}`);
    }
    // Timezone follows the location; never fatal (same as addProspect).
    try {
      await require('./companyLocation').updateCompanyLocation(sb, { company_id: plan.id });
    } catch (e) { notes.push(`timezone not stored: ${e.message}`); }
    let verification = null;
    if (verify && plan.company.general_email) {
      try {
        const { verifyEmail } = require('./emailVerify');
        verification = await verifyEmail(sb, plan.company.general_email, { source: 'intake' });
      } catch (e) { notes.push(`verification failed: ${e.message}`); }
    }
    results.push({ ...plan, action: 'imported', verification: verification?.status || null, notes });
  }
  return results;
}

/** The whole motion: read the book, plan, and (when not a dry run) write. */
async function importProspects(sb, { execute = false, minScore = 0, limit = null, verify = true, now = new Date() } = {}) {
  const [index, prospects] = await Promise.all([loadIndex(sb), fetchQualifiedProspects(sb, { minScore, limit })]);
  const plans = planImport(prospects, index, { now });
  const results = execute ? await applyImport(sb, plans, { verify, now }) : plans;
  return { executed: execute, results, summary: summarize(results) };
}

/** Counts by outcome, for the CLI and the tool. Pure. */
function summarize(results) {
  const s = {};
  for (const r of results) {
    const key = r.action === 'skip' ? r.reason : r.action;
    s[key] = (s[key] || 0) + 1;
  }
  return s;
}

module.exports = {
  classifyEmail, cleanStoreName, parseCountry, parseRegion, planProspect, planImport, summarize,
  loadIndex, fetchQualifiedProspects, findCompanyByDomain, applyImport, importProspects,
};
