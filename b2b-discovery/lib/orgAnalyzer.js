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
  "serviceAreaText": "Any stated service area or region when there is no street address, e.g. 'serving the Greater Kansas City area'. null if none.",
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
- If the address you find belongs to somebody else (a partner org, a venue for one event, a web designer's footer credit), addressText is null.

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

  // Drop an address the page cannot corroborate. Recorded rather than silently
  // nulled, because "the model produced an address that isn't on the site" is
  // exactly the signal worth seeing if it ever becomes common.
  let addressRejected = null;
  if (parsed.addressText && !addressIsGrounded(parsed.addressText, content)) {
    addressRejected = parsed.addressText;
    parsed.addressText = null;
    parsed.addressEvidence = null;
  }

  return { ...parsed, addressRejected, analysisStatus: 'success' };
}

module.exports = { analyzeOrg, addressIsGrounded, normalizeForEvidence, SYSTEM_PROMPT };
