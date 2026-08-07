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

// Matches a markdown link: [label](https://url). Shared by every renderer here
// so the HTML and plain-text paths can never disagree on what a link is.
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

/**
 * Escape HTML-significant characters so stored reply text can be dropped into
 * an email body without becoming markup. Run this BEFORE autoLinkProducts:
 * escaping leaves markdown syntax untouched, so the link conversion still
 * fires, and an ampersand inside a URL escapes to the `&amp;` that HTML
 * attributes want anyway.
 */
function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Compare a link's label to its URL ignoring protocol, www and trailing slash,
// so "rubyshines.com" pointing at "https://rubyshines.com" reads as one thing.
function labelRepeatsUrl(label, url) {
  const bare = (s) => s.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  return bare(label) === bare(url);
}

/**
 * Flatten markdown to readable plain text, for the text/plain half of an email
 * (which has no way to render markup). A link whose label already says the URL
 * collapses to the label; anything else keeps both, so the address is never
 * lost. Bold markers are dropped.
 *
 * @param {string} text - Text that may contain markdown links / bold
 * @returns {string} Plain text with no markdown syntax left in it
 */
function markdownToPlainText(text) {
  if (!text) return '';
  return text
    .replace(MD_LINK, (_m, label, url) => (labelRepeatsUrl(label, url) ? label : `${label} (${url})`))
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1');
}

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
  let html = text.replace(MD_LINK, `<a href="$2" style="${LINK_STYLE}">$1</a>`);

  // Convert **bold** to <strong>. The advisor uses bold to label option items
  // ("**Split the shipment.**"); without conversion, customers see literal
  // asterisks in the email. Single * is intentionally not handled — too risky
  // (false matches in product names, etc.).
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

  // Convert newlines to <br> and wrap in <p>
  return `<p>${html.replace(/\n/g, '<br>')}</p>`;
}

module.exports = { autoLinkProducts, escapeHtml, markdownToPlainText };
