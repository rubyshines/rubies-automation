/**
 * Unfulfilled Orders Analysis Module
 *
 * Extracted from unfulfilled-orders-report.js for use by dailyOrderAlerts.js.
 * Detects unfulfilled orders, classifies reasons (holds, stock, pre-order),
 * auto-resolves address holds, and auto-cancels stale Warehance orders.
 *
 * Exports: checkUnfulfilledOrders() — returns structured results, no email/console.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { businessDaysSince: sharedBusinessDaysSince } = require('../../shared/businessDays');
const { fetchUnfulfilledOrders, getHoldReasons, warehanceOrderUrl, cancelOrder } = require('./warehanceClient');
const { resolveAddressHolds } = require('./addressHoldResolver');

const SHOPIFY_STORE = 'rubies-active-wear';
const PRE_ORDER_TAG_RE = /pre-?order|backorder|coming soon/i;
const KNOWN_BUNDLE_IDS = new Set(['27324', '27097', '37526', '39799', '27022', '27019']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shopifyAdminUrl(shopifyOrderId) {
  const numericId = String(shopifyOrderId).replace(/.*\//, '');
  return `https://admin.shopify.com/store/${SHOPIFY_STORE}/orders/${numericId}`;
}

function businessDaysSince(dateStr) {
  return sharedBusinessDaysSince(dateStr) || 0;
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

function isPreOrderByTags(tags) {
  if (!tags || !Array.isArray(tags)) return false;
  return tags.some(t => PRE_ORDER_TAG_RE.test(t));
}

// ---------------------------------------------------------------------------
// Phase 1: Fetch unfulfilled orders from Supabase
// ---------------------------------------------------------------------------

async function fetchUnfulfilledFromSupabase(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_line_items(*)')
    .in('fulfillment_status', ['UNFULFILLED', 'PARTIALLY_FULFILLED'])
    .not('financial_status', 'in', '("REFUNDED","VOIDED")')
    .is('cancelled_at', null)
    .is('closed_at', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Orders query failed: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Phase 2: Pre-order detection
// ---------------------------------------------------------------------------

async function fetchLineItemProperties(orders) {
  let shopifyModule;
  try {
    shopifyModule = require('../../customer-service/lib/shopify');
  } catch {
    return new Map();
  }

  const propsMap = new Map();
  const orderIds = orders.map(o => o.shopify_order_id).filter(Boolean);

  for (let i = 0; i < orderIds.length; i += 20) {
    const batch = orderIds.slice(i, i + 20);
    const idFilter = batch.map(id => {
      const numId = String(id).replace(/.*\//, '');
      return `id:${numId}`;
    }).join(' OR ');

    const query = `{
      orders(first: 20, query: "${idFilter}") {
        edges {
          node {
            id
            lineItems(first: 50) {
              edges {
                node {
                  variant { id }
                  customAttributes { key value }
                }
              }
            }
          }
        }
      }
    }`;

    try {
      const data = await shopifyModule.shopifyGraphQL(query);
      for (const edge of (data.orders?.edges || [])) {
        const orderId = edge.node.id;
        const attrs = [];
        for (const liEdge of (edge.node.lineItems?.edges || [])) {
          for (const attr of (liEdge.node.customAttributes || [])) {
            attrs.push({
              key: attr.key,
              value: attr.value,
              variantId: liEdge.node.variant?.id,
            });
          }
        }
        propsMap.set(orderId, attrs);
      }
    } catch (err) {
      // Batch query error — continue with remaining batches
    }

    if (i + 20 < orderIds.length) await new Promise(r => setTimeout(r, 500));
  }

  return propsMap;
}

function classifyPreOrder(order, propsMap) {
  const orderIsPreOrder = isPreOrderByTags(order.tags);
  const props = propsMap.get(order.shopify_order_id) || [];
  const hasPreOrderProp = props.some(p => p.key?.toLowerCase() === 'pre-order');
  const hasBundleId = props.some(p =>
    p.key === '_cs_bundle_id' && KNOWN_BUNDLE_IDS.has(String(p.value))
  );
  return orderIsPreOrder || hasPreOrderProp || hasBundleId;
}

// ---------------------------------------------------------------------------
// Phase 3: Inventory check
// ---------------------------------------------------------------------------

async function getInventoryMap(supabase, variantIds) {
  if (!variantIds.length) return new Map();

  const { data: latestRow } = await supabase
    .from('inventory_snapshots')
    .select('date')
    .order('date', { ascending: false })
    .limit(1);

  if (!latestRow?.length) return new Map();
  const latestDate = latestRow[0].date;

  const cleanIds = variantIds.map(v => String(v).replace(/.*\//, ''));

  const { data, error } = await supabase
    .from('inventory_snapshots')
    .select('variant_id, inventory_quantity, sku, product_handle')
    .eq('date', latestDate)
    .in('variant_id', cleanIds);

  if (error) return new Map();

  const map = new Map();
  for (const row of (data || [])) {
    map.set(String(row.variant_id), row);
  }
  return { map, snapshotDate: latestDate };
}

// ---------------------------------------------------------------------------
// Phase 4: Notes
// ---------------------------------------------------------------------------

async function fetchNotes(supabase, orderNumbers) {
  if (!orderNumbers.length) return new Map();

  const { data, error } = await supabase.rpc('get_latest_alert_notes', {
    order_numbers: orderNumbers,
  });

  if (error) {
    // Fall back to direct query if RPC doesn't exist yet
    try {
      const { data: fallback } = await supabase.rpc('get_latest_order_notes', {
        order_numbers: orderNumbers,
      });
      const map = new Map();
      for (const row of (fallback || [])) map.set(row.order_number, row);
      return map;
    } catch {
      return new Map();
    }
  }

  const map = new Map();
  for (const row of (data || [])) map.set(row.order_number, row);
  return map;
}

// ---------------------------------------------------------------------------
// Phase 5: Reason classification
// ---------------------------------------------------------------------------

function classifyOrder(order, whOrder, inventoryInfo, bd) {
  const holds = getHoldReasons(whOrder);

  // Check holds before recency filter — these need action regardless of age
  if (holds.includes('address_hold')) {
    return { reason: 'address_hold', severity: 'urgent', detail: 'Address flagged by warehouse' };
  }
  if (holds.includes('fraud_hold')) {
    return { reason: 'fraud_hold', severity: 'urgent', detail: 'Flagged for fraud review' };
  }

  if (bd < 1 && hoursSince(order.created_at) < 24) {
    return { reason: 'recently_placed', severity: 'normal', detail: null };
  }
  if (holds.includes('payment_hold')) {
    return { reason: 'payment_hold', severity: 'attention', detail: 'Payment hold' };
  }
  if (holds.includes('warehouse_hold')) {
    return { reason: 'warehouse_hold', severity: 'attention', detail: 'Warehouse hold' };
  }
  if (holds.includes('allocation_hold')) {
    return { reason: 'allocation_hold', severity: 'attention', detail: 'Allocation hold' };
  }
  if (holds.includes('store_hold')) {
    return { reason: 'store_hold', severity: 'attention', detail: 'Store hold' };
  }

  // Check out of stock
  const oosItems = [];
  for (const li of (order.order_line_items || [])) {
    if (!li.shopify_variant_id) continue;
    const vid = String(li.shopify_variant_id).replace(/.*\//, '');
    const inv = inventoryInfo?.map?.get(vid);
    if (inv && inv.inventory_quantity <= 0) {
      oosItems.push(`${li.title} / ${li.variant_title || li.sku} (${inv.inventory_quantity} in stock)`);
    }
  }
  if (oosItems.length > 0) {
    return { reason: 'awaiting_stock', severity: 'urgent', detail: oosItems.join('; ') };
  }

  // Warehance status checks
  if (whOrder) {
    if (whOrder.fulfillment_status === 'in_progress') {
      return { reason: 'in_progress', severity: 'normal', detail: 'Being picked/packed at warehouse' };
    }
    if (whOrder.ready_to_ship) {
      return { reason: 'ready_to_ship', severity: 'normal', detail: 'Ready to ship' };
    }
    if (whOrder.not_ready_to_ship_types) {
      const types = Object.entries(whOrder.not_ready_to_ship_types)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      if (types) {
        return { reason: 'not_ready', severity: 'attention', detail: `Not ready: ${types}` };
      }
    }
    return {
      reason: 'at_warehouse',
      severity: bd > 3 ? 'attention' : 'normal',
      detail: 'In Warehance, no holds detected',
    };
  }

  // Not found in Warehance
  if (bd > 2) {
    return { reason: 'not_in_warehouse', severity: 'urgent', detail: 'Not found in Warehance' };
  }

  return { reason: 'unknown', severity: bd > 5 ? 'urgent' : bd > 2 ? 'attention' : 'normal', detail: null };
}

// ---------------------------------------------------------------------------
// Main: checkUnfulfilledOrders()
// ---------------------------------------------------------------------------

/**
 * Analyze all unfulfilled orders and return structured results.
 *
 * @returns {{ results: Array, summary: object, errors: string[], stockIssues: Map }}
 */
async function checkUnfulfilledOrders() {
  const supabase = getSupabaseClient();
  const errors = [];

  // Phase 0: Sync orders from Shopify
  console.log('  [Unfulfilled] Syncing orders from Shopify...');
  try {
    const { runOrders } = require('../../customer-service/sync/syncAll');
    const result = await runOrders();
    const rows = result?.sources?.orders?.rowsWritten || 0;
    console.log(`  [Unfulfilled] Synced ${rows} orders`);
  } catch (err) {
    console.warn(`  [Unfulfilled] Order sync error: ${err.message}`);
    errors.push(`Shopify order sync: ${err.message}`);
  }

  // Phase 1: Fetch unfulfilled orders
  console.log('  [Unfulfilled] Fetching unfulfilled orders...');
  const orders = await fetchUnfulfilledFromSupabase(supabase);
  console.log(`  [Unfulfilled] Found ${orders.length} unfulfilled orders`);

  if (!orders.length) {
    return { results: [], summary: { total: 0, preOrder: 0, resolved: 0, actionable: 0, urgent: 0, attention: 0, normal: 0 }, errors, stockIssues: new Map() };
  }

  // Phase 2: Pre-order detection
  console.log('  [Unfulfilled] Checking pre-order status...');
  const propsMap = await fetchLineItemProperties(orders);

  // Phase 3: Warehance enrichment
  console.log('  [Unfulfilled] Fetching Warehance data...');
  let whOrders = new Map();
  try {
    whOrders = await fetchUnfulfilledOrders();
    console.log(`  [Unfulfilled] Got ${whOrders.size} orders from Warehance`);
  } catch (err) {
    console.warn(`  [Unfulfilled] Warehance API error: ${err.message}`);
    errors.push(`Warehance API: ${err.message}`);
  }

  // Phase 3b: Auto-cancel stale Warehance orders
  const autoCancelledOrders = [];
  if (whOrders.size > 0) {
    console.log('  [Unfulfilled] Checking for stale Warehance orders...');
    const whOrderNumbers = [...whOrders.keys()];

    const { data: fulfilledInShopify } = await supabase
      .from('orders')
      .select('order_number, shopify_order_id, fulfillment_status, customer_email, created_at, total_price, shipping_address, order_line_items(*)')
      .in('order_number', whOrderNumbers.map(Number).filter(n => !isNaN(n)))
      .eq('fulfillment_status', 'FULFILLED')
      .is('cancelled_at', null);

    const staleWhOrders = (fulfilledInShopify || []).filter(o => {
      const whOrder = whOrders.get(String(o.order_number));
      return whOrder && ['unfulfilled', 'partially_fulfilled'].includes(whOrder.fulfillment_status);
    });

    if (staleWhOrders.length > 0) {
      console.log(`  [Unfulfilled] Found ${staleWhOrders.length} stale Warehance orders`);

      for (const o of staleWhOrders) {
        const whOrder = whOrders.get(String(o.order_number));
        const hasHold = whOrder.has_hold;
        const holdReasons = getHoldReasons(whOrder);
        const noneShipped = (whOrder.order_items || []).every(i => (i.quantity_shipped || 0) === 0);

        if (noneShipped) {
          const reason = `Cancelled in Warehance: already fulfilled in Shopify${hasHold ? ' (had ' + holdReasons.join(', ') + ')' : ''}`;
          try {
            await cancelOrder(whOrder.id);
            console.log(`  [Unfulfilled] Cancelled #${o.order_number} in Warehance`);

            await supabase.from('order_alert_notes').insert({
              order_number: o.order_number,
              note: `Auto: ${reason}`,
              resolved: true,
              author: 'auto',
              alert_type: 'unfulfilled',
            });

            autoCancelledOrders.push({
              order: o,
              isPreOrder: false,
              businessDays: businessDaysSince(o.created_at),
              classification: { reason: 'auto_cancelled', severity: 'auto_resolved', detail: reason },
              note: null,
              shopifyUrl: shopifyAdminUrl(o.shopify_order_id),
              warehanceUrl: warehanceOrderUrl(whOrder),
              inventoryInfo: null,
              alertType: 'unfulfilled',
            });

            whOrders.delete(String(o.order_number));
          } catch (err) {
            console.warn(`  [Unfulfilled] Failed to cancel #${o.order_number}: ${err.message}`);
          }
        }
      }
    }
  }

  // Phase 4: Inventory check
  console.log('  [Unfulfilled] Checking inventory...');
  const allVariantIds = [];
  for (const o of orders) {
    for (const li of (o.order_line_items || [])) {
      if (li.shopify_variant_id) allVariantIds.push(li.shopify_variant_id);
    }
  }
  const inventoryInfo = await getInventoryMap(supabase, allVariantIds);

  // Phase 5: Notes
  console.log('  [Unfulfilled] Loading notes...');
  const orderNumbers = orders.map(o => o.order_number);
  const notesMap = await fetchNotes(supabase, orderNumbers);

  // Phase 6: Classify
  console.log('  [Unfulfilled] Classifying orders...');
  const results = orders.map(order => {
    const isPreOrder = classifyPreOrder(order, propsMap);
    const whOrder = whOrders.get(String(order.order_number));
    const bd = businessDaysSince(order.created_at);
    const classification = isPreOrder
      ? { reason: 'pre_order', severity: 'info', detail: 'Customer informed at purchase' }
      : classifyOrder(order, whOrder, inventoryInfo, bd);
    const note = notesMap.get(order.order_number) || null;

    return {
      order,
      isPreOrder,
      businessDays: bd,
      classification,
      note,
      shopifyUrl: shopifyAdminUrl(order.shopify_order_id),
      warehanceUrl: whOrder ? warehanceOrderUrl(whOrder) : null,
      inventoryInfo,
      alertType: 'unfulfilled',
    };
  });

  // Phase 7: Auto-resolve address holds
  const addressHeldOrders = results.filter(r =>
    r.classification.reason === 'address_hold' && !r.note?.resolved
  );
  if (addressHeldOrders.length > 0) {
    console.log(`  [Unfulfilled] Auto-resolving ${addressHeldOrders.length} address hold(s)...`);
    const autoResults = await resolveAddressHolds(supabase, addressHeldOrders, whOrders);
    for (const ar of autoResults) {
      const r = results.find(x => x.order.order_number === ar.orderNumber);
      if (r && ar.autoResolved) {
        r.classification = {
          reason: 'auto_resolved',
          severity: 'auto_resolved',
          detail: `Address hold released - ${ar.reason}`,
        };
        r.autoResolveRule = ar.rule;
      }
    }
  }

  // Merge auto-cancelled orders
  if (autoCancelledOrders.length > 0) {
    results.push(...autoCancelledOrders);
  }

  // Build stock issues map
  const actionable = results.filter(r => !r.isPreOrder && !r.note?.resolved);
  const stockIssues = new Map();
  for (const r of actionable) {
    if (r.classification.reason !== 'awaiting_stock') continue;
    for (const li of (r.order.order_line_items || [])) {
      if (!li.shopify_variant_id) continue;
      const vid = String(li.shopify_variant_id).replace(/.*\//, '');
      const inv = r.inventoryInfo?.map?.get(vid);
      if (inv && inv.inventory_quantity <= 0) {
        const key = li.sku || `${li.title}/${li.variant_title}`;
        const existing = stockIssues.get(key) || {
          sku: li.sku || '-',
          product: li.title,
          variant: li.variant_title || '-',
          inventory: inv.inventory_quantity,
          ordersWaiting: 0,
        };
        existing.ordersWaiting++;
        stockIssues.set(key, existing);
      }
    }
  }

  const summary = {
    total: results.length,
    preOrder: results.filter(r => r.isPreOrder).length,
    resolved: results.filter(r => !r.isPreOrder && r.note?.resolved).length,
    actionable: actionable.length,
    urgent: actionable.filter(r => r.classification.severity === 'urgent').length,
    attention: actionable.filter(r => r.classification.severity === 'attention').length,
    normal: actionable.filter(r => r.classification.severity === 'normal').length,
    autoResolved: actionable.filter(r => r.classification.severity === 'auto_resolved').length,
  };

  return { results, summary, errors, stockIssues };
}

module.exports = { checkUnfulfilledOrders };
