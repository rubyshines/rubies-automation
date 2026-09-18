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
      source_type: 'box', source_id: `carry-${number}`, detail: { from_box: number - 1 },
    }), 'carry in');
  }
  await logEvent(centreId, actor, 'box.opened', { number });
  return box;
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
    return { box: null, number: 1, raised: 0, goal: centre.goal_cents, funded: false, sources: money.sourcesCents([]), requests: [], approvedCount: 0, waitingCount: 0, state: 'empty', ledger: [] };
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

module.exports = { getOpenBox, openNextBox, listBoxes, ledgerFor, requestsFor, summary, lastSentBox, APPROVED };
