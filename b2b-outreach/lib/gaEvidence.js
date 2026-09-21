/**
 * gaEvidence.js — what a prospect's research profile says the store actually
 * STOCKS, as opposed to what a boolean claimed about it.
 *
 * The discovery researcher ticks `carries_gender_products`, and that flag is
 * not trustworthy: across the 113 imported retailers it is true on 29 rows,
 * and on 15 of those the profile never names a single gender-affirming
 * product. One of them (a Tampa adult chain) carried a "Transgender Products"
 * category that turned out to be toys, and reading the catalog is how the
 * operator caught it. So the only evidence worth ordering a vetting list by
 * is a named product: a gaff, a binder, a packer, a breast form. A store that
 * stocks one of those has already decided trans customers are its customers,
 * which is the whole question a cold intro is asking.
 *
 * Two levels, and the gap between them is the point:
 *   stocks    the profile names a gender-affirming PRODUCT the store carries
 *   audience  it speaks to trans customers but names no product — a good sign
 *             about the room, no evidence about the shelves
 *   none      neither
 *
 * Femme and masc terms are reported separately rather than pooled. RUBIES is
 * underwear for trans women, so gaffs and breast forms sit on our side of the
 * catalog and binders and packers do not; both count as evidence the store
 * serves trans customers at all (the operator's rule), but only the first
 * says they already buy what we sell. Whoever reads the row should be able to
 * see which kind it is without opening the site.
 *
 * Pure and deterministic: no model, no network. The input is the profile text
 * already stored on the company row.
 */

// Named products only. "Gender-affirming" as a bare phrase is deliberately
// NOT here — it describes a shop's self-image, and half these profiles use it
// about stores whose catalog is entirely sex toys. A product noun is the
// claim that can be checked.
const FEMME_TERMS = {
  gaffs: /\bgaffs?\b/i,
  tucking: /\btucking\b|\btuck(ing)? (underwear|panties|gear)\b/i,
  'breast forms': /\bbreast (forms?|plates?)\b|\bbreast form\b/i,
  'hip padding': /\bhip (enhancement|enhancers?|pads?|padding)\b/i,
};

const MASC_TERMS = {
  binders: /\bbinders?\b|\bchest[- ]?bind(ing|ers?)\b/i,
  packers: /\bpackers?\b|\bpacking (underwear|gear)\b|\bstand[- ]to[- ]pee\b|\bSTP\b/,
};

// The store talks to trans customers. Weaker than a product, stronger than
// nothing. "Drag" and "gender-neutral" are left out: both land on shops with
// no trans custom at all, and a signal that fires everywhere ranks nothing.
const AUDIENCE_RE = /\b(transgender|trans (wear|women|woman|men|man|customers|clients|community|friendly|inclusive|masc|femme)|gender[- ]affirming|gender[- ]affirmation|cross[- ]?dress(ing|ers?)?|feminization)\b/i;

/** Split on sentence ends, so a quote can be shown back to the operator. Pure. */
function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function matchTerms(text, table) {
  return Object.entries(table).filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Read a research profile.
 * @param {string} profile the researcher's write-up, as stored on the company
 * @returns {{level: 'stocks'|'audience'|'none', femme: string[], masc: string[],
 *            terms: string[], quote: string|null}}
 */
function readGaEvidence(profile) {
  const text = String(profile || '');
  const none = { level: 'none', femme: [], masc: [], terms: [], quote: null };
  if (!text.trim()) return none;

  const femme = matchTerms(text, FEMME_TERMS);
  const masc = matchTerms(text, MASC_TERMS);
  const terms = [...femme, ...masc];

  if (terms.length) {
    const productRe = [...Object.entries(FEMME_TERMS), ...Object.entries(MASC_TERMS)]
      .filter(([name]) => terms.includes(name)).map(([, re]) => re);
    const quote = sentences(text).find(s => productRe.some(re => re.test(s))) || null;
    return { level: 'stocks', femme, masc, terms, quote };
  }

  if (AUDIENCE_RE.test(text)) {
    return { level: 'audience', femme: [], masc: [], terms: [], quote: sentences(text).find(s => AUDIENCE_RE.test(s)) || null };
  }
  return none;
}

/** One line for a console row. Pure. */
function describeGaEvidence(ev) {
  if (!ev || ev.level === 'none') return 'no gender-affirming evidence';
  if (ev.level === 'audience') return 'speaks to trans customers, no product named';
  return `stocks ${ev.terms.join(', ')}`;
}

module.exports = { readGaEvidence, describeGaEvidence, FEMME_TERMS, MASC_TERMS, AUDIENCE_RE };
