// Pure text parsers for the dashboard's intake card.
//
// Gorgias hands us three different customer-message shapes that all need
// splitting before an operator can read them: the chat order form, the
// help-center contact form, and the chat widget's subject+body capture.
// The parsing is deterministic (fixed vendor templates), so it lives here as
// pure functions with no DOM access — loaded as a plain script in the browser
// (window.intakeParse) and required directly by the tests.
//
// Every function here is display-only. The AI advisor always reads the FULL
// raw body from conversation_history, so a parser bug shows up as an operator
// seeing less than the advisor did, never as a wrong draft.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.intakeParse = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Check if a customer message is the Gorgias order form output */
  function isOrderFormOutput(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    // Plural ("selected items:") and singular ("selected item:") variants both occur
    return (lower.includes('order number:') && /selected items?:/.test(lower))
      || (/selected items?:/.test(lower) && lower.includes('total:'))
      || /^#\d+\s*[-–]\s*\$[\d,.]+\s*[-–]/.test(text.trim());
  }

  /**
   * Help-center contact form template — single customer message with a `-----` divider
   * separating the customer's free-text question from a metadata block (Order: / Item names: / etc.).
   * Distinct from the chat order-form output (which is its own message).
   */
  function isHelpCenterForm(text) {
    if (!text) return false;
    if (!/\n\s*-{5,}\s*\n/.test(text)) return false;
    return /(?:^|\n)\s*(?:Order|Order number|Item names|Order placed|Shipping address)\s*:/i.test(text);
  }

  /** Split a help-center form body into { question, metadata } strings. */
  function splitHelpCenterForm(text) {
    const m = text.match(/\n\s*-{5,}\s*\n/);
    if (!m) return { question: text.trim(), metadata: '' };
    const before = text.slice(0, m.index).trim();
    const after = text.slice(m.index + m[0].length).trim();
    const labelRe = /(?:^|\n)\s*(?:Order|Order number|Item names|Order placed|Shipping address|Tracking number|Fulfillment|Total)\s*:/i;
    const beforeIsMeta = labelRe.test(before);
    const afterIsMeta = labelRe.test(after);
    if (afterIsMeta && !beforeIsMeta) return { question: before, metadata: after };
    if (beforeIsMeta && !afterIsMeta) return { question: after, metadata: before };
    // Both or neither look like metadata — default to "metadata is on the longer side"
    return before.length >= after.length ? { question: after, metadata: before } : { question: before, metadata: after };
  }

  /**
   * Chat-widget offline capture (and the plain contact form) arrives as one
   * message shaped `<subject>\n-----\n<body>`.
   *
   * The subject is USUALLY a category chip the customer picked ("Product
   * Question", "Report Issue"), which is why it used to be blind-stripped as
   * boilerplate. But the field is free text, and when a customer types their
   * own subject it carries real content — sometimes the entire request, with a
   * bot answer like "No" as the only body. Stripping it showed the operator a
   * lone "No" on a ticket that was actually about UK delivery and duties.
   *
   * So: return both halves and let the caller render the subject rather than
   * guessing which one is boilerplate. Returns { subject: '', body: text } when
   * the message isn't this shape.
   */
  function splitContactFormSubject(text) {
    const raw = (text || '').trim();
    const m = raw.match(/^([^\n]+)\n\s*-{3,}\s*\n([\s\S]+)$/);
    if (!m) return { subject: '', body: raw };
    const subject = m[1].trim();
    const body = m[2].trim();
    // A divider with nothing on one side isn't the subject+body shape.
    if (!subject || !body) return { subject: '', body: raw };
    return { subject, body };
  }

  // Product nicknames for the compact item chips. Keys are matched against the
  // product title; values are what the operator sees.
  const PRODUCT_NICKNAMES = {
    'CHARLIE': 'Charlie', 'AJ': 'AJ', 'SERENA': 'Serena', 'RUBY': 'Ruby',
    'BROOKE': 'Brooke', 'AVA': 'Ava', 'CHEEKY': 'Cheeky', 'SASSY': 'Sassy',
    'FLO': 'Flo', 'BIKINI': 'Bikini', 'SKY': 'Sky', 'STELLA': 'Stella',
    'MIA': 'Mia', 'NAOMI': 'Naomi',
  };

  /**
   * Pick a product nickname from a title.
   *
   * Matched by EARLIEST POSITION IN THE TITLE, not by key order in the map.
   * Every RUBIES product leads with its own name ("MIA HALTER BIKINI TOP"),
   * while 'BIKINI' is a category word that appears mid-title on several of
   * them. First-key-wins made "MIA HALTER BIKINI TOP" render as "Bikini" (and
   * did the same to STELLA, and to SKY inside bundle titles) purely because
   * 'BIKINI' sits earlier in the map. Position in the title is the signal that
   * actually separates the product name from the category word.
   *
   * Word-bounded so a key can't match inside a longer word. Ties (same index)
   * go to the longer key.
   */
  function pickNickname(rawName) {
    const upper = (rawName || '').toUpperCase();
    let best = null;
    for (const [key, nick] of Object.entries(PRODUCT_NICKNAMES)) {
      const m = upper.match(new RegExp(`\\b${key}\\b`));
      if (!m) continue;
      if (!best || m.index < best.index || (m.index === best.index && key.length > best.key.length)) {
        best = { index: m.index, key, nick };
      }
    }
    return best ? best.nick : rawName;
  }

  /** Parse "PRODUCT - VARIANT" into { name, variant } using nicknames. */
  function parseProductVariant(raw, qty = '1') {
    const rest = raw.trim();
    const variantMatch = rest.match(/[-–]\s*([^-–]+)$/);
    const variant = variantMatch ? variantMatch[1].trim() : '';
    // Match the nickname against the product-name portion only — colourway and
    // size text can otherwise supply a false match.
    const namePart = variantMatch ? rest.slice(0, variantMatch.index).trim() : rest;
    return { qty, name: pickNickname(namePart || rest), variant };
  }

  /**
   * Parse order form text into compact item lines.
   * Handles two templates:
   *  - Chat order form: "1x THE BROOKE SHAPING BRA - Sandstone / 2X" lines
   *  - Help-center form: "Item names: A - X, B - Y, C - Z" comma-separated
   *  - Help-center return form: "Items requested for return: 1x A - X"
   */
  function parseOrderFormItems(text) {
    if (!text) return [];

    // Help-center "Item names:" comma-separated list (no qty prefix)
    const itemNamesMatch = text.match(/Item names?\s*:\s*([\s\S]*?)(?=\n\s*[A-Z][^:\n]*:|$)/i);
    if (itemNamesMatch && !/\d+x\s+/i.test(itemNamesMatch[1])) {
      return itemNamesMatch[1].trim().split(/,\s*/).filter(Boolean).map(p => parseProductVariant(p));
    }

    // "Items requested for return: 1x ... 1x ..." or chat "1x A - X" lines
    const itemLines = text.match(/\d+x\s+[^\n]+/gi) || [];
    return itemLines.map(line => {
      const qtyMatch = line.match(/^(\d+)x\s+/i);
      const qty = qtyMatch ? qtyMatch[1] : '1';
      const rest = line.replace(/^\d+x\s+/i, '').trim();
      return parseProductVariant(rest, qty);
    });
  }

  // ── plain-text email → display HTML ───────────────────────────────────────
  // We store only the plain-text part of inbound mail, and Gmail's text export
  // of an HTML email leaves artifacts: links become `label<https://url>`,
  // images become "[A picture containing logo  Description automatically
  // generated]" or "[cid:...]". This renders that text readably: artifacts
  // stripped, URLs and mailtos clickable, everything else escaped. Display
  // only — never feeds the advisor or storage.

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function linkDisplay(url) {
    const bare = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
    return bare.length > 60 ? bare.slice(0, 57) + '…' : bare;
  }

  function renderEmailText(raw) {
    let text = String(raw || '');
    // Outlook/Word image + cid placeholders carry no information.
    text = text.replace(/\[(?:cid:[^\]]*|[^\[\]]*Description automatically generated[^\[\]]*)\]\s*/gi, '');
    // Tokenize: angle-bracketed URLs/mailtos (the text export of an HTML
    // link), then bare URLs. Everything between tokens is escaped text.
    const token = /<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>|(https?:\/\/[^\s<>"\)\]]+)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = token.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      const target = m[1] || m[2];
      if (/^mailto:/i.test(target)) {
        const addr = target.replace(/^mailto:/i, '');
        out += `<a href="mailto:${escapeHtml(addr)}">${escapeHtml(addr)}</a>`;
      } else {
        out += `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkDisplay(target))}</a>`;
      }
      last = m.index + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  return {
    renderEmailText,
    isOrderFormOutput,
    isHelpCenterForm,
    splitHelpCenterForm,
    splitContactFormSubject,
    pickNickname,
    parseProductVariant,
    parseOrderFormItems,
    PRODUCT_NICKNAMES,
  };
});
