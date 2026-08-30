/**
 * Known-customer check — the free, deterministic half of the spam gate.
 *
 * Gorgias's spam detector flags real customers often enough to matter (12
 * order-holding customers between 2026-07-10 and 2026-08-28, including refund
 * and exchange requests that went unanswered for weeks). The override rule:
 * an email address that has placed an order with us is never spam, whatever
 * the filter says. This is a mechanical Supabase lookup (CLAUDE.md exception
 * 1 — the AI can't query the orders table), shared by the webhook fast path
 * and the nightly reconcile sweep so the two can never disagree on policy.
 *
 * Unknown senders are NOT the inverse — "no order" means "let the nightly
 * sweep's vendor-spam triage decide", never "junk". That decision lives in
 * driftTriage.classifyVendorSpam, not here.
 */

/**
 * Does this email address belong to someone who has placed a Shopify order?
 *
 * Fail-soft to false: on a lookup error the caller treats the sender as
 * unknown, which defers them to the nightly sweep instead of dropping them —
 * recoverable, unlike drafting from a broken read.
 *
 * @param {object} supabase
 * @param {string|null|undefined} email
 * @returns {Promise<boolean>}
 */
async function hasOrderHistory(supabase, email) {
  const cleaned = (email || '').trim();
  if (!cleaned) return false;
  try {
    // ilike with no wildcards = case-insensitive equality; Shopify emails are
    // usually lowercase but customer-typed addresses aren't guaranteed to be.
    const { data, error } = await supabase
      .from('orders')
      .select('order_number')
      .ilike('customer_email', cleaned)
      .limit(1);
    if (error) {
      console.warn(`[known-customer] orders lookup failed for ${cleaned}: ${error.message}`);
      return false;
    }
    return (data || []).length > 0;
  } catch (e) {
    console.warn(`[known-customer] orders lookup threw for ${cleaned}: ${e.message}`);
    return false;
  }
}

module.exports = { hasOrderHistory };
