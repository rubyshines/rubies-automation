const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Serialize AI calls — one at a time to respect rate limits
let _queue = Promise.resolve();
function enqueue(fn) {
  const next = _queue.then(fn);
  _queue = next.then(() => {}, () => {});
  return next;
}

const SYSTEM_PROMPT = `You are extracting product pricing information from an e-commerce product page HTML.

Return ONLY a JSON object with no other text:

{
  "product_name": "The exact product name shown on the page",
  "price": 28.00,
  "compare_at_price": null,
  "currency_code": "USD",
  "in_stock": true,
  "url_valid": true
}

Rules:
- "price" is the current selling price as a number (not a string). Use the base/starting price if a range is shown.
- "compare_at_price" is the original/strikethrough price if the item is on sale. null if no sale.
- "currency_code" should be inferred from the currency symbol and domain ($ on .com = USD, £ on .co.uk = GBP, $ on .ca = CAD, € = EUR, A$ on .com.au = AUD).
- "in_stock" is false if the page shows "sold out", "out of stock", or "unavailable".
- "url_valid" is false if this looks like a 404 page, a redirect to homepage, a collection/listing page rather than a single product, or an error page.
- Return valid JSON only. No markdown fences, no explanation.`;

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Extract price info from product page HTML using Claude Sonnet.
 * @param {string} html - Raw HTML of the product page
 * @param {string} url - The product URL (helps with currency inference)
 * @returns {Promise<Object>} Extracted price data
 */
async function extractPrice(html, url) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');

  // Trim HTML to ~8K chars, focusing on likely price regions
  const trimmedHtml = trimToRelevant(html, 8000);

  const userPrompt = `Product page URL: ${url}\n\nHTML content:\n${trimmedHtml}`;

  return enqueue(async () => {
    async function attempt(extra = '') {
      const response = await callClaude({
        component: 'competitor_price_extractor',
        metadata: { url },
        requestOptions: { timeout: 30000, maxRetries: 2 },
        model: MODELS.SONNET,
        max_tokens: 500,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: extra ? `${userPrompt}\n\n${extra}` : userPrompt }],
      });
      return response.content[0].text;
    }

    try {
      const text = await attempt();
      return parseJson(text);
    } catch (firstErr) {
      const isParseError = firstErr instanceof SyntaxError;
      try {
        const text = await attempt(isParseError ? 'IMPORTANT: Return valid JSON only.' : '');
        return parseJson(text);
      } catch (err) {
        return {
          product_name: null,
          price: null,
          compare_at_price: null,
          currency_code: 'USD',
          in_stock: false,
          url_valid: false,
          error: err.message || String(err),
        };
      }
    }
  });
}

/**
 * Trim HTML to keep the most relevant parts for price extraction.
 * Focuses on: title, meta tags, product JSON-LD, price-related elements.
 */
function trimToRelevant(html, maxChars) {
  if (!html || html.length <= maxChars) return html;

  const parts = [];

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) parts.push(`<title>${titleMatch[1]}</title>`);

  // Extract JSON-LD (often has structured price data)
  const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const match of jsonLdMatches.slice(0, 3)) {
      parts.push(match);
    }
  }

  // Extract meta tags (og:price, product:price)
  const metaMatches = html.match(/<meta[^>]*(?:price|amount|currency|product)[^>]*>/gi);
  if (metaMatches) parts.push(metaMatches.join('\n'));

  // Extract common price container patterns
  const pricePatterns = [
    /<[^>]*class="[^"]*price[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<[^>]*id="[^"]*price[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<[^>]*data-product-price[^>]*>[\s\S]*?<\/[^>]+>/gi,
  ];
  for (const pattern of pricePatterns) {
    const matches = html.match(pattern);
    if (matches) parts.push(matches.slice(0, 5).join('\n'));
  }

  const assembled = parts.join('\n\n');

  // If we found structured data, use it; otherwise fall back to raw HTML chunk
  if (assembled.length > 200) {
    return assembled.slice(0, maxChars);
  }

  // Fallback: return the middle portion of the HTML (where product content usually lives)
  const start = Math.max(0, Math.floor(html.length * 0.2));
  return html.slice(start, start + maxChars);
}

module.exports = { extractPrice };
