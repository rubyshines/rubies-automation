// Which part of a customer email the operator actually sees.
//
// A Gorgias message carries two representations of the same email: the HTML we
// store on `body_html` (Gorgias's `stripped_html`, falling back to the raw
// `body_html`) and the plain text on `body`. They are supposed to say the same
// thing. They do not always:
//
//   - Outlook sends multipart mail whose text/html part holds a fragment of the
//     reply ("Absolutely!") while the full message lives in text/plain.
//   - Gorgias's own quote stripper sometimes cuts a trailing line off the HTML.
//     Ticket #111280367 (2026-08-05): the customer named the product they wanted
//     in bold on its own line — "BROOKE SHAPING BRA (1X)" — and stripped_html
//     ended one line earlier. The operator saw "could I return the tankini and
//     get this instead?" with no antecedent for "this", while the advisor (which
//     reads the plain text) had correctly drafted the Brooke exchange.
//
// The invariant this module defends: **the operator sees at least everything the
// advisor read.** When the HTML is missing content the customer wrote, we render
// the plain text instead — losing formatting is always better than losing words.
//
// Pure functions, no DOM: loaded as a plain script in the browser
// (window.messageBody) and required directly by the tests.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.messageBody = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Where the customer's own words stop. Two kinds of marker, both trailing:
  // the quoted reply chain, and the client-appended sign-off boilerplate.
  // Gorgias's stripped_html removes both from the HTML, so a plain-text body that
  // still carries them would otherwise look like the HTML had lost content.
  const BODY_END_MARKERS = [
    /\bFrom:\s[\s\S]{0,200}?\b(?:Sent|Date):\s/i,     // Outlook reply header (Sent: or Date:)
    // "On <date>, <someone> wrote:" — Apple/Gmail. The window is generous because
    // the middle holds a full display name + address. English keeps the leading
    // "On" because "wrote:" on its own is ordinary prose ("I wrote to you about
    // the size:"); the localized verbs below are unambiguous enough to stand alone,
    // and their date prefixes vary too much to anchor on ("Am …", "Le …").
    /\bOn\s[\s\S]{10,200}?\swrote\s*:/i,
    // Anchored at the line start so the cut takes the whole attribution line, not
    // just the tail of it from the verb onward.
    /^[^\n]{0,200}\b(?:schrieb|a écrit|escribió|ha scritto|napisał|skrev|schreef)\b[^\n]{0,160}:/im,
    // Verb-less attribution lines: "<date> <name> <addr>:" (FairEmail), and the
    // localized forms whose verb we would otherwise have to enumerate language by
    // language (Norwegian "skrev", Hebrew "מאת", …). The bracketed address
    // immediately followed by a colon is what they all have in common.
    /^[^\n]{0,240}<[^\n<>]*@[^\n<>]*>\s*:/m,
    /-{2,}\s*Original Message\s*-{2,}/i,
    /-{5,}\s*Forwarded message/i,
    /Begin forwarded message:/i,
    /\n-{2}\s*\n/,                                    // RFC 3676 signature delimiter
    /\bSent from my \w/i,                             // iPhone / Android / T-Mobile device
    /\bGet Outlook for (?:iOS|Android)\b/i,
    /\bYahoo Mail:\s*Search, Organize, Conquer\b/i,
  ];

  /**
   * Cut a plain-text body at the first quoted reply or trailing sign-off block, so
   * we measure/keep only what the customer actually wrote this turn.
   */
  function plainTextBeforeQuote(text) {
    if (!text) return '';
    let cut = text.length;
    for (const re of BODY_END_MARKERS) {
      const m = text.match(re);
      if (m && m.index < cut) cut = m.index;
    }
    return text.slice(0, cut).trim();
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', bull: '•',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    laquo: '«', raquo: '»', deg: '°', eacute: 'é',
    trade: '™', copy: '©', reg: '®', middot: '·',
  };

  /**
   * Decode the HTML entities that show up in real customer mail. Unknown named
   * entities decode to a space rather than to their own letters, so a stray
   * "&widget;" can never masquerade as the word "widget" during comparison.
   */
  function decodeEntities(text) {
    return String(text == null ? '' : text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
        try { return String.fromCodePoint(code); } catch { return ' '; }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? ' ' : named;
    });
  }

  /** The text a human would read off a chunk of HTML: no tags, entities decoded. */
  function htmlVisibleText(html) {
    return decodeEntities(
      String(html == null ? '' : html)
        // Tags whose *content* is never visible go first, content and all.
        .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]*>/g, ' ')
    );
  }

  /**
   * Reduce text to comparable substance: URLs, addresses and client-inserted
   * markers dropped, then everything that is not a letter or digit removed.
   *
   * Whitespace and punctuation go entirely because the two representations
   * disagree about them constantly and never meaningfully — plain text hard-wraps
   * where HTML flows, `<b>BRO</b>OKE` becomes "BRO OKE" once tags are stripped,
   * and typographic quotes swap for straight ones. What survives is the letters
   * the customer typed, which is the only thing worth comparing.
   */
  function normalizeForCompare(text) {
    // Entities are decoded on BOTH sides: Gorgias's plain-text part is often
    // derived from the HTML and keeps the entities ("I&#8217;m"), so decoding
    // only the HTML made every curly apostrophe read as missing content —
    // measured at an 11% false-fallback rate across the stored corpus.
    return decodeEntities(text)
      // Plain-text parts render links as "label (https://…)"; the HTML has only
      // the label. Drop URLs and bare emails from both sides so that asymmetry
      // never reads as missing content.
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
      .replace(/\b[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}\b/gi, ' ')
      // Client-inserted placeholders that exist only in the plain-text part.
      .replace(/\[(?:image|cid|attachment|inline image)[^\]]*\]/gi, ' ')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  // A plain-text line has to carry this much substance before its absence from
  // the HTML is worth switching representations over. Courtesy lines ("Thanks
  // again,", "Thank you!!", a bare phone number) sit below it; the shortest thing
  // an operator would act on ("Please send 2X", "BROOKE SHAPING BRA (1X)") clears
  // it comfortably. Measured against the stored corpus: the difference between 8
  // and 12 is entirely sign-offs.
  const MIN_SUBSTANTIVE_CHARS = 12;

  /**
   * Lines the customer wrote in plain text that do not appear in the HTML at all.
   *
   * Quoted lines (leading ">") are skipped: they belong to an earlier message, and
   * a quote header we failed to recognise would otherwise make every reply look
   * truncated.
   */
  function linesMissingFromHtml(plain, html) {
    const haystack = normalizeForCompare(htmlVisibleText(html));
    return String(plain == null ? '' : plain)
      .split(/\r?\n/)
      .filter(line => !/^\s*>/.test(line))
      .filter(line => {
        const needle = normalizeForCompare(line);
        return needle.length >= MIN_SUBSTANTIVE_CHARS && !haystack.includes(needle);
      })
      .map(line => line.trim());
  }

  // app.js's esc(), duplicated rather than imported so this module stays free of
  // browser globals. Deliberately matches it character for character, including
  // leaving "'" alone.
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const plainAsHtml = (plain) => esc(plain).replace(/\n/g, '<br>');

  /**
   * Decide what to render for a message body, with the reasoning attached.
   *
   * Returns { html, source, missingLines }:
   *   source 'html'     — the HTML says everything the plain text does; render it.
   *   source 'plain'    — the HTML is short of content; render escaped plain text
   *                       (cut at the quoted reply, as the HTML would have been).
   *   source 'no-html'  — no HTML part at all; render the whole escaped body.
   */
  function chooseBody(m) {
    const msg = m || {};
    const html = msg.body_html;
    const body = msg.body || '';
    if (!html) return { html: plainAsHtml(body), source: 'no-html', missingLines: [] };

    const plain = plainTextBeforeQuote(body);
    // Too little plain text to judge by — a one-word reply says nothing about
    // whether the HTML is complete.
    if (plain.length <= 40) return { html, source: 'html', missingLines: [] };

    const missingLines = linesMissingFromHtml(plain, html);
    if (missingLines.length) {
      return { html: plainAsHtml(plain), source: 'plain', missingLines };
    }

    // Backstop for HTML that contains the words but drops the structure around
    // them (nested-table mail, reordered fragments): if the visible HTML text is
    // dramatically shorter than what the customer wrote, trust the plain text.
    const htmlText = normalizeForCompare(htmlVisibleText(html));
    if (htmlText.length < normalizeForCompare(plain).length * 0.6) {
      return { html: plainAsHtml(plain), source: 'plain', missingLines: [] };
    }

    return { html, source: 'html', missingLines: [] };
  }

  /** chooseBody(), for callers that only want the markup. */
  function pickRichestBody(m) {
    return chooseBody(m).html;
  }

  return {
    plainTextBeforeQuote,
    decodeEntities,
    htmlVisibleText,
    normalizeForCompare,
    linesMissingFromHtml,
    chooseBody,
    pickRichestBody,
    MIN_SUBSTANTIVE_CHARS,
  };
});
