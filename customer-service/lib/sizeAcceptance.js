/**
 * sizeAcceptance.js — which size categories a donation partner can use, and
 * which categories a returned garment falls into.
 *
 * Partners differ in who they serve: a university student centre has no use for
 * a size 6, a kids' closet has no use for a 2X. The onboarding survey used to
 * ask this as three overlapping checkboxes ("Youth 4-8" / "Youth 10-16" /
 * "Adult XS-4X"), which was ambiguous precisely where it mattered — adult XS is
 * the SAME garment measurement as kids 12 (25.5-26.5" waist, see size_charts),
 * so an org that ticked "Adult" but not "Youth 10-16" had said nothing usable.
 *
 * The replacement is a two-way split on the one boundary that is physically
 * real, the point where the kids and adult scales meet:
 *
 *   smaller — kids 4 through 11   (up to and including XXS+ / 24.5-25.5")
 *   larger  — kids 12 through 16, and every adult size XXS through 4X
 *
 * Sizes are categorized by their own label's scale rather than by measurement.
 * Adult XXS is dimensionally a kids 10, but every product that offers XXS
 * (Cheeky, Ava, Sassy, Evey) is adult-only with no kids version at all, so an
 * XXS garment is always an adult garment for a small adult — verified against
 * the catalog 2026-08-20, no product line offers both kids 10/11 and adult XXS.
 * Categorizing by label keeps the rule explainable to an org and matches what is
 * printed on the tag they will actually be holding.
 */

const { normalizeSize, extractSizeFromSku, NUMERIC_SIZES } = require('./sizeUtils');

const SMALLER = 'smaller';
const LARGER = 'larger';

/**
 * The two checkbox options on the LGBTQ+ Organization Donation Onboarding form.
 *
 * These strings MUST match the Google Form's options character-for-character —
 * the form joins a multi-select with ", " into a single cell, and
 * parseSizeAcceptance() reads that cell back. If the form wording changes,
 * change it here in the same breath or new submissions parse to "no sizes".
 */
const SMALLER_LABEL = 'Kids sizes 4-11';
const LARGER_LABEL = 'Teen and adult sizes 12-16, XXS-4X';

/** Highest kids numeric size that still belongs to the smaller category. */
const SMALLER_MAX_NUMERIC = 11;

/** Every adult letter size, including the 5X that only exists as an alias. */
const ADULT_LETTER_SIZES = new Set([
  'XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X', '5X',
]);

/**
 * Which category a single size label falls into.
 * Accepts anything normalizeSize() understands ("XL" → 1X, "L Tall" → L, "8").
 * Returns 'smaller', 'larger', or null when the string isn't a RUBIES size.
 */
function categorizeSize(size) {
  const normalized = normalizeSize(size);
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    if (!NUMERIC_SIZES.includes(normalized)) return null;
    return Number(normalized) <= SMALLER_MAX_NUMERIC ? SMALLER : LARGER;
  }

  return ADULT_LETTER_SIZES.has(normalized) ? LARGER : null;
}

/** Same, from a SKU whose last segment is the size ("RJL-PNK-8" → 'smaller'). */
function categorizeSku(sku) {
  return categorizeSize(extractSizeFromSku(sku).normalized);
}

/**
 * The distinct categories present in a shipment. Unrecognized sizes are
 * dropped rather than defaulting to a category — a garment we can't identify
 * must not silently narrow which partners are eligible.
 */
function shipmentSizeCategories(sizes) {
  const out = new Set();
  for (const s of sizes || []) {
    const c = categorizeSize(s);
    if (c) out.add(c);
  }
  return out;
}

/**
 * Can this partner use every category in the shipment?
 *
 * Requiring ALL of them (rather than any) keeps a mixed box whole: sending a
 * kids 6 and an adult L to an org that can only use one of them leaves the org
 * to dispose of the rest, which is the complaint that prompted this split.
 * An empty category set means we don't know the sizes — every partner stays
 * eligible rather than the filter silently emptying the country.
 */
function partnerAcceptsCategories(partner, categories) {
  if (!categories || categories.size === 0) return true;
  for (const c of categories) {
    if (c === SMALLER && !partner.accepts_smaller_sizes) return false;
    if (c === LARGER && !partner.accepts_larger_sizes) return false;
  }
  return true;
}

/**
 * Read the survey cell (or an operator-typed string) into the two booleans.
 *
 * Understands the current form options and the three legacy ones still sitting
 * in the sheet's history, so re-ingesting an old row years later still lands
 * correctly. Matching is by substring because the current labels contain their
 * own commas, which makes splitting the joined multi-select unreliable.
 *
 * The legacy mapping deliberately treats "Youth sizes 10-16" as LARGER only.
 * That combination (10-16 plus Adult, without 4-8) overlaps the smaller
 * category at exactly one size, 10, and the org explicitly declined 4-8 — so
 * reading it as teen-and-adult risks nothing worse than not sending them a
 * single size, whereas the reverse risks shipping a box they can't use.
 */
function parseSizeAcceptance(text) {
  const s = (text || '').toLowerCase();
  if (!s.trim()) return { accepts_smaller_sizes: false, accepts_larger_sizes: false };

  if (s.includes('all sizes')) {
    return { accepts_smaller_sizes: true, accepts_larger_sizes: true };
  }

  const smaller = s.includes(SMALLER_LABEL.toLowerCase())
    || s.includes('youth sizes 4-8');

  const larger = s.includes(LARGER_LABEL.toLowerCase())
    || s.includes('youth sizes 10-16')
    || s.includes('adult sizes');

  return { accepts_smaller_sizes: smaller, accepts_larger_sizes: larger };
}

/**
 * Render the booleans for display — the operator console, and `sizeRange` in
 * the JSON the donation page reads. Derived rather than stored so the website
 * can never disagree with what routing actually does.
 */
function formatSizeAcceptance(partner) {
  const smaller = !!(partner && partner.accepts_smaller_sizes);
  const larger = !!(partner && partner.accepts_larger_sizes);
  if (smaller && larger) {
    return `${SMALLER_LABEL}, ${LARGER_LABEL.charAt(0).toLowerCase()}${LARGER_LABEL.slice(1)}`;
  }
  if (smaller) return SMALLER_LABEL;
  if (larger) return LARGER_LABEL;
  return '';
}

module.exports = {
  SMALLER,
  LARGER,
  SMALLER_LABEL,
  LARGER_LABEL,
  SMALLER_MAX_NUMERIC,
  categorizeSize,
  categorizeSku,
  shipmentSizeCategories,
  partnerAcceptsCategories,
  parseSizeAcceptance,
  formatSizeAcceptance,
};
