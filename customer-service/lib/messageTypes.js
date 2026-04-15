/**
 * Canonical CS message_type taxonomy.
 *
 * This is the single source of truth for cs_tickets.message_type values.
 * Write paths must validate against this set and coerce non-canonical
 * values to 'uncategorized' (with a warning log).
 *
 * Note: this is the category-of-inquiry taxonomy used by the dashboard,
 * spam filter, and routing. It is DISTINCT from the intake sub-taxonomy
 * used by sizingEngine.js (which lives in intake_state JSONB with values
 * like refund_request, product_not_working, wrong_item_shipped, etc.).
 * Do not conflate the two.
 */

const CANONICAL_MESSAGE_TYPES = new Set([
  'exchange',
  'refund',
  'defect',
  'sizing_inquiry',
  'shipping',
  'closing',
  'general_inquiry',
  'business_outreach',
  'community_outreach',
  'uncategorized',
]);

/**
 * Validate a message_type value against the canonical set.
 * Returns the canonical value, or 'uncategorized' if invalid/missing.
 * Logs a warning when coercing a non-empty but non-canonical value.
 *
 * @param {string|null|undefined} value
 * @param {string} [context] — optional context string for the warning (e.g. ticket id)
 * @returns {string}
 */
function canonicalMessageType(value, context = '') {
  if (value && CANONICAL_MESSAGE_TYPES.has(value)) return value;
  if (value) {
    const where = context ? ` for ${context}` : '';
    console.warn(`[messageTypes] Non-canonical message_type "${value}"${where} — coercing to uncategorized`);
  }
  return 'uncategorized';
}

module.exports = { CANONICAL_MESSAGE_TYPES, canonicalMessageType };
