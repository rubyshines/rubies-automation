/**
 * styleSwitch.js — the single implementation of "which style has a wider leg
 * opening, and can we actually supply it in this customer's size".
 *
 * Two consumers must never disagree:
 *   - `compare_products` (what the advisor reads before writing a reply)
 *   - `sizingEngine`'s style_switch branch (the deterministic prescription)
 * They did disagree: the engine crossed a youth 10-16 into adult sizing so a
 * youth swim customer could be offered the Cheeky, while the tool matched the
 * size literally and returned nothing, telling the advisor no wider option
 * existed. Same question, two answers. Hence one module, no local copies.
 *
 * Everything here is pure — the caller passes the active-product map — so it is
 * testable without Supabase and cannot drift per call site.
 *
 * The config field carries two distinct meanings. Collapsing them regresses the
 * recommendation, so keep them apart:
 *   isTarget     — the CUT fact: this style is cut wider through the leg. True
 *                  of the Naomi, and what compare_products surfaces.
 *   recommendFor — what we actually suggest, which also weighs positioning and
 *                  sizing: { tightLegs, ageGroups, sizedIn, everyday }.
 */

const {
  normalizeSize, NUMERIC_SIZES, LETTER_SIZES, NUMERIC_TO_LETTER_UPPER,
} = require('./sizeUtils');

/**
 * The style_switch note when the product is a switch target for this category.
 * `forCategories` scopes a target to where it applies (the Flo answers an
 * underwear question, never a swim one).
 */
function styleSwitchNote(config, category) {
  const ss = config?.styleSwitch;
  if (!ss?.isTarget) return null;
  if (ss.forCategories && !ss.forCategories.includes(category)) return null;
  return ss.note || null;
}

/**
 * The size we would actually send, in the target's own sizing system, or null
 * when the target cannot serve that customer at all.
 *
 * `sizedIn: 'adult'` means the style is sold in adult letters, so a youth
 * numeric has to cross over (10 → XXS … 16 → M). Youth 4-9 have no adult
 * equivalent, so an adult-sized style genuinely cannot serve them.
 *
 * We never cross an adult DOWN into a youth-sized style. An adult XS would
 * physically fit the Flo, but sending an adult to kids' dance underwear is a
 * positioning call, not a sizing one.
 *
 * With no size given, return null for "unknown" rather than guessing — callers
 * decide whether to treat that as available.
 */
function offeredSizeFor(recommendFor, size) {
  const normSize = size ? normalizeSize(size) : null;
  if (!normSize) return null;
  const sizedIn = recommendFor?.sizedIn;
  if (sizedIn === 'adult' && NUMERIC_SIZES.includes(normSize)) {
    return NUMERIC_TO_LETTER_UPPER[normSize] || null;
  }
  if (sizedIn === 'youth' && LETTER_SIZES.includes(normSize)) return null;
  return normSize;
}

/**
 * Youth sizing = a numeric size, EXCEPT 16, which is the youth/adult boundary
 * and is treated as adult (it maps to M and youth styles stop being the right
 * answer there). Shared so the tool and the engine cannot classify the same
 * customer differently.
 */
function isYouthSize(size) {
  const n = size ? normalizeSize(size) : null;
  if (!n) return false;
  return NUMERIC_SIZES.includes(n) && n !== '16';
}

/** True when serving this size means quoting the style's adult equivalent. */
function crossesToAdult(recommendFor, size) {
  const normSize = size ? normalizeSize(size) : null;
  if (!normSize) return false;
  return recommendFor?.sizedIn === 'adult' && NUMERIC_SIZES.includes(normSize);
}

/**
 * Styles to offer for a tight-legs complaint.
 *
 * @param {object}  p
 * @param {object}  p.activeProducts  handle → { nickname, category, styleSwitch }
 * @param {string}  p.category        the category being asked about
 * @param {boolean} p.isKids          customer is on youth sizing
 * @param {string}  [p.size]          their current size; omit to skip the
 *                                    availability check (cut facts only)
 * @param {string}  [p.excludeNickname] the style they already own
 * @param {object}  [p.availability]  nickname -> { inStock, restock }. Passed IN
 *   rather than looked up: this stays a pure synchronous function, and
 *   compare_products remains the only place that knows about stock. Omit it and
 *   nothing is filtered, which is the behaviour before stock was considered.
 * @returns {Array<{nickname, handle, note, everyday, size, crossesToAdult}>}
 *          everyday-wear picks first (so the all-day option leads the copy),
 *          then by nickname so wording is stable between runs.
 */
function tightLegsTargets({ activeProducts, category, isKids, size, excludeNickname, availability } = {}) {
  const ageGroup = isKids ? 'youth' : 'adult';
  const checkSize = Boolean(size);

  return Object.entries(activeProducts || {})
    .filter(([, p]) => {
      const ss = p.styleSwitch;
      if (!ss?.isTarget || !ss.recommendFor?.tightLegs) return false;
      if (p.category !== category) return false;
      if (ss.forCategories && !ss.forCategories.includes(category)) return false;
      const ages = ss.recommendFor.ageGroups;
      if (ages && !ages.includes(ageGroup)) return false;
      if (excludeNickname && String(p.nickname).toLowerCase() === String(excludeNickname).toLowerCase()) return false;
      // A style we would recommend but cannot supply in their size is not an
      // option. This keeps the Cheeky for a youth 10-16 (crosses to adult
      // XXS-M) and correctly rules it out for a youth 4-9.
      if (checkSize && offeredSizeFor(ss.recommendFor, size) === null) return false;
      // A style we cannot ship is not an option. Without this the deterministic
      // reply promised the Naomi, which is out of stock in every size with no
      // inbound, while compare_products had already stopped offering it.
      if (availability && !isOfferable(availability[p.nickname])) return false;
      return true;
    })
    .map(([handle, p]) => ({
      nickname: p.nickname,
      restock: availability?.[p.nickname]?.restock || null,
      inStock: availability ? availability[p.nickname]?.inStock !== false : null,
      handle,
      note: styleSwitchNote(p, category),
      everyday: p.styleSwitch.recommendFor.everyday === true,
      size: checkSize ? offeredSizeFor(p.styleSwitch.recommendFor, size) : null,
      crossesToAdult: checkSize ? crossesToAdult(p.styleSwitch.recommendFor, size) : false,
    }))
    .sort((a, b) => (b.everyday === true) - (a.everyday === true) || a.nickname.localeCompare(b.nickname));
}

/**
 * Offerable = in stock, or out of stock with a restock close enough to be worth
 * waiting for. `worth_offering` is decided in restockEta so the window lives in
 * one place. Unknown availability counts as offerable, so a missing entry never
 * silently hides a style.
 */
function isOfferable(entry) {
  if (!entry) return true;
  if (entry.inStock !== false) return true;
  return entry.restock?.worth_offering === true;
}

module.exports = {
  styleSwitchNote,
  isOfferable,
  isYouthSize,
  offeredSizeFor,
  crossesToAdult,
  tightLegsTargets,
};
