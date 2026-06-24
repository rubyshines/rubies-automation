/**
 * Pre-order sync — push incoming-inventory dates/quantities to the website.
 *
 * Reads the incoming-inventory Google Sheet (us-YYYY-MM-DD tabs, sku + incoming
 * columns) and reconciles each variant's pre-order state on Shopify so the
 * storefront shows it as available for pre-order:
 *   - inventory_policy = CONTINUE  (master switch: OOS variant stays buyable,
 *     PDP button flips to "Pre-Order")
 *   - custom.pre_order_incoming_us  = total units still incoming (number_integer)
 *   - custom.pre_order_date_us      = soonest upcoming arrival date (date)
 * api.rubyshines.com reads these per-country _us metafields to render the
 * pre-order message the customer sees.
 *
 * Reconcile: any variant currently marked pre-order (pre_order_date set in our
 * catalog) that no longer has a future-dated arrival in the sheet is cleared
 * (inventory_policy = DENY + the _us metafields deleted). Scope both the set and
 * the clear to a SKU prefix with skuFilter (e.g. "MPAD").
 *
 * Catalog source of truth for SKU -> variant/product resolution is the Supabase
 * `product_variants` mirror, so this runs without loading the in-memory cache.
 */

const NAMESPACE = 'custom';
const INCOMING_KEY = 'pre_order_incoming_us';
const DATE_KEY = 'pre_order_date_us';

/** Today's date as YYYY-MM-DD in Eastern Time. */
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Pure: collapse the per-SKU incoming shipments into the single pre-order
 * indicator the website shows. Only shipments arriving on/after `today` count.
 *
 * @param {Map<string,{incoming:Array<{date:string,quantity:number}>}>} incomingBySku
 * @param {string} today  YYYY-MM-DD
 * @returns {Map<string,{date:string,incoming:number}>}  earliest upcoming date + total upcoming qty
 */
function computePreOrderState(incomingBySku, today) {
  const desired = new Map();
  for (const [sku, entry] of incomingBySku) {
    const future = (entry.incoming || []).filter(s => s.date >= today && s.quantity > 0);
    if (future.length === 0) continue;
    const date = future.reduce((min, s) => (s.date < min ? s.date : min), future[0].date);
    const incoming = future.reduce((sum, s) => sum + s.quantity, 0);
    desired.set(sku, { date, incoming });
  }
  return desired;
}

/** Load the catalog variant mirror, keyed by upper-cased SKU. Paginated. */
async function loadVariantsBySku(supabase) {
  const rows = [];
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('sku, shopify_variant_id, shopify_product_id, pre_order_incoming, pre_order_date')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`product_variants load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const bySku = new Map();
  for (const r of rows) {
    if (r.sku) bySku.set(r.sku.trim().toUpperCase(), r);
  }
  return { rows, bySku };
}

function setVariantInput(variantId, date, incoming) {
  return {
    id: variantId,
    inventoryPolicy: 'CONTINUE',
    metafields: [
      { namespace: NAMESPACE, key: INCOMING_KEY, type: 'number_integer', value: String(incoming) },
      { namespace: NAMESPACE, key: DATE_KEY, type: 'date', value: date },
    ],
  };
}

/**
 * Reconcile pre-order state from the sheet to Shopify + Supabase.
 *
 * @param {object} opts
 * @param {string|null} opts.skuFilter  Only act on SKUs starting with this prefix (case-insensitive). Omit for all.
 * @param {boolean} opts.dryRun  When true, compute the plan but make no writes.
 * @param {string} [opts.today]  Override today (YYYY-MM-DD); defaults to ET today.
 * @param {object} [opts.deps]  Injectable deps for testing.
 * @returns {Promise<object>} summary { dryRun, today, skuFilter, set, cleared, skipped, errors }
 */
async function syncPreOrders({ skuFilter = null, dryRun = false, today = null, onProgress = null, deps = {} } = {}) {
  const day = today || todayET();
  const report = msg => { if (typeof onProgress === 'function') onProgress(msg); };
  const fetchIncoming = deps.fetchIncomingOrders
    || require('./inventoryProjection').fetchIncomingOrders;
  const supabase = deps.supabase
    || require('../../../shared/supabaseClient').getSupabaseClient();
  const shopify = deps.shopify || require('../shopify');

  const matchesFilter = sku =>
    !skuFilter || sku.trim().toUpperCase().startsWith(skuFilter.trim().toUpperCase());

  report('Reading incoming-inventory sheet…');
  const incomingBySku = await fetchIncoming();
  const desired = computePreOrderState(incomingBySku, day);
  const desiredUpper = new Set([...desired.keys()].map(s => s.trim().toUpperCase()));
  report(`Sheet has ${desired.size} SKU(s) with upcoming arrivals.`);

  report('Loading catalog variants…');
  const { rows, bySku } = await loadVariantsBySku(supabase);

  const set = [];
  const skipped = [];

  // SET / update: every desired SKU within filter whose web state is stale.
  for (const [sku, d] of desired) {
    if (!matchesFilter(sku)) continue;
    const row = bySku.get(sku.trim().toUpperCase());
    if (!row) {
      skipped.push({ sku, reason: 'no matching variant in catalog' });
      continue;
    }
    const same =
      row.pre_order_date === d.date &&
      Number(row.pre_order_incoming) === Number(d.incoming);
    if (row.pre_order_date != null && same) continue; // already correct
    set.push({
      sku: row.sku,
      variantId: row.shopify_variant_id,
      productId: row.shopify_product_id,
      date: d.date,
      incoming: d.incoming,
      previous: row.pre_order_date ? { date: row.pre_order_date, incoming: row.pre_order_incoming } : null,
    });
  }

  // CLEAR: currently-marked variants (within filter) with no future arrival left.
  const cleared = [];
  for (const row of rows) {
    if (row.pre_order_date == null) continue;
    if (!row.sku || !matchesFilter(row.sku)) continue;
    if (desiredUpper.has(row.sku.trim().toUpperCase())) continue;
    cleared.push({
      sku: row.sku,
      variantId: row.shopify_variant_id,
      productId: row.shopify_product_id,
      previous: { date: row.pre_order_date, incoming: row.pre_order_incoming },
    });
  }

  const errors = [];
  report(`Plan: ${set.length} to set/update, ${cleared.length} to clear` +
    (skipped.length ? `, ${skipped.length} skipped` : '') + '.');
  if (dryRun) {
    return { dryRun: true, today: day, skuFilter, set, cleared, skipped, errors };
  }

  // --- Execute: Shopify writes grouped by product, then mirror to Supabase. ---

  // SETs grouped by product (one bulk call per product).
  const setsByProduct = new Map();
  for (const op of set) {
    if (!op.variantId || !op.productId) {
      errors.push({ sku: op.sku, op: 'set', error: 'missing variant/product id' });
      continue;
    }
    if (!setsByProduct.has(op.productId)) setsByProduct.set(op.productId, []);
    setsByProduct.get(op.productId).push(op);
  }
  const setDone = [];
  let setBatch = 0;
  for (const [productId, ops] of setsByProduct) {
    setBatch++;
    const skuList = ops.map(o => o.sku).join(', ');
    try {
      await shopify.updateVariantPreOrder(
        productId,
        ops.map(o => setVariantInput(o.variantId, o.date, o.incoming))
      );
      setDone.push(...ops);
      report(`  set [${setDone.length}/${set.length}] ${skuList}`);
    } catch (err) {
      for (const o of ops) errors.push({ sku: o.sku, op: 'set', error: err.message });
      report(`  set FAILED (${skuList}): ${err.message}`);
    }
  }

  // CLEARs grouped by product: policy -> DENY, then delete the _us metafields.
  const clearsByProduct = new Map();
  for (const op of cleared) {
    if (!op.variantId || !op.productId) {
      errors.push({ sku: op.sku, op: 'clear', error: 'missing variant/product id' });
      continue;
    }
    if (!clearsByProduct.has(op.productId)) clearsByProduct.set(op.productId, []);
    clearsByProduct.get(op.productId).push(op);
  }
  const clearDone = [];
  for (const [productId, ops] of clearsByProduct) {
    const skuList = ops.map(o => o.sku).join(', ');
    try {
      await shopify.updateVariantPreOrder(
        productId,
        ops.map(o => ({ id: o.variantId, inventoryPolicy: 'DENY' }))
      );
      await shopify.deleteVariantMetafields(
        ops.flatMap(o => [
          { ownerId: o.variantId, namespace: NAMESPACE, key: INCOMING_KEY },
          { ownerId: o.variantId, namespace: NAMESPACE, key: DATE_KEY },
        ])
      );
      clearDone.push(...ops);
      report(`  cleared [${clearDone.length}/${cleared.length}] ${skuList}`);
    } catch (err) {
      for (const o of ops) errors.push({ sku: o.sku, op: 'clear', error: err.message });
      report(`  clear FAILED (${skuList}): ${err.message}`);
    }
  }

  // Mirror successful writes to the Supabase catalog so it isn't a day stale.
  report('Mirroring changes to Supabase…');
  for (const o of setDone) {
    const { error } = await supabase
      .from('product_variants')
      .update({ pre_order_incoming: o.incoming, pre_order_date: o.date })
      .eq('shopify_variant_id', o.variantId);
    if (error) errors.push({ sku: o.sku, op: 'supabase-set', error: error.message });
  }
  for (const o of clearDone) {
    const { error } = await supabase
      .from('product_variants')
      .update({ pre_order_incoming: null, pre_order_date: null })
      .eq('shopify_variant_id', o.variantId);
    if (error) errors.push({ sku: o.sku, op: 'supabase-clear', error: error.message });
  }

  return {
    dryRun: false,
    today: day,
    skuFilter,
    set: setDone,
    cleared: clearDone,
    skipped,
    errors,
  };
}

module.exports = {
  computePreOrderState,
  loadVariantsBySku,
  syncPreOrders,
  todayET,
  NAMESPACE,
  INCOMING_KEY,
  DATE_KEY,
};
