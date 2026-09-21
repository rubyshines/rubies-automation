'use strict';
/**
 * Virtual Closet money rules. Pure functions, cents everywhere.
 *
 * The rules (from .claude/plans/org-closet-programme.md "Where things stand"):
 * - A sponsored or requested item costs the box half its retail price.
 * - Shipping a request to a door costs the box $15 per package.
 * - The box goal is the larger of the centre's target and the cost of every
 *   approved request, so "everyone who asked gets theirs" stays true.
 * - RUBIES matches every dollar in the box when it ships.
 * - A community order through the centre's link credits 25% of its subtotal.
 */

const MIN_GOAL_CENTS = 30000;
// Link mode (2026-09-21): every centre has a goal the running total is drawn
// against, $1,000 unless the centre tells Jamie otherwise. Lifetime raised,
// never reset; past the goal the bar stays full.
const LINK_DEFAULT_GOAL_CENTS = 100000;
const DOOR_SHIPPING_CENTS = 1500;
const ORDER_CREDIT_RATE = 0.25;

// Ledger kinds that count toward "raised". The others are written at send.
const RAISE_KINDS = new Set(['order_credit', 'sponsor', 'centre_add', 'carry_in', 'adjustment']);

function requestCostCents(items, delivery, catalog) {
  const itemsCents = (items || []).reduce((sum, it) => {
    const style = catalog.find(s => s.key === it.style);
    return sum + (style ? style.half_cents : 0);
  }, 0);
  return itemsCents + (delivery === 'ship' ? DOOR_SHIPPING_CENTS : 0);
}

/** Goal shown for a box: the centre's target or the cost of approved requests, whichever is larger. */
function boxGoalCents(targetCents, approvedRequests, catalog) {
  const target = Math.max(MIN_GOAL_CENTS, targetCents || 0);
  const requested = (approvedRequests || []).reduce(
    (sum, r) => sum + requestCostCents(r.items, r.delivery, catalog), 0);
  return Math.max(target, requested);
}

function raisedCents(ledgerRows) {
  return (ledgerRows || []).reduce((sum, row) => RAISE_KINDS.has(row.kind) ? sum + row.amount_cents : sum, 0);
}

function sourcesCents(ledgerRows) {
  const out = { orders: 0, sponsors: 0, sponsorCount: 0, centre: 0, carry: 0, adjustment: 0 };
  for (const row of ledgerRows || []) {
    if (row.kind === 'order_credit') out.orders += row.amount_cents;
    else if (row.kind === 'sponsor') { out.sponsors += row.amount_cents; out.sponsorCount += 1; }
    else if (row.kind === 'centre_add') out.centre += row.amount_cents;
    else if (row.kind === 'carry_in') out.carry += row.amount_cents;
    else if (row.kind === 'adjustment') out.adjustment += row.amount_cents;
  }
  return out;
}

function orderCreditCents(subtotalCents) {
  return Math.round(subtotalCents * ORDER_CREDIT_RATE);
}

/**
 * What the box is worth at send: raised + match, minus door shipping for the
 * shipped requests. Product value is what the packing list must add up to;
 * anything not placed carries to the next box.
 */
function sendTotals({ raised, shippedRequestCount, placedProductCents }) {
  const match = raised;
  const doorShipping = shippedRequestCount * DOOR_SHIPPING_CENTS;
  const productBudget = raised + match - doorShipping;
  const carryOut = Math.max(0, productBudget - (placedProductCents || 0));
  return { raised, match, doorShipping, productBudget, placedProductCents: placedProductCents || 0, carryOut };
}

/**
 * "Let it fill itself": spread the remaining product budget across the
 * centre's sizes and the menu styles, cheapest-first so the count is honest.
 * Returns [{style, size, qty}] whose value never exceeds the budget.
 */
function autoFill({ budgetCents, sizes, catalog }) {
  const plan = [];
  if (!budgetCents || !sizes?.length || !catalog?.length) return plan;
  // Weight underwear heavier than bras and bikini bottoms: closets ask for
  // underwear most. Underwear styles get two passes per size, others one.
  const styles = catalog.map(s => ({ ...s, weight: s.kind === 'underwear' ? 2 : 1 }));
  let remaining = budgetCents;
  let progress = true;
  const counts = new Map();
  while (progress) {
    progress = false;
    for (const style of styles) {
      for (let w = 0; w < style.weight; w++) {
        for (const size of sizes) {
          if (remaining < style.half_cents) continue;
          remaining -= style.half_cents;
          const k = `${style.key}|${size}`;
          counts.set(k, (counts.get(k) || 0) + 1);
          progress = true;
        }
      }
    }
  }
  for (const [k, qty] of counts) {
    const [style, size] = k.split('|');
    plan.push({ style, size, qty });
  }
  return plan;
}

function planValueCents(plan, catalog) {
  return (plan || []).reduce((sum, line) => {
    const style = catalog.find(s => s.key === line.style);
    return sum + (style ? style.half_cents * (line.qty || 0) : 0);
  }, 0);
}

function dollars(cents) {
  const n = Math.round(cents || 0) / 100;
  return Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = {
  MIN_GOAL_CENTS, LINK_DEFAULT_GOAL_CENTS, DOOR_SHIPPING_CENTS, ORDER_CREDIT_RATE, RAISE_KINDS,
  requestCostCents, boxGoalCents, raisedCents, sourcesCents, orderCreditCents,
  sendTotals, autoFill, planValueCents, dollars,
};
