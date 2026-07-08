/**
 * Return rates cache — refund and exchange rates per SKU prefix.
 *
 * Identifies exchange orders from two sources:
 *   1. Orders tagged 'exchange' (MCP-created exchanges)
 *   2. cs_conversations with resolution_type='exchange' → matched to $0 draft orders
 * Note: CS_AIOD is a general "CS draft order" tag, NOT exchange-specific — do not use.
 *
 * Refund data comes from order_line_items.refunded_quantity (authoritative from Shopify).
 *
 * Lazy-loads on first access. Rates are stable over time so caching for the
 * server lifetime is fine — restart or call refreshReturnRates() to update.
 */

const { getSupabaseClient, fetchAllPaginated, readMany } = require('../../shared/supabaseClient');

let ratesMap = null; // Map<sku_prefix, { sold, refunded, exchanged, refundRate, exchangeRate }>

// Max credible exchange rate — anything above is misclassified (samples/promos/gifts)
const MAX_EXCHANGE_RATE = 0.20;

async function loadReturnRates() {
  const supabase = getSupabaseClient();

  // ── Step 1: Identify exchange order IDs ──

  // Layer A: orders tagged 'exchange' (MCP-created exchanges only;
  // CS_AIOD is a general "CS draft order" tag, NOT exchange-specific)
  const exchangeOrderIds = new Set();
  const taggedExchanges = await fetchAllPaginated(() => supabase.from('orders')
    .select('shopify_order_id')
    .contains('tags', ['exchange'])
    .order('id', { ascending: true }));
  taggedExchanges.forEach(o => exchangeOrderIds.add(o.shopify_order_id));

  // Layer B: cs_conversations with resolution_type='exchange'
  // For each, find $0 draft orders by the same customer. (Paginated — this was
  // unpaginated and truncated at 1000, undercounting exchanges → wrong rates.)
  const convExchanges = await fetchAllPaginated(() => supabase.from('cs_conversations')
    .select('customer_email')
    .eq('resolution_type', 'exchange')
    .order('id', { ascending: true }));

  const uniqueEmails = [...new Set(convExchanges.map(c => c.customer_email).filter(Boolean))];
  for (let i = 0; i < uniqueEmails.length; i += 50) {
    const batch = uniqueEmails.slice(i, i + 50);
    for (const email of batch) {
      const custOrders = await readMany(supabase.from('orders')
        .select('shopify_order_id')
        .eq('customer_email', email)
        .lte('total_price', 1)
        .eq('source_name', 'shopify_draft_order'));
      for (const o of custOrders) {
        exchangeOrderIds.add(o.shopify_order_id);
      }
    }
  }

  // ── Step 2: Scan all line items, separate exchange vs paid ──
  const soldByPrefix = {};
  const refundedByPrefix = {};
  const exchangedByPrefix = {};

  const items = await fetchAllPaginated(() => supabase.from('order_line_items')
    .select('shopify_order_id,sku,quantity,refunded_quantity')
    .order('id', { ascending: true }));
  for (const li of items) {
    if (!li.sku) continue;
    const prefix = li.sku.split('-')[0].toUpperCase();

    if (exchangeOrderIds.has(li.shopify_order_id)) {
      // This is an exchange order — count units as exchange replacements
      exchangedByPrefix[prefix] = (exchangedByPrefix[prefix] || 0) + li.quantity;
    } else {
      // Paid order — count sold + refunded
      soldByPrefix[prefix] = (soldByPrefix[prefix] || 0) + li.quantity;
      refundedByPrefix[prefix] = (refundedByPrefix[prefix] || 0) + (li.refunded_quantity || 0);
    }
  }

  // ── Step 3: Build rates map ──
  ratesMap = new Map();
  const allPrefixes = new Set([
    ...Object.keys(soldByPrefix),
    ...Object.keys(exchangedByPrefix),
  ]);

  for (const prefix of allPrefixes) {
    const sold = soldByPrefix[prefix] || 0;
    const refunded = refundedByPrefix[prefix] || 0;
    const exchanged = exchangedByPrefix[prefix] || 0;
    if (sold === 0) continue;

    let exchangeRate = exchanged / sold;
    // Cap at MAX_EXCHANGE_RATE — anything above is misclassified (tees, samples, etc.)
    const capped = exchangeRate > MAX_EXCHANGE_RATE;
    if (capped) exchangeRate = MAX_EXCHANGE_RATE;

    ratesMap.set(prefix, {
      sold,
      refunded,
      exchanged,
      refundRate: refunded / sold,
      exchangeRate,
      capped,
    });
  }

  console.error(`[ReturnRatesCache] Loaded rates for ${ratesMap.size} SKU prefixes from ${exchangeOrderIds.size} exchange orders`);
}

async function ensureLoaded() {
  if (!ratesMap) await loadReturnRates();
}

async function getRatesForSku(fullSku) {
  await ensureLoaded();
  if (!fullSku) return null;
  const prefix = fullSku.split('-')[0].toUpperCase();
  return ratesMap.get(prefix) || null;
}

async function getRatesByPrefix(prefix) {
  await ensureLoaded();
  if (!prefix) return null;
  return ratesMap.get(prefix.toUpperCase()) || null;
}

async function getAllRates() {
  await ensureLoaded();
  return Array.from(ratesMap.entries()).map(([prefix, rates]) => ({ prefix, ...rates }));
}

async function refreshReturnRates() {
  ratesMap = null;
  await loadReturnRates();
  return ratesMap.size;
}

module.exports = { loadReturnRates, getRatesForSku, getRatesByPrefix, getAllRates, refreshReturnRates };
