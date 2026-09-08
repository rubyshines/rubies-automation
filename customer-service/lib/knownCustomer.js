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

/**
 * Order history for a batch of addresses at once: email (lowercased) →
 * { orders, last_order_at }. Addresses with no orders are absent from the map.
 *
 * Same policy as hasOrderHistory, for callers that classify many senders per
 * pass (the Gmail classifier's Tier-3 batch, the B2B "New inbound" strip): a
 * customer replying to our newsletter from a work address reads, on headers
 * alone, like a company writing in. The orders table is the one thing that
 * settles it, and neither the model nor the operator can see it without this.
 *
 * Fail-soft to an empty map — a lookup error must never stop classification,
 * it only withholds the hint.
 *
 * @param {object} supabase
 * @param {string[]} emails
 * @returns {Promise<Map<string, {orders: number, last_order_at: string}>>}
 */
async function orderHistoryByEmail(supabase, emails) {
  const out = new Map();
  const wanted = [...new Set((emails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return out;
  try {
    // customer_email is stored as Shopify sends it (normally lowercase); the
    // batch match is exact on the lowercased address, which covers the same
    // ground as hasOrderHistory's ilike for every address we have seen.
    const { data, error } = await supabase
      .from('orders')
      .select('customer_email, created_at')
      .in('customer_email', wanted)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) {
      console.warn(`[known-customer] batch orders lookup failed: ${error.message}`);
      return out;
    }
    for (const row of data || []) {
      const key = String(row.customer_email || '').toLowerCase();
      const prev = out.get(key);
      if (prev) prev.orders += 1;
      else out.set(key, { orders: 1, last_order_at: row.created_at });
    }
  } catch (e) {
    console.warn(`[known-customer] batch orders lookup threw: ${e.message}`);
  }
  return out;
}

module.exports = { hasOrderHistory, orderHistoryByEmail };
