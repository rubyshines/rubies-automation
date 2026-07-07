const { scrapeProspect } = require('./scraper');
const { findContacts } = require('./contactFinder');
const { analyzeProspect } = require('./analyzer');
const { scoreProspect, routeStatus } = require('./scorer');
const { placeDetails } = require('./maps');
const { normalizeDomain } = require('./dedup');
const { getProspectByDomain, mergeProspect } = require('./db');
const { MODELS } = require('../../shared/aiPricing');

const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD || '5', 10);

// Name patterns that should be auto-dismissed without scraping or AI analysis
const HOTEL_PATTERNS = /\b(hotel|inn|suites|resort|lodge|motel|hostel|airbnb|bed & breakfast|b&b)\b/i;
const BOOKSTORE_PATTERNS = /\b(bookstore|bookshop|books & |book shop|book store|library shop)\b/i;
const VINTAGE_PATTERNS = /\b(vintage|thrift|consignment|secondhand|second-hand|resale|re-sale|used clothing)\b/i;
const COMMUNITY_ORG_PATTERNS = /\b(pflag|pride center|resource center|community center|lgbtq center|trans closet|free closet|clothing bank|shelter|clinic|hospital|medical center|health center|surgery center)\b/i;

function preFilter(name) {
  if (HOTEL_PATTERNS.test(name)) return { skip: true, status: 'dismissed', reason: 'hotel/lodging', subcategory: 'hotel' };
  if (BOOKSTORE_PATTERNS.test(name)) return { skip: true, status: 'dismissed', reason: 'bookstore', subcategory: 'bookstore' };
  if (VINTAGE_PATTERNS.test(name)) return { skip: true, status: 'dismissed', reason: 'vintage/thrift — not wholesale', subcategory: 'vintage-thrift' };
  if (COMMUNITY_ORG_PATTERNS.test(name)) return { skip: true, status: 'community-partner', reason: 'community org', subcategory: 'community-org' };
  return { skip: false };
}

// Research a single prospect through the full pipeline.
// Returns an updated prospect object — does NOT save to DB (caller's responsibility).
// Options: { model, verbose, mapsApiKey, skipIfNoContent }
//   skipIfNoContent: if the scrape fails (or no website is found), return early
//   with scrape_status='failed' and _skippedNoContent=true instead of running
//   the AI analysis on empty content. researched_date is NOT set so the row
//   stays retryable.
//   skipNamePreFilter: bypass the name-regex pre-filter. Used for rows that
//   already passed the smarter Haiku pre-filter (prefilter.js), which
//   deliberately keeps categories the regex would cull (thrift, bookstores)
//   and wants community orgs fully researched, not pattern-routed.
async function researchProspect(prospect, { model, verbose, mapsApiKey, skipIfNoContent, skipNamePreFilter } = {}) {
  const result = { ...prospect };
  const _t = { placeDetailsMs: 0, scrapeMs: 0, analyzeMs: 0, scrapeMethod: 'none' };
  let _step;

  // ── Pre-filter: skip hotels and community orgs without any API calls ───────
  const precheck = skipNamePreFilter ? { skip: false } : preFilter(result.company_name);
  if (precheck.skip) {
    result.status = precheck.status;
    result.is_relevant = precheck.status !== 'community-partner' ? false : null;
    result.irrelevant_reason = precheck.reason;
    result.subcategory = precheck.subcategory;
    result.analysis_status = 'skipped';
    result.scrape_status = 'skipped';
    result.score = precheck.status === 'community-partner' ? null : 1;
    result.score_breakdown = precheck.status === 'community-partner' ? null : { preFiltered: -3 };
    result.researched_date = new Date().toISOString();
    result._timings = _t;
    return result;
  }

  // ── Step 1: Get website via Place Details if missing ──────────────────────
  if (!result.website && result.google_place_id && mapsApiKey) {
    if (verbose) process.stdout.write('[DETAILS] Fetching website via Place Details... ');
    _step = Date.now();
    try {
      const details = await placeDetails(result.google_place_id, mapsApiKey);
      result.website = details.result?.website || null;
      if (details.result?.formatted_phone_number && !result.phone) {
        result.phone = details.result.formatted_phone_number;
      }
      if (verbose) console.log(result.website ? `→ ${result.website}` : '→ (none found)');
    } catch (err) {
      if (verbose) console.log(`→ ERROR: ${err.message}`);
    }
    _t.placeDetailsMs = Date.now() - _step;
  }

  if (!result.website) {
    if (verbose) console.log('[SCRAPE] No website — skipping scrape');
    result.scrape_status = 'failed';
    result.scrape_error = 'No website URL';
  }

  // ── Step 2: Domain dedup — check if another prospect already has this domain ─
  if (result.website) {
    const domain = normalizeDomain(result.website);
    result.website_domain = domain;

    if (domain) {
      const existing = await getProspectByDomain(domain);
      if (existing && existing.id !== result.id) {
        // Merge this prospect into the existing one and signal caller to skip save
        // Do NOT overwrite google_place_id — the existing record keeps its own place_id
        await mergeProspect(existing.id, {
          sources: result.sources || ['google-maps'],
        });
        return { ...result, _merged: true, _mergedInto: existing.id };
      }
    }
  }

  // ── Step 3: Scrape ─────────────────────────────────────────────────────────
  // Clear any stale failure state carried in from the DB row. `--retry-failed`
  // feeds rows with scrape_status='failed', so without this reset the guard
  // below short-circuits and the retry never actually re-scrapes.
  result.scrape_status = null;
  result.scrape_error = null;
  let rawHtmlByPage = {};
  if (result.website && result.scrape_status !== 'failed') {
    _step = Date.now();
    const scrapeResult = await scrapeProspect(result.website, verbose);
    _t.scrapeMs = Date.now() - _step;
    _t.scrapeMethod = scrapeResult.method || 'none';
    if (scrapeResult.error || !scrapeResult.content) {
      result.scrape_status = 'failed';
      result.scrape_error = scrapeResult.error || 'No content extracted';
    } else {
      result.scrape_status = 'success';
      result.scrape_error = null;
      rawHtmlByPage = scrapeResult.rawHtmlByPage;
      result._scrapedContent = scrapeResult.content;
    }
  }

  // Early-out for callers that only want prospects with real website content.
  // Persistable state so far (website, website_domain, scrape_status,
  // scrape_error, phone) is on the result; researched_date stays unset.
  if (skipIfNoContent && result.scrape_status === 'failed') {
    if (verbose) console.log(`[SKIP] No content (${result.scrape_error}) — skipping analysis`);
    delete result._scrapedContent;
    result._timings = _t;
    result._skippedNoContent = true;
    return result;
  }

  // ── Step 4: Contact finder ─────────────────────────────────────────────────
  const contacts = Object.keys(rawHtmlByPage).length > 0
    ? findContacts(rawHtmlByPage)
    : { email: null, emailType: null, additionalEmails: [], phone: result.phone || null, contactFormUrl: null, contactPageUrl: null, contactMethod: 'none' };

  result.email = contacts.email;
  result.email_type = contacts.emailType;
  result.additional_emails = contacts.additionalEmails;
  result.phone = contacts.phone || result.phone;
  result.contact_form_url = contacts.contactFormUrl;
  result.contact_page_url = contacts.contactPageUrl;
  result.contact_method = contacts.contactMethod;

  if (verbose && contacts.email) {
    console.log(`[CONTACTS]`);
    console.log(`  → Best email: ${contacts.email} (${contacts.emailType})`);
    if (contacts.contactFormUrl) console.log(`  → Contact form: ${contacts.contactFormUrl}`);
    console.log(`  → Phone: ${contacts.phone || '(none)'}`);
    console.log(`  → Contact method: ${contacts.contactMethod}`);
  } else if (verbose) {
    console.log(`[CONTACTS] No email found | form: ${contacts.contactFormUrl || 'none'} | method: ${contacts.contactMethod}`);
  }

  // ── Step 5: AI analysis ────────────────────────────────────────────────────
  const content = result._scrapedContent || '';
  if (verbose) process.stdout.write(`[ANALYZE] Sending to ${model || process.env.AI_MODEL || MODELS.HAIKU}... `);
  _step = Date.now();
  const analysis = await analyzeProspect({
    companyName: result.company_name,
    website: result.website,
    city: result.city,
    state: result.state,
    content,
    model: model || process.env.AI_MODEL,
    _hasWebsite: !!result.website && result.scrape_status !== 'failed',
  });

  _t.analyzeMs = Date.now() - _step;

  // Pass website/scrape state into analysis for scoring
  analysis._hasWebsite = !!result.website && result.scrape_status !== 'failed';

  if (verbose) {
    if (analysis.analysisStatus === 'failed') {
      console.log('FAILED');
    } else {
      console.log('done');
      console.log(`  → Subcategory: ${analysis.subcategory}`);
      console.log(`  → Trans/gender-affirming: ${analysis.mentionsTransOrGenderAffirming ? 'YES' : 'NO'}`);
      console.log(`  → LGBTQ: ${analysis.mentionsLGBTQ ? 'YES' : 'NO'}`);
      console.log(`  → Inclusivity: ${analysis.mentionsInclusivity ? 'YES' : 'NO'}`);
      console.log(`  → Carries gender products: ${analysis.carriesGenderProducts ? 'YES' : 'NO'}`);
      console.log(`  → Carries underwear/swimwear: ${analysis.carriesUnderwearOrSwimwear ? 'YES' : 'NO'}`);
      console.log(`  → Independently owned: ${analysis.independentlyOwned ? 'YES' : 'NO'}`);
      console.log(`  → Physical: ${analysis.hasPhysicalStore ? 'YES' : 'NO'} | Online: ${analysis.hasOnlineStore ? 'YES' : 'NO'}`);
      console.log(`  → Relevant: ${analysis.isRelevant ? 'YES' : 'NO'}${analysis.irrelevantReason ? ' (' + analysis.irrelevantReason + ')' : ''}`);
      if (analysis.outreachAngle) console.log(`  → Outreach: "${analysis.outreachAngle}"`);
    }
  }

  // Map analysis fields onto result
  result.contact_name = analysis.contactName || null;
  result.contact_role = analysis.contactRole || null;
  result.subcategory = analysis.subcategory || null;
  result.mentions_trans = analysis.mentionsTransOrGenderAffirming || false;
  result.mentions_lgbtq = analysis.mentionsLGBTQ || false;
  result.mentions_inclusivity = analysis.mentionsInclusivity || false;
  result.carries_gender_products = analysis.carriesGenderProducts || false;
  result.carries_underwear_swimwear = analysis.carriesUnderwearOrSwimwear || false;
  result.independently_owned = analysis.independentlyOwned ?? null;
  result.has_physical_store = analysis.hasPhysicalStore || false;
  result.has_online_store = analysis.hasOnlineStore || false;
  result.brands_list = analysis.brandsList || [];
  result.services_list = analysis.servicesList || [];
  result.raw_profile = analysis.rawProfile || null;
  result.outreach_angle = analysis.outreachAngle || null;
  result.is_relevant = analysis.isRelevant ?? true;
  result.irrelevant_reason = analysis.irrelevantReason || null;
  result.analysis_status = analysis.analysisStatus || 'success';

  // ── Step 6: Score ──────────────────────────────────────────────────────────
  if (analysis.analysisStatus !== 'failed') {
    const { score, scoreBreakdown } = scoreProspect(
      analysis,
      contacts,
      result.community_mention_count || 0
    );

    result.score = score;
    result.score_breakdown = scoreBreakdown;
    result.status = routeStatus(analysis, score, SCORE_THRESHOLD);

    if (verbose) {
      console.log(`[SCORE]`);
      Object.entries(scoreBreakdown).forEach(([k, v]) => {
        console.log(`  → ${v > 0 ? '+' : ''}${v} ${k}`);
      });
      console.log(`  → Total: ${score}/10 → ${result.status.toUpperCase()}`);
    }
  } else {
    result.status = 'found'; // Leave as found if analysis failed — can retry
  }

  result.researched_date = new Date().toISOString();
  result._timings = _t;

  // Clean up internal fields
  delete result._scrapedContent;

  return result;
}

module.exports = { researchProspect };
