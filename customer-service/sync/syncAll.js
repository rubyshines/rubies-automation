#!/usr/bin/env node

/**
 * Unified Sync Pipeline — Shopify Orders + Customers + Klaviyo Profiles → Supabase
 *
 * Usage:
 *   node customer-service/sync/syncAll.js --orders [--since 2025-01-01] [--full]
 *   node customer-service/sync/syncAll.js --customers [--batch-size 50]
 *   node customer-service/sync/syncAll.js --klaviyo [--batch-size 20]
 *   node customer-service/sync/syncAll.js --all [--since 2025-01-01]
 *   node customer-service/sync/syncAll.js --refresh-aggregates
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { fetchOrdersForSync, getCustomerProfile } = require('../lib/shopify');

// ---------------------------------------------------------------------------
// CLI args (used in standalone mode)
// ---------------------------------------------------------------------------
function parseCliArgs() {
  const args = process.argv.slice(2);
  const hasFlag = (name) => args.includes(name);
  function getArg(name) {
    const idx = args.indexOf(name);
    if (idx === -1) return null;
    return args[idx + 1] || true;
  }
  return { hasFlag, getArg };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(moneySet, type = 'shopMoney') {
  return moneySet?.[type]?.amount ? parseFloat(moneySet[type].amount) : null;
}

function currency(moneySet, type = 'shopMoney') {
  return moneySet?.[type]?.currencyCode || null;
}

function formatAddress(addr) {
  if (!addr) return null;
  return {
    firstName: addr.firstName || null,
    lastName: addr.lastName || null,
    address1: addr.address1 || null,
    address2: addr.address2 || null,
    city: addr.city || null,
    province: addr.province || null,
    provinceCode: addr.provinceCode || null,
    country: addr.country || null,
    countryCode: addr.countryCodeV2 || addr.countryCode || null,
    zip: addr.zip || null,
    phone: addr.phone || null,
    company: addr.company || null,
  };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// SYNC ORDERS — Shopify → Supabase
// ---------------------------------------------------------------------------

async function syncOrders({ since, full } = {}) {
  const supabase = getSupabaseClient();

  // Default: derive from last synced order's updated_at (high-water mark)
  if (!since && !full) {
    const { data: latest } = await supabase
      .from('orders')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (latest?.[0]?.updated_at) {
      // Subtract 1 hour buffer for safety (late-arriving updates, clock skew)
      const lastUpdate = new Date(latest[0].updated_at);
      lastUpdate.setHours(lastUpdate.getHours() - 1);
      since = lastUpdate.toISOString();
    } else {
      // No orders yet — fetch last 30 days for initial seed
      const d = new Date();
      d.setDate(d.getDate() - 30);
      since = d.toISOString().split('T')[0];
    }
  }

  console.log(`[OrderSync] Fetching orders${since ? ` updated since ${since}` : ' (full sync)'}...`);

  let cursor = null;
  let totalOrders = 0;
  let totalLineItems = 0;
  let customersUpserted = 0;

  while (true) {
    const { orders, pageInfo } = await fetchOrdersForSync(since, cursor);

    if (!orders.length) {
      if (totalOrders === 0) console.log('[OrderSync] No orders to sync');
      break;
    }

    for (const o of orders) {
      const customerEmail = o.customer?.email?.toLowerCase().trim() || null;
      const orderNumber = parseInt(o.name?.replace(/\D/g, ''), 10);

      // --- Ensure customer exists in customers table ---
      if (customerEmail) {
        const { error: custErr } = await supabase
          .from('customers')
          .upsert({
            email: customerEmail,
            shopify_customer_id: o.customer?.id || null,
            first_name: o.customer?.firstName || null,
            last_name: o.customer?.lastName || null,
            synced_at: new Date().toISOString(),
          }, {
            onConflict: 'email',
            // Don't overwrite richer data from a full customer sync
            ignoreDuplicates: false,
          });

        if (custErr) {
          console.error(`[OrderSync] Customer upsert error for ${customerEmail}:`, custErr.message);
        } else {
          customersUpserted++;
        }
      }

      // --- Build discount applications array ---
      const discountApps = (o.discountApplications || []).map(da => ({
        title: da.code || da.title || null,
        allocationMethod: da.allocationMethod,
        targetType: da.targetType,
        value: da.value?.percentage != null
          ? { type: 'percentage', value: da.value.percentage }
          : { type: 'fixed', amount: da.value?.amount, currency: da.value?.currencyCode },
      }));

      // --- Build fulfillments array ---
      const fulfillments = (o.fulfillments || []).map(f => ({
        status: f.status,
        createdAt: f.createdAt,
        deliveredAt: f.deliveredAt || null,
        trackingNumber: f.trackingInfo?.[0]?.number || null,
        trackingUrl: f.trackingInfo?.[0]?.url || null,
        locationId: f.location?.legacyResourceId || null,
      }));

      // --- Upsert order ---
      const orderRow = {
        shopify_order_id: o.id,
        order_number: orderNumber,
        customer_email: customerEmail,

        created_at: o.createdAt,
        updated_at: o.updatedAt,
        cancelled_at: o.cancelledAt || null,
        closed_at: o.closedAt || null,
        fulfilled_at: o._earliestFulfillmentDate,

        fulfillment_status: o.displayFulfillmentStatus,
        financial_status: o.displayFinancialStatus,

        // Shop currency
        shop_currency: currency(o.totalPriceSet, 'shopMoney'),
        total_price: money(o.totalPriceSet, 'shopMoney'),
        subtotal_price: money(o.subtotalPriceSet, 'shopMoney'),
        total_shipping: money(o.totalShippingPriceSet, 'shopMoney'),
        total_tax: money(o.totalTaxSet, 'shopMoney'),
        total_discounts: money(o.totalDiscountsSet, 'shopMoney'),
        total_refunded: money(o.totalRefundedSet, 'shopMoney'),
        current_total_price: money(o.currentTotalPriceSet, 'shopMoney'),

        // Presentment currency
        presentment_currency: currency(o.totalPriceSet, 'presentmentMoney'),
        presentment_total_price: money(o.totalPriceSet, 'presentmentMoney'),
        presentment_subtotal_price: money(o.subtotalPriceSet, 'presentmentMoney'),
        presentment_total_shipping: money(o.totalShippingPriceSet, 'presentmentMoney'),
        presentment_total_tax: money(o.totalTaxSet, 'presentmentMoney'),
        presentment_total_discounts: money(o.totalDiscountsSet, 'presentmentMoney'),
        presentment_total_refunded: money(o.totalRefundedSet, 'presentmentMoney'),
        presentment_current_total_price: money(o.currentTotalPriceSet, 'presentmentMoney'),

        shipping_address: formatAddress(o.shippingAddress),
        billing_address: formatAddress(o.billingAddress),

        discount_codes: o.discountCodes?.length ? o.discountCodes : null,
        discount_applications: discountApps.length ? discountApps : null,
        fulfillments: fulfillments.length ? fulfillments : null,
        shipping_method: o.shippingLines?.edges?.[0]?.node?.title || null,

        note: o.note || null,
        tags: o.tags?.length ? o.tags : null,
        source_name: o.sourceName || null,

        synced_at: new Date().toISOString(),
      };

      const { error: orderErr } = await supabase
        .from('orders')
        .upsert(orderRow, { onConflict: 'shopify_order_id' });

      if (orderErr) {
        console.error(`[OrderSync] Order upsert error for ${o.name}:`, orderErr.message);
        continue;
      }

      // --- Sync line items idempotently ---
      // Old pattern was delete + insert, which raced with concurrent webhook
      // syncs and produced duplicate rows on rare interleaves. New pattern:
      // upsert by shopify_line_item_id (per-line-item stable id from Shopify),
      // then narrow orphan-cleanup deletes legacy null rows + items removed
      // from the order. Race-safe: concurrent upserts on the same line item
      // produce identical rows, no duplicates.
      const lineItemRows = o.lineItems.map(li => {
        // Sum discount allocations for this line item
        let totalDiscount = 0;
        let presentmentTotalDiscount = 0;
        const allocations = (li.discountAllocations || []).map(da => {
          const shopAmt = parseFloat(da.allocatedAmountSet?.shopMoney?.amount || 0);
          const presAmt = parseFloat(da.allocatedAmountSet?.presentmentMoney?.amount || 0);
          totalDiscount += shopAmt;
          presentmentTotalDiscount += presAmt;
          return {
            amount: shopAmt,
            presentmentAmount: presAmt,
            discountApplication: {
              allocationMethod: da.discountApplication?.allocationMethod,
              targetType: da.discountApplication?.targetType,
              value: da.discountApplication?.value,
              code: da.discountApplication?.code || null,
              title: da.discountApplication?.title || null,
            },
          };
        });

        // Look up refunded quantity
        const refundKey = `${li.sku || ''}::${li.variantTitle || ''}`;
        const refundedQty = o._refundedBySkuVariant?.[refundKey] || 0;

        return {
          shopify_order_id: o.id,
          shopify_line_item_id: li.id || null,
          shopify_variant_id: li.variant?.id || null,
          title: li.title,
          variant_title: li.variantTitle || null,
          sku: li.sku || null,
          quantity: li.quantity,

          unit_price: money(li.originalUnitPriceSet, 'shopMoney'),
          unit_price_currency: currency(li.originalUnitPriceSet, 'shopMoney'),
          presentment_unit_price: money(li.originalUnitPriceSet, 'presentmentMoney'),
          presentment_unit_price_currency: currency(li.originalUnitPriceSet, 'presentmentMoney'),

          total_discount: totalDiscount || null,
          presentment_total_discount: presentmentTotalDiscount || null,
          discount_allocations: allocations.length ? allocations : null,

          refunded_quantity: refundedQty,
        };
      });

      if (lineItemRows.length > 0) {
        // Upsert by shopify_line_item_id (partial unique index on the column).
        // Concurrent runs writing the same row resolve to one canonical row.
        const { error: liErr } = await supabase
          .from('order_line_items')
          .upsert(lineItemRows, { onConflict: 'shopify_line_item_id' });
        if (liErr) {
          console.error(`[OrderSync] Line items upsert error for ${o.name}:`, liErr.message);
        } else {
          totalLineItems += lineItemRows.length;
        }
      }

      // Orphan cleanup: remove rows for this order that are NOT in the current
      // Shopify response. Catches (a) line items removed by order edits and
      // (b) legacy rows missing shopify_line_item_id from before the migration.
      const currentLineItemIds = lineItemRows.map(r => r.shopify_line_item_id).filter(Boolean);
      let orphanQuery = supabase
        .from('order_line_items')
        .delete()
        .eq('shopify_order_id', o.id);
      if (currentLineItemIds.length > 0) {
        // Delete rows whose id is NOT in the current set, OR whose id is null (legacy).
        orphanQuery = orphanQuery.or(
          `shopify_line_item_id.is.null,shopify_line_item_id.not.in.(${currentLineItemIds.map(s => `"${s}"`).join(',')})`
        );
      }
      // If currentLineItemIds is empty (order has no line items in Shopify),
      // delete all rows for this order — fall through with no extra filter.
      const { error: orphanErr } = await orphanQuery;
      if (orphanErr) {
        console.error(`[OrderSync] Orphan cleanup error for ${o.name}:`, orphanErr.message);
      }

      totalOrders++;
      if (totalOrders % 50 === 0) {
        console.log(`[OrderSync] Processed ${totalOrders} orders...`);
      }
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;

    // Small delay to be nice to Shopify rate limits
    await delay(500);
  }

  console.log(`[OrderSync] Done! Synced ${totalOrders} orders, ${totalLineItems} line items, ${customersUpserted} customer records touched.`);
  return totalOrders;
}

// ---------------------------------------------------------------------------
// SYNC CUSTOMERS — Enrich from Shopify profiles
// ---------------------------------------------------------------------------

async function syncCustomers({ batchSize = 50 } = {}) {
  const supabase = getSupabaseClient();

  // Find customers that have a Shopify ID but haven't been fully synced,
  // OR customers that have never had a Shopify sync
  const { data: customers, error } = await supabase
    .from('customers')
    .select('email, shopify_customer_id, shopify_synced_at')
    .not('shopify_customer_id', 'is', null)
    .or('shopify_synced_at.is.null,shopify_synced_at.lt.' + new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(batchSize);

  if (error) throw new Error(`Query failed: ${error.message}`);
  if (!customers?.length) {
    console.log('[CustomerSync] All customers are up to date');
    return;
  }

  console.log(`[CustomerSync] Enriching ${customers.length} customers from Shopify...`);
  let enriched = 0;

  for (const cust of customers) {
    try {
      const profile = await getCustomerProfile(cust.shopify_customer_id);
      if (!profile) continue;

      const { error: updateErr } = await supabase
        .from('customers')
        .update({
          first_name: profile.firstName || undefined,
          last_name: profile.lastName || undefined,
          phone: profile.phone || null,
          default_address: formatAddress(profile.defaultAddress),
          total_orders: parseInt(profile.numberOfOrders, 10) || 0,
          total_spent: profile.amountSpent ? parseFloat(profile.amountSpent.amount) : null,
          total_spent_currency: profile.amountSpent?.currencyCode || null,
          tags: profile.tags?.length ? profile.tags : null,
          note: profile.note || null,
          customer_created_at: profile.createdAt,
          shopify_synced_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        })
        .eq('email', cust.email);

      if (updateErr) {
        console.error(`[CustomerSync] Error updating ${cust.email}:`, updateErr.message);
      } else {
        enriched++;
      }

      await delay(300); // Shopify rate limit
    } catch (err) {
      console.error(`[CustomerSync] Error fetching profile for ${cust.email}:`, err.message);
    }
  }

  console.log(`[CustomerSync] Done! Enriched ${enriched}/${customers.length} customers.`);

  // Check remaining
  const { count } = await supabase
    .from('customers')
    .select('email', { count: 'exact', head: true })
    .not('shopify_customer_id', 'is', null)
    .or('shopify_synced_at.is.null,shopify_synced_at.lt.' + new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (count > 0) {
    console.log(`[CustomerSync] ${count} more customers need enrichment. Run again to continue.`);
  }
}

// ---------------------------------------------------------------------------
// REFRESH AGGREGATES — Update denormalized counts on customers table
// ---------------------------------------------------------------------------

async function refreshAggregates() {
  const supabase = getSupabaseClient();
  console.log('[Aggregates] Refreshing customer aggregates...');

  const { data, error } = await supabase.rpc('refresh_customer_aggregates');

  if (error) {
    console.error('[Aggregates] Error:', error.message);
  } else {
    console.log(`[Aggregates] Done! Updated ${data} customer records.`);
  }
}

// ---------------------------------------------------------------------------
// Exported run functions for unified runner
// ---------------------------------------------------------------------------

async function runOrders({ since, full } = {}) {
  try {
    const totalOrders = await syncOrders({ since, full });
    return {
      sources: {
        orders: { success: true, rowsWritten: totalOrders || 0, error: null },
      },
      status: 'success',
    };
  } catch (err) {
    return {
      sources: {
        orders: { success: false, rowsWritten: 0, error: err.message },
      },
      status: 'failure',
    };
  }
}

async function runCustomers({ batchSize } = {}) {
  try {
    await syncCustomers({ batchSize });
    return {
      sources: {
        customers: { success: true, rowsWritten: batchSize || 50, error: null },
      },
      status: 'success',
    };
  } catch (err) {
    return {
      sources: {
        customers: { success: false, rowsWritten: 0, error: err.message },
      },
      status: 'failure',
    };
  }
}

module.exports = { runOrders, runCustomers };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const { hasFlag, getArg } = parseCliArgs();
    const runAll = hasFlag('--all');
    const since = getArg('--since') || null;
    const full = hasFlag('--full');
    const batchSize = getArg('--batch-size') ? parseInt(getArg('--batch-size'), 10) : undefined;

    if (runAll || hasFlag('--orders')) {
      await syncOrders({ since, full });
    }

    if (runAll || hasFlag('--customers')) {
      await syncCustomers({ batchSize });
    }

    if (runAll || hasFlag('--refresh-aggregates')) {
      await refreshAggregates();
    }

    if (!runAll && !hasFlag('--orders') && !hasFlag('--customers') && !hasFlag('--refresh-aggregates')) {
      console.log(`
RUBIES Customer & Order Sync Pipeline

Usage:
  node customer-service/sync/syncAll.js --orders [--since 2025-01-01] [--full]
  node customer-service/sync/syncAll.js --customers [--batch-size 50]
  node customer-service/sync/syncAll.js --all [--since 2025-01-01]
  node customer-service/sync/syncAll.js --refresh-aggregates

Modes:
  --orders       Sync orders from Shopify (default: last 7 days, use --full for all)
  --customers    Enrich customer profiles from Shopify (address, tags, spend)
  --all          Run all sync steps in sequence
  --refresh-aggregates  Recalculate denormalized counts (orders, conversations)

Recommended daily cron:
  node customer-service/sync/syncAll.js --all
      `);
    }
  })().catch(async (err) => {
    console.error('[Sync] Fatal error:', err);

    try {
      const { getSendgridClient } = require('../../shared/sendgridClient');
      const sgMail = getSendgridClient();
      if (sgMail) {
        const date = new Date().toISOString().split('T')[0];
        await sgMail.send({
          to: 'jamie@rubyshines.com',
          from: 'pipeline@rubyshines.com',
          subject: `❌ RUBIES CS Sync — ${date} FAILED`,
          text: `Customer/order sync failed:\n\n${err.message}\n\n${err.stack || ''}`,
        });
      }
    } catch (notifyErr) {
      console.error('[Sync] SendGrid notification failed:', notifyErr.message);
    }

    process.exit(1);
  });
}
