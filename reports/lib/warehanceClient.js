/**
 * Warehance (Nitro) API client — shared across reports and finance.
 *
 * Auth: X-API-KEY header. Base URL defaults to staging.
 * Docs: https://developer.warehance.com/reference
 */

const API_KEY = process.env.WAREHANCE_API_KEY;
const BASE = process.env.WAREHANCE_API_URL || 'https://api.staging.warehance.com/v1';

async function apiFetch(path) {
  if (!API_KEY) throw new Error('WAREHANCE_API_KEY not set');
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-API-KEY': API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Warehance API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Fetch all unfulfilled/in-progress orders from Warehance.
 * Paginates automatically (100 per page).
 * Returns a Map keyed by order_number (string) for easy lookup.
 */
async function fetchUnfulfilledOrders() {
  const orders = new Map();
  let cursor = null;
  let page = 0;

  while (true) {
    const params = new URLSearchParams({
      fulfillment_statuses: 'unfulfilled,partially_fulfilled,in_progress',
      limit: '100',
      sort_by: 'created_at',
      order_by: 'desc',
    });
    if (cursor) params.set('cursor', cursor);

    const json = await apiFetch(`/orders?${params}`);
    const data = json.data || json;
    const batch = data.orders || [];

    for (const o of batch) {
      // order_number comes as string from Warehance (e.g. "#24501" or "24501")
      const num = String(o.order_number).replace('#', '');
      orders.set(num, o);
    }

    page++;
    if (!data.has_next_page || !data.next_cursor || page > 20) break;
    cursor = data.next_cursor;
  }

  return orders;
}

/**
 * Fetch a single order by order number.
 */
async function fetchOrderByNumber(orderNumber) {
  const json = await apiFetch(`/orders?order_number=${encodeURIComponent(orderNumber)}&limit=1`);
  const data = json.data || json;
  const orders = data.orders || [];
  return orders[0] || null;
}

/**
 * Extract hold reasons from a Warehance order object.
 * Returns array of hold type strings (e.g. ['address_hold', 'fraud_hold']).
 */
function getHoldReasons(whOrder) {
  if (!whOrder || !whOrder.has_hold) return [];
  const holds = [];
  if (whOrder.address_hold) holds.push('address_hold');
  if (whOrder.fraud_hold) holds.push('fraud_hold');
  if (whOrder.payment_hold) holds.push('payment_hold');
  if (whOrder.warehouse_hold) holds.push('warehouse_hold');
  if (whOrder.allocation_hold) holds.push('allocation_hold');
  if (whOrder.store_hold) holds.push('store_hold');
  return holds;
}

/**
 * PATCH a Warehance order (update holds, notes, etc.)
 */
async function apiPatch(path, body) {
  if (!API_KEY) throw new Error('WAREHANCE_API_KEY not set');
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'X-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Warehance PATCH ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Release the address hold on a Warehance order.
 */
async function releaseAddressHold(warehanceOrderId) {
  return apiPatch(`/orders/${warehanceOrderId}`, { address_hold: false });
}

/**
 * Place a warehouse hold on a Warehance order (prevents fulfillment).
 */
async function setWarehouseHold(warehanceOrderId) {
  return apiPatch(`/orders/${warehanceOrderId}`, { warehouse_hold: true });
}

/**
 * Release the warehouse hold on a Warehance order.
 */
async function releaseWarehouseHold(warehanceOrderId) {
  return apiPatch(`/orders/${warehanceOrderId}`, { warehouse_hold: false });
}

/**
 * Fetch all shipping methods configured in Warehance.
 * Returns array of { id, name, ... } objects.
 */
async function fetchShippingMethods() {
  const json = await apiFetch('/shipping-methods');
  return json.data?.shipping_methods || json.shipping_methods || json.data || [];
}

/**
 * Update the shipping method on a Warehance order.
 * @param {number|string} warehanceOrderId
 * @param {number} shippingMethodId — ID from /shipping-methods endpoint
 */
async function updateShippingMethod(warehanceOrderId, shippingMethodId) {
  return apiPatch(`/orders/${warehanceOrderId}`, { shipping_method_id: shippingMethodId });
}

/**
 * Cancel an order in Warehance (e.g., already fulfilled in Shopify, nothing to ship).
 */
async function cancelOrder(warehanceOrderId) {
  if (!API_KEY) throw new Error('WAREHANCE_API_KEY not set');
  const res = await fetch(`${BASE}/orders/${warehanceOrderId}/cancel`, {
    method: 'POST',
    headers: {
      'X-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Warehance cancel ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Build a Warehance admin URL for an order.
 */
function warehanceOrderUrl(whOrder) {
  if (!whOrder?.id) return null;
  return `https://staging.warehance.com/orders/${whOrder.id}?orderId=${whOrder.id}`;
}

/**
 * Fetch the live Warehance product/stock record for a single SKU.
 * Returns the product object (with on_hand / allocated / available / backordered)
 * or null if the SKU isn't found.
 */
async function fetchSkuStock(sku) {
  if (!sku) return null;
  const json = await apiFetch(`/products?search_value=${encodeURIComponent(sku)}`);
  const products = json.data?.products || [];
  return products.find(p => p.sku === sku) || null;
}

/**
 * Bulk variant of fetchSkuStock. Returns a Map keyed by SKU.
 */
async function fetchSkuStockMany(skus) {
  const unique = [...new Set((skus || []).filter(Boolean))];
  const results = await Promise.all(unique.map(fetchSkuStock));
  const map = new Map();
  unique.forEach((sku, i) => map.set(sku, results[i]));
  return map;
}

module.exports = {
  apiFetch,
  apiPatch,
  fetchUnfulfilledOrders,
  fetchOrderByNumber,
  getHoldReasons,
  releaseAddressHold,
  setWarehouseHold,
  releaseWarehouseHold,
  fetchShippingMethods,
  updateShippingMethod,
  cancelOrder,
  warehanceOrderUrl,
  fetchSkuStock,
  fetchSkuStockMany,
};
