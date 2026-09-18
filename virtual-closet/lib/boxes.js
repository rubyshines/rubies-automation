'use strict';
const { db, must, logEvent } = require('./db');
const money = require('./money');
const { MENU } = require('./catalog');

async function getOpenBox(centreId, { create = false, goalCents } = {}) {
  const box = must(await db().from('vc_boxes').select('*').eq('centre_id', centreId).eq('status', 'open').maybeSingle(), 'open box');
  if (box || !create) return box;
  return openNextBox(centreId, { goalCents });
}

async function openNextBox(centreId, { goalCents, carryInCents = 0, actor = 'system' } = {}) {
  const last = must(await db().from('vc_boxes').select('number').eq('centre_id', centreId).order('number', { ascending: false }).limit(1).maybeSingle(), 'last box');
  const number = (last?.number || 0) + 1;
  const box = must(await db().from('vc_boxes').insert({
    centre_id: centreId, number, status: 'open', goal_cents: Math.max(money.MIN_GOAL_CENTS, goalCents || money.MIN_GOAL_CENTS),
  }).select('*').single(), 'open box');
  if (carryInCents > 0) {
    must(await db().from('vc_ledger').insert({
      centre_id: centreId, box_id: box.id, kind: 'carry_in', amount_cents: carryInCents,
      source_type: 'box', source_id: `carry-${centreId}-${number}`, detail: { from_box: number - 1 },
    }), 'carry in');
  }
  await logEvent(centreId, actor, 'box.opened', { number });
  return box;
}

async function getBox(id) {
  return must(await db().from('vc_boxes').select('*').eq('id', id).maybeSingle(), 'box');
}
async function getBoxByNumber(centreId, number) {
  return must(await db().from('vc_boxes').select('*').eq('centre_id', centreId).eq('number', number).maybeSingle(), 'box by number');
}
async function listBoxes(centreId) {
  return must(await db().from('vc_boxes').select('*').eq('centre_id', centreId).order('number', { ascending: false }), 'boxes');
}
async function ledgerFor(boxId) {
  return must(await db().from('vc_ledger').select('*').eq('box_id', boxId).order('created_at'), 'ledger');
}
async function requestsFor(boxId) {
  return must(await db().from('vc_requests').select('*').eq('box_id', boxId).order('created_at'), 'box requests');
}

const APPROVED = new Set(['approved', 'in_box', 'shipped', 'ready', 'collected']);

/**
 * Everything a page needs to draw a box: raised, goal, funded, sources, request counts.
 * Goal is the larger of the centre's target and what approved requests cost.
 */
async function summary(centre, box) {
  if (!box) {
    return { box: null, number: 1, raised: 0, goal: centre.goal_cents, funded: false, over: 0, sources: money.sourcesCents([]), requests: [], approvedCount: 0, waitingCount: 0, state: 'empty', ledger: [] };
  }
  const [ledger, requests, waiting] = await Promise.all([
    ledgerFor(box.id),
    requestsFor(box.id),
    must(await db().from('vc_requests').select('id').eq('centre_id', centre.id).eq('status', 'waiting'), 'waiting'),
  ]);
  const approved = requests.filter(r => APPROVED.has(r.status));
  const raised = money.raisedCents(ledger);
  const goal = money.boxGoalCents(box.goal_cents, approved, MENU);
  const funded = raised >= goal;
  let state = 'in_progress';
  if (box.status !== 'open') state = box.status;               // sent | shipped | delivered
  else if (raised === 0 && !approved.length) state = 'empty';
  else if (funded) state = raised > goal ? 'over' : 'funded';
  else if (goal > box.goal_cents) state = 'grown';
  return {
    box, number: box.number, raised, goal, funded, over: Math.max(0, raised - goal),
    sources: money.sourcesCents(ledger), requests, approvedCount: approved.length,
    waitingCount: waiting.length, state, ledger,
  };
}

/** The previous sent box, for the "arrived on [date] with N items" line. */
async function lastSentBox(centreId) {
  return must(await db().from('vc_boxes').select('*').eq('centre_id', centreId).neq('status', 'open').order('number', { ascending: false }).limit(1).maybeSingle(), 'last sent box');
}

/**
 * What "Send the box" needs to show: fixed requested items, the product
 * budget left to fill, a default auto-fill plan, and the totals.
 */
async function sendPreview(centre, box, { fillMode = 'auto', plan = null } = {}) {
  const sum = await summary(centre, box);
  const approved = sum.requests.filter(r => APPROVED.has(r.status));
  const shipped = approved.filter(r => r.delivery === 'ship');
  const requestedCents = approved.reduce((s, r) => s + money.requestCostCents(r.items, 'pickup', MENU), 0);
  const base = money.sendTotals({ raised: sum.raised, shippedRequestCount: shipped.length, placedProductCents: requestedCents });
  const remainingBudget = Math.max(0, base.productBudget - requestedCents);
  const autoPlan = money.autoFill({ budgetCents: remainingBudget, sizes: centre.sizes, catalog: MENU });
  const usePlan = fillMode === 'chosen' && plan ? plan : autoPlan;
  const planCents = money.planValueCents(usePlan, MENU);
  const totals = money.sendTotals({ raised: sum.raised, shippedRequestCount: shipped.length, placedProductCents: requestedCents + planCents });
  const requestedItems = approved.reduce((n, r) => n + (r.items || []).length, 0);
  const fillItems = usePlan.reduce((n, l) => n + l.qty, 0);
  return { sum, approved, shipped, requestedCents, remainingBudget, autoPlan, plan: usePlan, planCents, totals, itemsCount: requestedItems + fillItems, overBudget: planCents > remainingBudget };
}

/**
 * Send the box: close it, write match / door shipping / carry-out, move
 * approved requests into it, open the next box with the carry-over and the
 * waiting requests. Returns { box, nextBox, requests }.
 */
async function sendBox(centre, box, { fillMode, plan, pickupNote, deliveryNote, actor = 'system', rememberNotes = true }) {
  if (box.status !== 'open') throw new Error('This box has already been sent.');
  const preview = await sendPreview(centre, box, { fillMode, plan });
  if (!preview.sum.funded) throw new Error('The box is not funded yet.');
  if (preview.overBudget) throw new Error('The items chosen cost more than the box holds.');
  const now = new Date().toISOString();
  const t = preview.totals;
  const ledgerRows = [
    { centre_id: centre.id, box_id: box.id, kind: 'match', amount_cents: t.match, source_type: 'box', source_id: `match-${box.id}` },
  ];
  if (t.doorShipping) ledgerRows.push({ centre_id: centre.id, box_id: box.id, kind: 'door_shipping', amount_cents: -t.doorShipping, source_type: 'box', source_id: `door-${box.id}`, detail: { packages: preview.shipped.length } });
  if (t.carryOut) ledgerRows.push({ centre_id: centre.id, box_id: box.id, kind: 'carry_out', amount_cents: -t.carryOut, source_type: 'box', source_id: `carry-out-${box.id}` });
  must(await db().from('vc_ledger').upsert(ledgerRows, { onConflict: 'kind,source_type,source_id', ignoreDuplicates: true }), 'send ledger');
  must(await db().from('vc_boxes').update({
    status: 'sent', sent_at: now, fill_mode: fillMode === 'chosen' ? 'chosen' : 'auto', fill_plan: preview.plan,
    pickup_note: pickupNote || null, delivery_note: deliveryNote || null, items_count: preview.itemsCount,
  }).eq('id', box.id), 'send box');
  const ids = preview.approved.map(r => r.id);
  if (ids.length) must(await db().from('vc_requests').update({ status: 'in_box', updated_at: now }).in('id', ids), 'requests in box');
  if (rememberNotes) must(await db().from('vc_centres').update({ pickup_note: pickupNote || null, delivery_note: deliveryNote || null }).eq('id', centre.id), 'remember notes');
  const nextBox = await openNextBox(centre.id, { goalCents: centre.goal_cents, carryInCents: t.carryOut, actor });
  // Waiting requests join the new box, in order.
  const waiting = must(await db().from('vc_requests').select('id').eq('centre_id', centre.id).eq('status', 'waiting').order('created_at'), 'waiting');
  if (waiting.length) must(await db().from('vc_requests').update({ status: 'approved', box_id: nextBox.id, updated_at: now }).in('id', waiting.map(w => w.id)), 'move waiting');
  await logEvent(centre.id, actor, 'box.sent', { number: box.number, items: preview.itemsCount, raised: t.raised, match: t.match, carry_out: t.carryOut });
  return { box: { ...box, status: 'sent', sent_at: now, items_count: preview.itemsCount }, nextBox, requests: preview.approved, totals: t, plan: preview.plan };
}

/** Operator: RUBIES shipped it. Requesters shipped to a door are marked shipped. */
async function markShipped(box, { carrier, tracking, actor }) {
  const now = new Date().toISOString();
  must(await db().from('vc_boxes').update({ status: 'shipped', shipped_at: now, carrier: carrier || null, tracking_number: tracking || null }).eq('id', box.id), 'mark shipped');
  must(await db().from('vc_requests').update({ status: 'shipped', updated_at: now }).eq('box_id', box.id).eq('status', 'in_box').eq('delivery', 'ship'), 'ship requests');
  await logEvent(box.centre_id, actor, 'box.shipped', { number: box.number, carrier, tracking });
  return { ...box, status: 'shipped', shipped_at: now, carrier, tracking_number: tracking };
}

/** Carrier reports delivery: pickups become ready. */
async function markDelivered(box, { actor }) {
  const now = new Date().toISOString();
  must(await db().from('vc_boxes').update({ status: 'delivered', delivered_at: now }).eq('id', box.id), 'mark delivered');
  const pickups = must(await db().from('vc_requests').select('*').eq('box_id', box.id).eq('delivery', 'pickup').in('status', ['in_box', 'shipped']), 'pickups');
  if (pickups.length) must(await db().from('vc_requests').update({ status: 'ready', updated_at: now }).in('id', pickups.map(p => p.id)), 'ready');
  await logEvent(box.centre_id, actor, 'box.delivered', { number: box.number, pickups: pickups.length });
  return { box: { ...box, status: 'delivered', delivered_at: now }, pickups };
}

module.exports = { getOpenBox, openNextBox, getBox, getBoxByNumber, listBoxes, ledgerFor, requestsFor, summary, lastSentBox, sendPreview, sendBox, markShipped, markDelivered, APPROVED };
