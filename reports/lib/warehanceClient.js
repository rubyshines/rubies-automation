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
 * Pick the Warehance shipping method for a destination zone + speed from a
 * method list. Single source of truth for the routing rule (was duplicated
 * between orderNotes' hardcoded ID tables and editOrder's name matcher, with
 * divergent strategies):
 *   US:                 US Standard / US Expedited
 *   Non-US expedited:   Fedex (regardless of zone)
 *   Non-US standard:    Passport DDP (canada / ddp zone) or Passport DDU
 * Matches by name so recreated/renamed methods can't strand stale IDs (the
 * 2026-04-30 stale-ID incident). Pure — unit-tested.
 *
 * @param {Array<{id, name}>} methods — from fetchShippingMethods()
 * @param {'us'|'canada'|'ddp'|'ddu'|null} zone — from getShippingZone()
 * @param {'standard'|'expedited'} speed
 * @returns {{id, name}|null}
 */
function pickShippingMethod(methods, zone, speed) {
  const nm = m => (m.name || m.title || '').toLowerCase();
  const byName = pred => (methods || []).find(m => pred(nm(m))) || null;
  const expedited = speed === 'expedited';

  if (zone === 'us') {
    return expedited
      ? byName(n => /\bus\b/.test(n) && n.includes('expedited'))
      : byName(n => /\bus\b/.test(n) && n.includes('standard'));
  }
  if (expedited) return byName(n => n.includes('fedex'));
  return (zone === 'ddp' || zone === 'canada')
    ? byName(n => n.includes('ddp'))
    : byName(n => n.includes('ddu'));
}

/**
 * Resolve the Warehance shipping method for a zone + speed against the LIVE
 * method list. Returns { id, name } or null when nothing matches.
 */
async function resolveShippingMethod({ zone, speed }) {
  const methods = await fetchShippingMethods();
  return pickShippingMethod(methods, zone, speed);
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
 * Generic POST to the Warehance API.
 */
async function apiPost(path, body) {
  if (!API_KEY) throw new Error('WAREHANCE_API_KEY not set');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Warehance POST ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

// -------------------------------------------------------------------------
// Inbound shipments (ASN / receiving)
// -------------------------------------------------------------------------

/**
 * Fetch the configured warehouses. Returns array of { id, name, ... }.
 */
async function fetchWarehouses() {
  const json = await apiFetch('/warehouses');
  return json.data?.warehouses || json.warehouses || json.data || [];
}

/**
 * Resolve a warehouse id by name. Honors WAREHANCE_WAREHOUSE_ID as an override so a
 * live run never depends on a name-match. Throws if it can't resolve one.
 */
async function resolveWarehouseId(name) {
  if (process.env.WAREHANCE_WAREHOUSE_ID) return Number(process.env.WAREHANCE_WAREHOUSE_ID);
  const warehouses = await fetchWarehouses();
  if (name) {
    const hit = warehouses.find((w) => String(w.name).toLowerCase() === String(name).toLowerCase());
    if (hit) return hit.id;
  }
  if (warehouses.length === 1) return warehouses[0].id;
  throw new Error(`Could not resolve a Warehance warehouse_id for "${name}" — set WAREHANCE_WAREHOUSE_ID or pass an exact warehouse name. Available: ${warehouses.map((w) => w.name).join(', ')}`);
}

/**
 * Create an inbound shipment (ASN). Items key on Warehance product_id, not SKU.
 * @param {object} p
 * @param {number} p.warehouseId
 * @param {{product_id:number, ordered:number}[]} p.items
 * @param {string} [p.referenceNumber]
 * @param {string} [p.trackingNumber]
 * @param {string} [p.trackingUrl]
 * @param {string} [p.shipDate] - ISO 8601
 * @param {string} [p.expectedDate] - ISO 8601
 * @param {number} [p.clientId] - required for organization-level API keys
 * @returns {Promise<{id:number}>} the created shipment id
 */
async function createInboundShipment({ warehouseId, items, referenceNumber, trackingNumber, trackingUrl, shipDate, expectedDate, clientId }) {
  const body = { warehouse_id: warehouseId, items };
  if (referenceNumber) body.reference_number = referenceNumber;
  if (trackingNumber) body.tracking_number = trackingNumber;
  if (trackingUrl) body.tracking_url = trackingUrl;
  if (shipDate) body.ship_date = shipDate;
  if (expectedDate) body.expected_date = expectedDate;
  if (clientId != null) body.client_id = clientId;
  const json = await apiPost('/inbound-shipments', body);
  return json.data || json;
}

/**
 * Update an existing inbound shipment (ASN) in place.
 *
 * IMPORTANT: Warehance's PATCH covers only the shipment HEADER — reference_number,
 * expected_date, ship_date, tracking_number, tracking_url, status, closed, closed_date,
 * warehouse_notes, internal_notes, tags. **Line items cannot be changed after creation,
 * and there is no DELETE endpoint.** So correcting what is ON a shipment means closing
 * the old ASN (`{closed: true}`) and posting a replacement.
 *
 * @param {string|number} id - the Warehance inbound shipment id
 * @param {object} patch - any subset of the header fields above
 */
async function updateInboundShipment(id, patch) {
  if (!id) throw new Error('updateInboundShipment: id is required');
  const json = await apiPatch(`/inbound-shipments/${id}`, patch);
  return json.data || json;
}

/**
 * List inbound shipments, optionally filtered by a search term (e.g. reference number).
 */
async function listInboundShipments({ searchValue, limit = 100 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (searchValue) params.set('search_value', searchValue);
  const json = await apiFetch(`/inbound-shipments?${params}`);
  const data = json.data || json;
  return data.inbound_shipments || [];
}

/**
 * Find a single inbound shipment by exact reference number (the production code we set
 * at creation). Returns the shipment object (with per-item received/rejected) or null.
 */
async function fetchInboundShipmentByReference(referenceNumber) {
  const list = await listInboundShipments({ searchValue: referenceNumber });
  return list.find((s) => String(s.reference_number) === String(referenceNumber)) || null;
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
  apiPost,
  fetchWarehouses,
  resolveWarehouseId,
  createInboundShipment,
  updateInboundShipment,
  listInboundShipments,
  fetchInboundShipmentByReference,
  fetchUnfulfilledOrders,
  fetchOrderByNumber,
  getHoldReasons,
  releaseAddressHold,
  setWarehouseHold,
  releaseWarehouseHold,
  fetchShippingMethods,
  updateShippingMethod,
  pickShippingMethod,
  resolveShippingMethod,
  cancelOrder,
  warehanceOrderUrl,
  fetchSkuStock,
  fetchSkuStockMany,
};
