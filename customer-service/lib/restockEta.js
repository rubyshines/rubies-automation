/**
 * restockEta.js — soonest dated inbound for a set of SKUs.
 *
 * "Out of stock" and "out of stock with a container arriving next week" are
 * different answers to a customer. Without this the advisor can only offer a
 * back-in-stock notification, or worse, invent a date; with it, a style whose
 * restock is days away stays recommendable. The Sassy in M is exactly that case
 * (arriving on KALI-2601) while the Naomi has no inbound at all, so the two must
 * not be reported the same way.
 *
 * IMPORTANT: `estimated_arrival_date` is arrival AT THE WAREHOUSE, not the date
 * the item can be sold. `in_inventory_date` is the sellable one, and receiving
 * plus putaway sits between them. So the ETA is returned with its basis
 * labelled, and callers must never render it to a customer as "back in stock
 * on X" without allowing for receiving.
 */

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

const OPEN_STATUSES = ['uploaded', 'in_transit', 'partially_received'];

/**
 * How soon a restock has to be SELLABLE before we suggest waiting for it.
 *
 * The customer is holding something that does not work, so the offer only makes
 * sense while waiting beats taking an alternative or a refund now. Three weeks
 * is the boundary: the Sassy arriving in about eight days is obviously worth
 * mentioning, six weeks obviously is not. Beyond the window the style is still
 * reported, with worth_offering false, so the advisor knows it exists and knows
 * not to pitch it.
 */
const RESTOCK_OFFER_WINDOW_DAYS = 21;

/**
 * @param {string[]} skus
 * @param {object} [opts]
 * @param {string} [opts.today] ISO date; injectable so tests are not clock-dependent.
 * @returns {Promise<null | {eta: string, sellable_estimate: string, basis: string,
 *   transfer_number: string, status: string, qty: number, skus: string[]}>}
 */
async function restockEtaForSkus(skus, { today } = {}) {
  const wanted = new Set((skus || []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean));
  if (!wanted.size) return null;

  const sb = getSupabaseClient();

  const items = await fetchAllPaginated(() =>
    sb.from('inbound_shipment_items').select('sku, qty, qty_received, inbound_shipment_id').order('id')
  );
  const matching = (items || []).filter(i => wanted.has(String(i.sku || '').trim().toUpperCase()));
  if (!matching.length) return null;

  const ids = [...new Set(matching.map(i => i.inbound_shipment_id))];
  const { data: ships, error } = await sb.from('inbound_shipments')
    .select('id, transfer_number, status, estimated_arrival_date, in_inventory_date')
    .in('id', ids);
  if (error) throw new Error(`restockEtaForSkus: ${error.message}`);

  const cutoff = today || new Date().toISOString().slice(0, 10);
  const candidates = [];
  for (const s of ships || []) {
    // A received shipment is already reflected in inventory; if the size still
    // reads zero, a future ETA is not the explanation.
    if (!OPEN_STATUSES.includes(s.status)) continue;
    const eta = s.estimated_arrival_date;
    if (!eta || eta < cutoff) continue;
    const qty = matching
      .filter(i => i.inbound_shipment_id === s.id)
      .reduce((sum, i) => sum + (i.qty || 0), 0);
    candidates.push({ ship: s, qty });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => String(a.ship.estimated_arrival_date).localeCompare(String(b.ship.estimated_arrival_date)));
  const { ship, qty } = candidates[0];

  const sellable = ship.in_inventory_date || addDays(ship.estimated_arrival_date, RECEIVING_BUFFER_DAYS);
  const daysUntil = daysBetween(cutoff, sellable);

  return {
    eta: ship.estimated_arrival_date,
    days_until_sellable: daysUntil,
    // The rule, decided here so every caller applies it identically rather than
    // each one re-judging "is that soon enough".
    worth_offering: daysUntil !== null && daysUntil <= RESTOCK_OFFER_WINDOW_DAYS,
    sellable_estimate: sellable,
    basis: ship.in_inventory_date
      ? 'confirmed sellable date'
      : `warehouse arrival; allow ~${RECEIVING_BUFFER_DAYS} days for receiving before it can ship`,
    transfer_number: ship.transfer_number,
    status: ship.status,
    qty,
    skus: [...new Set(matching.filter(i => i.inbound_shipment_id === ship.id).map(i => i.sku))],
  };
}

/** Receiving + putaway between arrival and sellable. Deliberately generous. */
const RECEIVING_BUFFER_DAYS = 5;

/** Whole days from `from` to `to`, or null if either is unparseable. */
function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  restockEtaForSkus, addDays, daysBetween,
  RECEIVING_BUFFER_DAYS, RESTOCK_OFFER_WINDOW_DAYS, OPEN_STATUSES,
};
