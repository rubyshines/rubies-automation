const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Serialize all Claude calls — one at a time to respect token-per-minute limits.
// Scraping remains parallel; only the AI step is queued.
let _analyzerQueue = Promise.resolve();
function enqueue(fn) {
  const next = _analyzerQueue.then(fn);
  // Advance the chain even on error so the queue never stalls
  _analyzerQueue = next.then(() => {}, () => {});
  return next;
}

const SYSTEM_PROMPT = `You are analyzing a retail store's website to determine if they would be a good wholesale partner for RUBIES, a brand that makes gender-affirming underwear and swimwear for trans women.

Analyze the provided website content and return ONLY a JSON object with no other text:

{
  "companyName": "The store's name",
  "contactName": "Owner or manager name if found, null if not",
  "contactRole": "Their role/title if found, null if not",
  "subcategory": "One of: bra-fitting, adult-retail, online-trans-retail, gender-affirming-boutique, swimwear, intimates, general-boutique, collective, community-org, bookstore, vintage-thrift",
  "mentionsInclusivity": true/false,
  "mentionsTransOrGenderAffirming": true/false,
  "mentionsLGBTQ": true/false,
  "carriesGenderProducts": true/false,
  "carriesUnderwearOrSwimwear": true/false,
  "independentlyOwned": true/false,
  "hasPhysicalStore": true/false,
  "hasOnlineStore": true/false,
  "brandsList": ["brands they carry if listed"],
  "servicesList": ["services they offer - fittings, consultations, etc"],
  "rawProfile": "A comprehensive 2-3 paragraph description of this business. Include: what they sell, their mission/values, who they serve, their team if mentioned, what makes them unique, their vibe/aesthetic, anything about inclusivity or gender-affirming products, any community involvement. Be thorough — this should capture everything useful about the business so we never need to re-visit their website.",
  "outreachAngle": "One sentence suggesting how RUBIES should approach this store. E.g., 'They already carry tucking products — pitch RUBIES as a comfortable alternative' or 'Body-positive bra shop with no trans products yet — lead with Ruby's story and the unmet need'",
  "isRelevant": true/false,
  "irrelevantReason": "If not relevant, explain why (e.g., 'This is a restaurant, not a clothing store')"
}`;

function buildUserPrompt(companyName, website, city, state, content) {
  return `Here is the website content for ${companyName} (${website}), located in ${city}, ${state}:

---
${content}
---

Analyze this store and return the JSON object.`;
}

function parseAnalysisJson(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function analyzeProspect({ companyName, website, city, state, content, model }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const userPrompt = buildUserPrompt(companyName, website || '(no website)', city, state, content || '(no content available)');

  async function attempt(extraInstruction = '') {
    const response = await callClaude({
      component: 'b2b_analyzer',
      metadata: { company_name: companyName, city, state },
      requestOptions: { timeout: 30000, maxRetries: 2 },
      model: model || MODELS.HAIKU,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: extraInstruction ? `${userPrompt}\n\n${extraInstruction}` : userPrompt,
        },
      ],
    });
    return response.content[0].text;
  }

  // First attempt
  let text;
  try {
    text = await attempt();
    return { ...parseAnalysisJson(text), analysisStatus: 'success' };
  } catch (firstErr) {
    // If it's an API error (not a JSON parse error), retry with same prompt
    // If it's a JSON parse error, retry with explicit JSON reminder
    const isParseError = firstErr instanceof SyntaxError;
    try {
      text = await attempt(isParseError ? 'IMPORTANT: Return valid JSON only. No markdown, no explanation, just the JSON object.' : '');
      return { ...parseAnalysisJson(text), analysisStatus: 'success' };
    } catch (err) {
      const errMsg = err.message || String(err);
      return { analysisStatus: 'failed', irrelevantReason: `AI error: ${errMsg.slice(0, 120)}` };
    }
  }
}

module.exports = { analyzeProspect };
