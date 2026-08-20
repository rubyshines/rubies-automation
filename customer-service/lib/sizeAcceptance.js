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
 * The two checkbox options currently on the LGBTQ+ Organization Donation
 * Onboarding form, recorded here so a test can prove the parser still reads
 * them. The form joins a multi-select with ", " into one cell, which
 * parseSizeAcceptance() reads back.
 *
 * Matching deliberately does NOT depend on these exact strings — see
 * parseSizeAcceptance. An earlier version did, and the wording drifted between
 * the form and the code within a day of shipping ("Kids" vs "Youth"), which
 * silently parsed a partner who ticked both boxes as teen-and-adult only. The
 * size numbers are the part that carries the meaning; the prose around them is
 * the part a human will naturally rewrite.
 */
const SMALLER_FORM_OPTION = 'Youth sizes 4-11';
const LARGER_FORM_OPTION = 'Youth size 12 - 16 and Adult sizes XXS-4X.';

/** Display labels for the operator console and the public donation page. */
const SMALLER_LABEL = 'Youth sizes 4-11';
const LARGER_LABEL = 'Youth sizes 12-16 and adult sizes XXS-4X';
const BOTH_LABEL = 'Youth sizes 4-16 and adult sizes XXS-4X';

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
 * Keys on the SIZE RANGES rather than the surrounding prose, so rewording an
 * option on the form ("Kids sizes 4-11" → "Youth sizes 4-11") does not silently
 * stop it parsing. Splitting the joined multi-select on "," is not an option
 * either — an option can contain its own comma — so each category is detected
 * independently across the whole string.
 *
 * Also understands the three legacy options still sitting in the sheet's
 * history, so re-ingesting an old row years from now still lands correctly.
 *
 * The legacy mapping treats "Youth sizes 10-16" as LARGER only. Note what that
 * costs: sizes 10 and 11 sit on the smaller side of the new boundary, and they
 * are ~10% of all units ever sold (size 10 alone is the third-biggest size),
 * so those orgs stop receiving a real slice of volume they had said yes to.
 * It is still the right read — the current smaller box is "4-11", which is
 * mostly sizes they explicitly declined, and an org that said no to 4-8 would
 * be unlikely to tick it. Confirmed with Jamie 2026-08-20. The alternative
 * risks shipping boxes an org cannot use at all, which is the failure that
 * prompted this whole split.
 */
// Current form: "...4-11". Legacy: "Youth sizes 4-8".
const SMALLER_PATTERN = /\b4\s*-\s*(11|8)\b/;
// Current form: "...12 - 16..." and/or "Adult sizes ...". Legacy: "Youth sizes
// 10-16", "Adult sizes XS - 4X".
const LARGER_PATTERN = /\b12\s*-\s*16\b|\b10\s*-\s*16\b|adult sizes/;

function parseSizeAcceptance(text) {
  const s = (text || '').toLowerCase();
  if (!s.trim()) return { accepts_smaller_sizes: false, accepts_larger_sizes: false };

  if (s.includes('all sizes')) {
    return { accepts_smaller_sizes: true, accepts_larger_sizes: true };
  }

  return {
    accepts_smaller_sizes: SMALLER_PATTERN.test(s),
    accepts_larger_sizes: LARGER_PATTERN.test(s),
  };
}

/**
 * Render the booleans for display — the operator console, and `sizeRange` in
 * the JSON the donation page reads. Derived rather than stored so the website
 * can never disagree with what routing actually does.
 */
function formatSizeAcceptance(partner) {
  const smaller = !!(partner && partner.accepts_smaller_sizes);
  const larger = !!(partner && partner.accepts_larger_sizes);
  // Both categories collapse to one continuous run (4-11 plus 12-16 is 4-16)
  // rather than reading as two ranges stitched together.
  if (smaller && larger) return BOTH_LABEL;
  if (smaller) return SMALLER_LABEL;
  if (larger) return LARGER_LABEL;
  return '';
}

module.exports = {
  SMALLER,
  LARGER,
  SMALLER_FORM_OPTION,
  LARGER_FORM_OPTION,
  SMALLER_LABEL,
  LARGER_LABEL,
  BOTH_LABEL,
  SMALLER_MAX_NUMERIC,
  categorizeSize,
  categorizeSku,
  shipmentSizeCategories,
  partnerAcceptsCategories,
  parseSizeAcceptance,
  formatSizeAcceptance,
};
