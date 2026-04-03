/**
 * Auto-linker: detects product mentions in plain text and converts to HTML
 * with clickable links to rubyshines.com product pages.
 *
 * Runs at send time -- the human sees plain text in the editor,
 * customers see linked product names in the email.
 *
 * Display text is normalized to the canonical nickname (e.g. "flo" -> "Flo underwear").
 */

const STORE_URL = 'https://rubyshines.com/products';

// Trailing words that should be absorbed into the link, by category
const CATEGORY_SUFFIXES = {
  underwear_bottom: ['shaping underwear', 'shaping dance underwear', 'dance underwear', 'underwear', 'gaff underwear', 'gaff'],
  underwear_top: ['shaping bra', 'seamless bra', 'bra'],
  swim_bottom: ['bikini bottom', 'bikini bottoms', 'bikini', 'shorty shorts', 'shorty short', 'shorts'],
  swim_top: ['bikini top', 'tankini top', 'tankini', 'halter top', 'top'],
  onepiece: ['one-piece', 'one piece', 'onepiece', 'swimsuit'],
  chest_pads: ['chest pads', 'chest pad', 'pads'],
};

/**
 * Build match phrases from product config rows.
 * Generates nickname + optional trailing product-type words.
 * Returns array of { phrase, url, nickname } sorted longest-first.
 */
function buildProductPhrases(productConfig) {
  const entries = [];

  for (const row of productConfig) {
    if (!row.product_handle || row.category === 'accessory') continue;
    const url = `${STORE_URL}/${row.product_handle}`;
    const nickname = row.nickname || '';
    const phrases = new Set();

    const suffixes = CATEGORY_SUFFIXES[row.category] || [];
    const coreNames = [];

    if (row.nickname) coreNames.push(row.nickname.toLowerCase());
    for (const kw of (row.keywords || [])) coreNames.push(kw.toLowerCase());

    for (const name of coreNames) {
      // Base: "flo", "the flo"
      phrases.add(name);
      phrases.add(`the ${name}`);

      // With trailing suffixes: "flo underwear", "the flo shaping dance underwear", etc.
      for (const suffix of suffixes) {
        // Skip if the suffix duplicates the name (e.g. keyword "gaff" + suffix "gaff")
        if (suffix === name || suffix.startsWith(name)) continue;
        phrases.add(`${name} ${suffix}`);
        phrases.add(`the ${name} ${suffix}`);
      }
    }

    for (const phrase of phrases) {
      entries.push({ phrase, url, nickname });
    }
  }

  // Sort longest first so "the Flo shaping dance underwear" matches before "the Flo"
  entries.sort((a, b) => b.phrase.length - a.phrase.length);
  return entries;
}

/**
 * Find all product matches in text.
 * Returns array of { start, end, matchedText, url, nickname }
 * sorted by position. Longer matches take priority; overlaps are discarded.
 */
function findMatches(text, phrases) {
  const lower = text.toLowerCase();
  const matches = [];

  for (const { phrase, url, nickname } of phrases) {
    let searchFrom = 0;
    while (true) {
      const idx = lower.indexOf(phrase, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      // Word boundary check: char before must be non-alphanumeric (or start of string)
      if (idx > 0 && /\w/.test(lower[idx - 1])) continue;
      // Char after must be non-alphanumeric (or end of string)
      const afterIdx = idx + phrase.length;
      if (afterIdx < lower.length && /\w/.test(lower[afterIdx])) continue;

      matches.push({ start: idx, end: afterIdx, matchedText: text.slice(idx, afterIdx), url, nickname });
    }
  }

  // Sort by start position, then longest first for ties
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Remove overlaps: keep the first (longest) match at each position
  const kept = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      kept.push(m);
      lastEnd = m.end;
    }
  }

  return kept;
}

/**
 * Convert plain text to HTML with product auto-links.
 *
 * @param {string} text - Plain text response (newlines intact)
 * @param {Array} productConfig - Array of { product_handle, nickname, keywords, category }
 * @returns {string} HTML string with <a> tags for product mentions, <br> for newlines
 */
function autoLinkProducts(text, productConfig) {
  if (!text) return '';
  if (!productConfig?.length) {
    return `<p>${text.replace(/\n/g, '<br>')}</p>`;
  }

  const phrases = buildProductPhrases(productConfig);
  const matches = findMatches(text, phrases);

  // Build output by splicing in <a> tags at match positions
  let result = '';
  let cursor = 0;

  for (const m of matches) {
    // Append text before this match
    result += text.slice(cursor, m.start);
    // Preserve "the" outside the link, normalize display to canonical nickname
    const hasThe = m.matchedText.toLowerCase().startsWith('the ');
    if (hasThe) {
      // Keep original casing of "the"/"The"
      result += m.matchedText.slice(0, 4);
    }
    result += `<a href="${m.url}" style="color:#1a7f64;text-decoration:underline">${m.nickname}</a>`;
    cursor = m.end;
  }

  // Append remaining text
  result += text.slice(cursor);

  // Convert newlines to <br> and wrap in <p>
  return `<p>${result.replace(/\n/g, '<br>')}</p>`;
}

module.exports = { autoLinkProducts, buildProductPhrases, findMatches, STORE_URL };
