/**
 * Store locator description extractor — given a retail store's website URL,
 * return a 1–3 sentence description for the public rubyshines.com store locator.
 *
 * Haiku is appropriate here (Jamie-approved override of "always use Opus"):
 * this is a one-shot text extraction task, not multi-step reasoning or
 * tool-calling. All calls go through shared/aiClient.js with a component tag.
 */

const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

const COMPONENT_TAG = 'store_locator_description';

function normalizeUrl(input) {
  let url = (input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

async function fetchPageHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RUBIES-Store-Bot/1.0)',
      'Accept': 'text/html,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
  return res.text();
}

function extractCandidateText(html, url) {
  const head = (html.match(/<head[^>]*>[\s\S]*?<\/head>/i) || [''])[0];
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
  return `URL: ${url}\n\n<!-- HEAD -->\n${head.slice(0, 3000)}\n\n<!-- BODY TEXT -->\n${body}`;
}

/**
 * Auto-extract a 1–3 sentence store locator description for a retail store.
 * @param {string} storeUrl
 * @returns {Promise<string|null>} description text or null
 */
async function extractStoreDescription(storeUrl) {
  const base = normalizeUrl(storeUrl);
  if (!base) return null;

  let html;
  try {
    html = await fetchPageHtml(base);
  } catch (e) {
    console.error('[storeLocatorDescription] fetch failed:', e.message);
    return null;
  }

  const candidate = extractCandidateText(html, base);

  const prompt = [
    `You are writing a short description for a retail store to appear on the RUBIES store locator page (rubyshines.com).`,
    '',
    'Write 1–3 sentences describing this store from the perspective of a potential customer considering a visit.',
    '',
    'Rules:',
    '- Focus on what they sell, the store atmosphere, and anything unique or helpful to know.',
    '- Friendly and neutral tone, welcoming to everyone.',
    '- Do NOT mention RUBIES.',
    '- Do NOT use em dashes (—). Use commas, parentheses, or short sentences instead.',
    '- Do NOT make gender assumptions about customers or staff.',
    '- Do NOT start with the store name as the first word.',
    '- Reply with ONLY the description text, no preamble or explanation.',
    '',
    '--- STORE PAGE ---',
    candidate,
  ].join('\n');

  let response;
  try {
    response = await callClaude({
      component: COMPONENT_TAG,
      model: MODELS.HAIKU,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    console.error('[storeLocatorDescription] Haiku call failed:', e.message);
    return null;
  }

  const text = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  return text || null;
}

module.exports = { extractStoreDescription };
