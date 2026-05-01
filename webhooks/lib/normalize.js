/**
 * Shopify REST → Supabase row normalizers
 *
 * Shopify webhook payloads use REST format (snake_case, numeric IDs).
 * The sync pipeline stores data in Supabase with specific column names.
 * These functions normalize REST payloads directly to Supabase row shapes,
 * matching the upsert logic in syncAll.js and syncProducts.js.
 */

// ---------------------------------------------------------------------------
// Helpers (mirror syncAll.js helpers)
// ---------------------------------------------------------------------------

function toGid(type, numericId) {
  if (!numericId) return null;
  const s = String(numericId);
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/${type}/${s}`;
}

function formatAddress(addr) {
  if (!addr) return null;
  return {
    firstName: addr.first_name || null,
    lastName: addr.last_name || null,
    address1: addr.address1 || null,
    address2: addr.address2 || null,
    city: addr.city || null,
    province: addr.province || null,
    provinceCode: addr.province_code || null,
    country: addr.country || null,
    countryCode: addr.country_code || null,
    zip: addr.zip || null,
    phone: addr.phone || null,
    company: addr.company || null,
  };
}

// ---------------------------------------------------------------------------
// Order normalizer: REST webhook payload → orders table row
// ---------------------------------------------------------------------------

function normalizeOrderRow(o) {
  const customerEmail = o.customer?.email?.toLowerCase().trim() || o.email?.toLowerCase().trim() || null;
  const orderNumber = o.order_number || parseInt(String(o.name).replace(/\D/g, ''), 10);

  // Build fulfillments array
  const fulfillments = (o.fulfillments || []).map(f => ({
    status: f.status?.toUpperCase() || null,
    createdAt: f.created_at || null,
    deliveredAt: null, // REST doesn't include deliveredAt
    trackingNumber: f.tracking_number || f.tracking_numbers?.[0] || null,
    trackingUrl: f.tracking_url || f.tracking_urls?.[0] || null,
    locationId: f.location_id ? String(f.location_id) : null,
  }));

  // Earliest fulfillment date
  const fulfilledAt = fulfillments.length
    ? fulfillments.reduce((earliest, f) => {
        if (!f.createdAt) return earliest;
        return !earliest || f.createdAt < earliest ? f.createdAt : earliest;
      }, null)
    : null;

  // Build discount applications array
  const discountApps = (o.discount_applications || []).map(da => ({
    title: da.code || da.title || null,
    allocationMethod: da.allocation_method?.toUpperCase() || null,
    targetType: da.target_type?.toUpperCase() || null,
    value: da.value_type === 'percentage'
      ? { type: 'percentage', value: parseFloat(da.value) }
      : { type: 'fixed', amount: da.value, currency: o.currency },
  }));

  // Map fulfillment_status to Shopify GraphQL enum
  const fulfillmentStatusMap = {
    fulfilled: 'FULFILLED',
    partial: 'PARTIALLY_FULFILLED',
    unfulfilled: 'UNFULFILLED',
    restocked: 'RESTOCKED',
    null: 'UNFULFILLED',
  };

  // Map financial_status to Shopify GraphQL enum
  const financialStatusMap = {
    paid: 'PAID',
    partially_paid: 'PARTIALLY_PAID',
    pending: 'PENDING',
    refunded: 'REFUNDED',
    partially_refunded: 'PARTIALLY_REFUNDED',
    authorized: 'AUTHORIZED',
    voided: 'VOIDED',
    expired: 'EXPIRED',
  };

  // Compute total refunded from refunds array
  let totalRefunded = 0;
  for (const r of (o.refunds || [])) {
    for (const t of (r.transactions || [])) {
      if (t.kind === 'refund' && t.status === 'success') {
        totalRefunded += parseFloat(t.amount || 0);
      }
    }
  }

  // Compute current total price
  const totalPrice = parseFloat(o.total_price || 0);
  const currentTotalPrice = totalPrice - totalRefunded;

  const orderRow = {
    shopify_order_id: toGid('Order', o.id),
    order_number: orderNumber,
    customer_email: customerEmail,

    created_at: o.created_at,
    updated_at: o.updated_at,
    cancelled_at: o.cancelled_at || null,
    closed_at: o.closed_at || null,
    fulfilled_at: fulfilledAt,

    fulfillment_status: fulfillmentStatusMap[o.fulfillment_status] || 'UNFULFILLED',
    financial_status: financialStatusMap[o.financial_status] || null,

    // Shop currency (REST uses shop currency by default)
    shop_currency: o.currency || null,
    total_price: totalPrice,
    subtotal_price: parseFloat(o.subtotal_price || 0),
    total_shipping: parseFloat(o.total_shipping_price_set?.shop_money?.amount || o.shipping_lines?.reduce((s, l) => s + parseFloat(l.price || 0), 0) || 0),
    total_tax: parseFloat(o.total_tax || 0),
    total_discounts: parseFloat(o.total_discounts || 0),
    total_refunded: totalRefunded || null,
    current_total_price: currentTotalPrice,

    // Presentment currency
    presentment_currency: o.presentment_currency || o.total_price_set?.presentment_money?.currency_code || null,
    presentment_total_price: parseFloat(o.total_price_set?.presentment_money?.amount || o.total_price || 0),
    presentment_subtotal_price: parseFloat(o.subtotal_price_set?.presentment_money?.amount || o.subtotal_price || 0),
    presentment_total_shipping: parseFloat(o.total_shipping_price_set?.presentment_money?.amount || 0),
    presentment_total_tax: parseFloat(o.total_tax_set?.presentment_money?.amount || o.total_tax || 0),
    presentment_total_discounts: parseFloat(o.total_discounts_set?.presentment_money?.amount || o.total_discounts || 0),
    presentment_total_refunded: null, // Would need to compute from refund transactions
    presentment_current_total_price: null,

    shipping_address: formatAddress(o.shipping_address),
    billing_address: formatAddress(o.billing_address),

    discount_codes: o.discount_codes?.length ? o.discount_codes.map(dc => dc.code || dc) : null,
    discount_applications: discountApps.length ? discountApps : null,
    fulfillments: fulfillments.length ? fulfillments : null,

    note: o.note || null,
    tags: o.tags ? (typeof o.tags === 'string' ? o.tags.split(',').map(t => t.trim()).filter(Boolean) : o.tags) : null,
    source_name: o.source_name || null,

    synced_at: new Date().toISOString(),
  };

  return orderRow;
}

// ---------------------------------------------------------------------------
// Line items normalizer: REST webhook payload → order_line_items rows
// ---------------------------------------------------------------------------

function normalizeLineItemRows(o) {
  const shopifyOrderId = toGid('Order', o.id);

  // Build refunded quantity map from refunds
  const refundedBySkuVariant = {};
  for (const r of (o.refunds || [])) {
    for (const rli of (r.refund_line_items || [])) {
      const li = rli.line_item || {};
      const key = `${li.sku || ''}::${li.variant_title || ''}`;
      refundedBySkuVariant[key] = (refundedBySkuVariant[key] || 0) + (rli.quantity || 0);
    }
  }

  return (o.line_items || []).map(li => {
    // Discount allocations
    let totalDiscount = 0;
    let presentmentTotalDiscount = 0;
    const allocations = (li.discount_allocations || []).map(da => {
      const shopAmt = parseFloat(da.amount || 0);
      const presAmt = parseFloat(da.amount_set?.presentment_money?.amount || da.amount || 0);
      totalDiscount += shopAmt;
      presentmentTotalDiscount += presAmt;
      return {
        amount: shopAmt,
        presentmentAmount: presAmt,
        discountApplication: {
          allocationMethod: da.discount_application?.allocation_method?.toUpperCase() || null,
          targetType: da.discount_application?.target_type?.toUpperCase() || null,
          value: da.discount_application?.value || null,
        },
      };
    });

    const refundKey = `${li.sku || ''}::${li.variant_title || ''}`;
    const refundedQty = refundedBySkuVariant[refundKey] || 0;

    return {
      shopify_order_id: shopifyOrderId,
      shopify_line_item_id: li.id ? toGid('LineItem', li.id) : null,
      shopify_variant_id: li.variant_id ? toGid('ProductVariant', li.variant_id) : null,
      title: li.title,
      variant_title: li.variant_title || null,
      sku: li.sku || null,
      quantity: li.quantity,

      unit_price: parseFloat(li.price || 0),
      unit_price_currency: o.currency || null,
      presentment_unit_price: parseFloat(li.price_set?.presentment_money?.amount || li.price || 0),
      presentment_unit_price_currency: li.price_set?.presentment_money?.currency_code || null,

      total_discount: totalDiscount || null,
      presentment_total_discount: presentmentTotalDiscount || null,
      discount_allocations: allocations.length ? allocations : null,

      refunded_quantity: refundedQty,

      // REST `properties` is the customAttributes equivalent. Stored under
      // the same column name + shape as the GraphQL sync writes.
      custom_attributes: (li.properties && li.properties.length)
        ? li.properties.map(p => ({ key: p.name, value: p.value }))
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Customer normalizer: REST webhook payload → customers table row (minimal)
// ---------------------------------------------------------------------------

function normalizeCustomerRow(c) {
  return {
    email: c.email?.toLowerCase().trim(),
    shopify_customer_id: toGid('Customer', c.id),
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    phone: c.phone || null,
    default_address: c.default_address ? formatAddress(c.default_address) : null,
    total_orders: c.orders_count || 0,
    total_spent: c.total_spent ? parseFloat(c.total_spent) : null,
    total_spent_currency: c.currency || null,
    tags: c.tags ? (typeof c.tags === 'string' ? c.tags.split(',').map(t => t.trim()).filter(Boolean) : c.tags) : null,
    note: c.note || null,
    customer_created_at: c.created_at,
    shopify_synced_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Product normalizer: REST webhook payload → products table row (basic)
// Note: Metafields not included in REST webhooks — fetched separately
// ---------------------------------------------------------------------------

function normalizeProductRow(p) {
  return {
    shopify_product_id: toGid('Product', p.id),
    title: p.title,
    handle: p.handle,
    status: p.status?.toUpperCase() || 'ACTIVE',
    product_type: p.product_type || null,
    vendor: p.vendor || null,
    description_html: p.body_html || null,
    tags: p.tags ? (typeof p.tags === 'string' ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : p.tags) : [],
    synced_at: new Date().toISOString(),
  };
}

function normalizeVariantRow(v, productId) {
  return {
    shopify_variant_id: toGid('ProductVariant', v.id),
    shopify_product_id: toGid('Product', productId),
    shopify_inventory_item_id: v.inventory_item_id ? toGid('InventoryItem', v.inventory_item_id) : null,
    title: v.title,
    sku: v.sku || null,
    price: parseFloat(v.price) || 0,
    inventory_quantity: v.inventory_quantity ?? 0,
    selected_options: (v.option1 || v.option2 || v.option3)
      ? [
          v.option1 ? { name: 'Option 1', value: v.option1 } : null,
          v.option2 ? { name: 'Option 2', value: v.option2 } : null,
          v.option3 ? { name: 'Option 3', value: v.option3 } : null,
        ].filter(Boolean)
      : [],
    synced_at: new Date().toISOString(),
  };
}

module.exports = {
  toGid,
  normalizeOrderRow,
  normalizeLineItemRows,
  normalizeCustomerRow,
  normalizeProductRow,
  normalizeVariantRow,
};
