/**
 * Logo extractor — given an org's website URL, return the best candidate
 * URL for the org's logo image.
 *
 * Cheap two-step:
 *   1. Fetch the homepage HTML.
 *   2. Send a small slice (head + img tags) to Haiku and ask for the most
 *      likely logo URL.
 *
 * Haiku is appropriate here (Jamie-approved override of "always use Opus"):
 * this is a one-shot text extraction task, not multi-step reasoning or
 * tool-calling. All calls go through shared/aiClient.js with a `component`
 * tag so they show up in the daily AI cost rollup.
 */

const { callClaude } = require('../../shared/aiClient');

const LOGO_MODEL = 'claude-haiku-4-5';
const COMPONENT_TAG = 'donation_partner_logo_extract';

function normalizeUrl(input) {
  let url = (input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function absoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Pull just the parts of the page that are likely to mention a logo, so we
 * don't pay tokens to send the entire rendered marketing site to Haiku.
 */
function extractCandidateMarkup(html) {
  const head = (html.match(/<head[^>]*>[\s\S]*?<\/head>/i) || [''])[0];
  // Keep first ~40 img tags and any link rel=icon / meta og:image lines.
  const imgTags = (html.match(/<img\b[^>]*>/gi) || []).slice(0, 40).join('\n');
  return `${head}\n\n<!-- IMG TAGS -->\n${imgTags}`.slice(0, 12000);
}

async function fetchPageHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RUBIES-Logo-Bot/1.0)',
      'Accept': 'text/html,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * @param {string} websiteUrl
 * @returns {Promise<string|null>} absolute logo URL or null
 */
async function extractLogoUrl(websiteUrl) {
  const base = normalizeUrl(websiteUrl);
  if (!base) return null;

  let html;
  try {
    html = await fetchPageHtml(base);
  } catch (e) {
    console.error('[logoExtractor] fetch failed:', e.message);
    return null;
  }

  const candidate = extractCandidateMarkup(html);

  const prompt = [
    `You are given partial HTML from an organization's homepage (${base}).`,
    'Return the URL of the organization\'s primary logo image — a real raster or SVG logo, not a favicon, not a hero photograph, not a partner/sponsor logo.',
    '',
    'Rules:',
    '- Prefer an <img> whose src, alt, class, or surrounding markup mentions "logo".',
    '- An og:image is acceptable only if no <img> logo is present.',
    '- Never return a favicon (.ico, /favicon, sizes="16x16" or "32x32").',
    '- The URL must be a complete URL (no relative paths).',
    '- If you cannot find a clear logo, return the exact string NONE.',
    '',
    'Reply with ONLY the URL on a single line, or NONE. No explanation.',
    '',
    '--- HTML ---',
    candidate,
  ].join('\n');

  let response;
  try {
    response = await callClaude({
      component: COMPONENT_TAG,
      model: LOGO_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    console.error('[logoExtractor] Haiku call failed:', e.message);
    return null;
  }

  const text = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text || /^NONE\b/i.test(text)) return null;

  // Take the first line/whitespace-separated token that looks URL-ish.
  const candidateUrl = text.split(/\s+/).find(s => /^https?:\/\//i.test(s) || s.startsWith('/'));
  if (!candidateUrl) return null;

  return absoluteUrl(candidateUrl, base);
}

module.exports = { extractLogoUrl };
