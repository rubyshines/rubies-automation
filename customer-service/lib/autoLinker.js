/**
 * Auto-linker: converts markdown links in plain text to styled HTML.
 *
 * The AI advisor outputs markdown links like [AJ](https://rubyshines.com/products/...)
 * when recommending products. This module converts them to clickable HTML at send time.
 *
 * If Jamie edits the response and adds a bare product mention without a link,
 * that's fine — not every mention needs a link.
 */

const LINK_STYLE = 'color:#1a7f64;text-decoration:underline';

/**
 * Convert plain text with optional markdown links to HTML.
 *
 * @param {string} text - Plain text response (may contain markdown links)
 * @returns {string} HTML string with <a> tags for markdown links, <br> for newlines
 */
function autoLinkProducts(text) {
  if (!text) return '';

  // Convert markdown links [text](url) to <a> tags
  let html = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    `<a href="$2" style="${LINK_STYLE}">$1</a>`
  );

  // Convert newlines to <br> and wrap in <p>
  return `<p>${html.replace(/\n/g, '<br>')}</p>`;
}

module.exports = { autoLinkProducts };
