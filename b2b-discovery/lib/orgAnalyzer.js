/**
 * orgAnalyzer.js — extract an LGBTQ+ org's identity, stated location, and
 * program facts from its own website.
 *
 * Distinct from analyzer.js, which assesses a RETAIL prospect for wholesale fit
 * and takes city/state as INPUTS (discover.js gets them from Google Maps). Here
 * location is the output we actually need: the CenterLink cohort's city/region
 * columns hold Klaviyo IP geolocation of datacenters, so the only trustworthy
 * source for where an org is, is the address the org publishes itself.
 *
 * The load-bearing rule is that a stated address is transcribed and a missing
 * one is reported as missing. The analyzer must never infer a location from an
 * org's name, its domain, or its area code — a wrong city here does not fail
 * loudly, it silently routes a donor's returned garments to the wrong state and
 * puts a false "your local partner" line in a customer email.
 */
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Serialize Claude calls the same way analyzer.js does — scraping stays
// parallel, the AI step queues, so concurrency can't blow the token-per-minute
// limit.
let _queue = Promise.resolve();
function enqueue(fn) {
  const next = _queue.then(fn);
  _queue = next.then(() => {}, () => {});
  return next;
}

const SYSTEM_PROMPT = `You are reading an LGBTQ+ community organization's website to record where they are and what they do. RUBIES makes gender-affirming underwear and swimwear for trans girls and women, and partners with orgs that run gender-affirming clothing closets.

Return ONLY a JSON object, no other text:

{
  "orgName": "The organization's name exactly as they write it on their own site",
  "addressText": "The org's full street address on one line, exactly as published, including city, state/province, postal code and country. null if the site does not state one.",
  "addressEvidence": "The sentence or block you took the address from, verbatim. null if addressText is null.",
  "addressBelongsToOrg": true/false,
  "addressBelongsToOrgReason": "Why you believe the address is or is not this organization's own operating address",
  "serviceAreaText": "Any stated service area or region when there is no street address, e.g. 'serving the Greater Kansas City area'. null if none.",
  "basedInCountry": "The ISO-3166 two-letter code of the country the org OPERATES FROM, e.g. US, CA, DE, GB. null if the site does not make it clear.",
  "basedInRegion": "The state, province or region the org operates from, spelled out, e.g. Alabama, Ontario, Nordrhein-Westfalen. null if not stated.",
  "servesTransCommunity": true/false,
  "runsClothingProgram": true/false,
  "programNotes": "One or two sentences on any clothing closet, gender-affirming wardrobe, clothing bank or similar program. null if they run none.",
  "appearsActive": true/false,
  "appearsActiveReason": "What told you — a dated event, a recent post, a copyright year, or the absence of any of these",
  "descriptionShort": "One or two sentences describing the org, in plain language",
  "confidence": "high | medium | low"
}

Rules for addressText, which matter more than everything else here:
- Transcribe only an address that appears in the content. Copy it, do not tidy it.
- If the site states no address, addressText is null. This is a normal and useful answer.
- NEVER derive an address from the organization's name, its web domain, a phone area code, or your own knowledge of the organization. If you find yourself recalling where this org is, the answer is null.
- A PO Box or mailing address is fine. Prefer a street address when both appear.
- If several locations appear, use the one presented as the main or administrative office, and say so in addressEvidence.
- An address printed on a page is not automatically the org's own. Nonprofit sites routinely print a FISCAL SPONSOR's address, a donation processor's remittance address, a parent or partner organization, a venue for a single event, or a web designer's footer credit. Set addressBelongsToOrg false for any of these and explain which it is. A real example: an Alabama org's site printed a New York donation-processing address, and taking it moved the org 900 miles.
- The strongest tell is disagreement with the rest of the page. If the org's name, its programs, or its stated service area point at one place and the address points at another, addressBelongsToOrg is false.

basedInCountry and basedInRegion describe where the ORGANIZATION IS, never where it sends things or who it serves. An org that says "based in Germany, ships worldwide including Finland, Italy and the USA" is in Germany: basedInCountry "DE". Read a list of destinations as destinations.

serviceAreaText likewise describes the area the org SERVES. Do not put a shipping or coverage list in it.

Set appearsActive false when the site reads as abandoned: a copyright year several years old with no dated content, an explicit closure notice, or a parked domain.`;

function buildUserPrompt({ orgName, website, content }) {
  return `Website content for ${orgName || '(name unknown)'} (${website}):

---
${content}
---

Return the JSON object.`;
}

function parseAnalysisJson(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

/**
 * An address the model returned is only usable if it actually appears in the
 * content we gave it. This is the guard that turns "never infer a location"
 * from a prompt rule into a property of the pipeline: a recalled address has
 * no evidence in the page, so it fails this check and is dropped.
 *
 * Matching is done on digits and letters only, because the model reformats
 * line breaks, commas and "St."/"Street" freely while transcribing.
 */
function normalizeForEvidence(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addressIsGrounded(addressText, content) {
  if (!addressText) return false;
  const haystack = normalizeForEvidence(content);
  if (!haystack) return false;

  // The distinctive part of an address is its numbers — street number and
  // postal code. Requiring every token to appear would fail on legitimate
  // reformatting; requiring the numeric run to appear catches invention.
  const numbers = String(addressText).match(/\d+/g) || [];
  if (!numbers.length) {
    // Addresses with no digits at all (rare, e.g. some rural or non-US forms)
    // fall back to requiring a decent contiguous alphabetic run to match.
    const alpha = normalizeForEvidence(addressText);
    return alpha.length >= 12 && haystack.includes(alpha.slice(0, 24));
  }
  return numbers.every((n) => haystack.includes(n));
}

/**
 * Analyze one org's scraped site content.
 * Never throws — a failure comes back as { analysisStatus: 'failed' } so the
 * caller can record it against the row and move on.
 */
async function analyzeOrg({ orgName, website, content, model }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const userPrompt = buildUserPrompt({ orgName, website, content: content || '(no content available)' });

  async function attempt(extraInstruction = '') {
    const response = await enqueue(() => callClaude({
      component: 'b2b_org_enricher',
      metadata: { org_name: orgName, website },
      requestOptions: { timeout: 60000, maxRetries: 2 },
      // Sonnet rather than the Haiku that analyzer.js uses. That analyzer only
      // has to decide "is this a clothing shop", is scored downstream, and a
      // miss costs one prospect. This one transcribes a postal address that
      // becomes a geocode, then a routing decision, then a sentence in a
      // customer's email — the failure is silent and lands in the real world.
      // Not Opus: nothing here is customer-facing text or a money-moving
      // action, and every row passes operator triage before any send.
      model: model || MODELS.SONNET,
      max_tokens: 1200,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: extraInstruction ? `${userPrompt}\n\n${extraInstruction}` : userPrompt }],
    }));
    return response.content[0].text;
  }

  let parsed;
  try {
    parsed = parseAnalysisJson(await attempt());
  } catch (firstErr) {
    const isParseError = firstErr instanceof SyntaxError;
    try {
      parsed = parseAnalysisJson(await attempt(
        isParseError ? 'IMPORTANT: Return valid JSON only. No markdown, no explanation, just the JSON object.' : ''
      ));
    } catch (err) {
      const msg = err.message || String(err);
      return { analysisStatus: 'failed', failureReason: msg.slice(0, 160) };
    }
  }

  // Two independent ways an address gets dropped, recorded rather than silently
  // nulled because each is a signal worth seeing if it becomes common.
  //
  // Ungrounded: the model produced an address with no counterpart on the page —
  // it recalled the org rather than reading it.
  //
  // Not the org's: the address is on the page and belongs to someone else. The
  // grounding check cannot catch this by construction, and it is the more
  // dangerous of the two, because the address is real and geocodes cleanly.
  let addressRejected = null;
  let addressRejectedReason = null;
  if (parsed.addressText && !addressIsGrounded(parsed.addressText, content)) {
    addressRejected = parsed.addressText;
    addressRejectedReason = 'not present on the scraped page';
  } else if (parsed.addressText && parsed.addressBelongsToOrg === false) {
    addressRejected = parsed.addressText;
    addressRejectedReason = parsed.addressBelongsToOrgReason || 'stated to belong to another party';
  }
  if (addressRejected) {
    parsed.addressText = null;
    parsed.addressEvidence = null;
  }

  return { ...parsed, addressRejected, addressRejectedReason, analysisStatus: 'success' };
}

module.exports = { analyzeOrg, addressIsGrounded, normalizeForEvidence, SYSTEM_PROMPT };
