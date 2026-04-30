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

  // Convert markdown links [text](url) to <a> tags. Done before bold so a
  // link's display text containing ** still gets bold-converted afterward.
  let html = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    `<a href="$2" style="${LINK_STYLE}">$1</a>`
  );

  // Convert **bold** to <strong>. The advisor uses bold to label option items
  // ("**Split the shipment.**"); without conversion, customers see literal
  // asterisks in the email. Single * is intentionally not handled — too risky
  // (false matches in product names, etc.).
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

  // Convert newlines to <br> and wrap in <p>
  return `<p>${html.replace(/\n/g, '<br>')}</p>`;
}

module.exports = { autoLinkProducts };
