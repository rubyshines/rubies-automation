'use strict';
/**
 * Free-pair requests: create, verify by email, approve (automatically within
 * the centre's limits, or by hand), decline, limits per email per year, and
 * which box a request lands in.
 */
const { db, must, logEvent } = require('./db');
const { MENU, styleByKey, normalizeSize } = require('./catalog');
const money = require('./money');
const boxes = require('./boxes');

const normEmail = e => String(e || '').trim().toLowerCase();

function describeItems(items) {
  return (items || []).map(i => ({ ...i, styleName: styleByKey(i.style)?.name || i.style }));
}

/** Validate what the form sent against the centre's settings. Returns { items, errors }. */
function cleanItems(raw, centre) {
  const errors = [];
  const items = [];
  const sizes = new Set([...(centre.sizes || []), ...(centre.kids_sizes ? require('./catalog').KIDS_SIZES : [])]);
  for (const it of raw || []) {
    if (!it || !it.style) continue;
    const style = styleByKey(it.style);
    if (!style) { errors.push('Pick a style from the list.'); continue; }
    const size = normalizeSize(it.size);
    if (!size || !sizes.has(size)) { errors.push(`${style.name}: pick a size ${centre.name} offers.`); continue; }
    const colour = String(it.colour || '').trim();
    if (!colour) { errors.push(`${style.name}: pick a colour.`); continue; }
    items.push({ style: style.key, colour, size });
  }
  if (!items.length) errors.push('Add at least one item.');
  if (items.length > centre.items_per_request) errors.push(`Up to ${centre.items_per_request} items per request at ${centre.name}.`);
  return { items, errors };
}

/** Requests from this email at this centre in the last 365 days that count toward the limit. */
async function yearlyCount(centreId, email) {
  const since = new Date(Date.now() - 365 * 86400000).toISOString();
  const rows = must(await db().from('vc_requests').select('id, status, decline_counts, created_at').eq('centre_id', centreId).eq('email', normEmail(email)).gte('created_at', since), 'yearly count');
  const counted = rows.filter(r => !['unverified', 'cancelled', 'ended'].includes(r.status) && (r.status !== 'declined' || r.decline_counts));
  const oldest = counted.map(r => r.created_at).sort()[0];
  return { count: counted.length, againFrom: oldest ? new Date(new Date(oldest).getTime() + 365 * 86400000) : null };
}

async function isVerifiedEmail(email) {
  const row = must(await db().from('vc_requester_emails').select('email').eq('email', normEmail(email)).maybeSingle(), 'verified email');
  return !!row;
}

/** Create a request. Verified emails go straight to placement; others wait for the confirm link. */
async function create({ centre, name, email, items, delivery, address, words, wordsShareable }) {
  email = normEmail(email);
  const verified = await isVerifiedEmail(email);
  const row = must(await db().from('vc_requests').insert({
    centre_id: centre.id, email, name: String(name).trim().slice(0, 80), items, delivery,
    address: delivery === 'ship' ? address : null, words: words ? String(words).trim().slice(0, 1000) : null,
    words_shareable: !!wordsShareable && !!words, status: 'unverified',
  }).select('*').single(), 'create request');
  if (verified) return { request: await place(row, centre), verified: true };
  return { request: row, verified: false };
}

/** After the confirm link (or for an already-verified email): decide and place the request. */
async function place(request, centre) {
  const now = new Date().toISOString();
  if (request.status !== 'unverified') return request;
  must(await db().from('vc_requester_emails').upsert({ email: request.email, verified_at: now }, { onConflict: 'email' }), 'verified email');
  let patch = { verified_at: now, updated_at: now };
  if (centre.approval_mode === 'by_hand') {
    patch.status = 'needs_answer';
  } else {
    Object.assign(patch, await approvalPatch(centre, 'system'));
  }
  const updated = must(await db().from('vc_requests').update(patch).eq('id', request.id).select('*').single(), 'place request');
  await logEvent(centre.id, 'system', `request.${updated.status}`, { request_id: updated.id, auto: centre.approval_mode !== 'by_hand' });
  return updated;
}

/** Which box an approved request joins: the open box unless it is already funded, then it waits. */
async function approvalPatch(centre, actor) {
  const box = await boxes.getOpenBox(centre.id, { create: true, goalCents: centre.goal_cents });
  const sum = await boxes.summary(centre, box);
  const now = new Date().toISOString();
  if (sum.funded) return { status: 'waiting', box_id: null, decided_by: actor, decided_at: now };
  return { status: 'approved', box_id: box.id, decided_by: actor, decided_at: now };
}

async function approve(request, centre, actor) {
  if (!['needs_answer', 'unverified'].includes(request.status)) return request;
  const patch = { ...(await approvalPatch(centre, actor)), updated_at: new Date().toISOString(), verified_at: request.verified_at || new Date().toISOString() };
  const updated = must(await db().from('vc_requests').update(patch).eq('id', request.id).select('*').single(), 'approve');
  await logEvent(centre.id, actor, `request.${updated.status}`, { request_id: updated.id });
  return updated;
}

async function decline(request, centre, actor, { counts = false, note = null } = {}) {
  if (!['needs_answer', 'approved', 'waiting'].includes(request.status)) return request;
  const updated = must(await db().from('vc_requests').update({ status: 'declined', decided_by: actor, decided_at: new Date().toISOString(), decline_counts: !!counts, decline_note: note, box_id: null, updated_at: new Date().toISOString() }).eq('id', request.id).select('*').single(), 'decline');
  await logEvent(centre.id, actor, 'request.declined', { request_id: updated.id, counts: !!counts });
  return updated;
}

async function getById(id) {
  return must(await db().from('vc_requests').select('*').eq('id', id).maybeSingle(), 'request');
}

async function listForCentre(centreId, { statuses } = {}) {
  let q = db().from('vc_requests').select('*').eq('centre_id', centreId).neq('status', 'unverified').order('created_at', { ascending: false });
  if (statuses) q = q.in('status', statuses);
  return must(await q, 'requests');
}

async function setPublished(request, published, actor) {
  if (!request.words_shareable) return request;
  const patch = published ? { words_published_at: new Date().toISOString(), published_by: actor.userId || null } : { words_published_at: null, published_by: null };
  const updated = must(await db().from('vc_requests').update(patch).eq('id', request.id).select('*').single(), 'publish words');
  await logEvent(request.centre_id, actor.label || 'system', published ? 'words.published' : 'words.unpublished', { request_id: request.id });
  return updated;
}

function statusLabel(r) {
  switch (r.status) {
    case 'needs_answer': return 'Needs your answer';
    case 'approved': return 'Approved';
    case 'waiting': return 'Waiting for the next box';
    case 'declined': return 'Declined';
    case 'in_box': return 'In the box';
    case 'shipped': return r.delivery === 'ship' ? 'Shipped to them' : 'On its way to the closet';
    case 'ready': return 'Ready to collect';
    case 'collected': return 'Collected';
    case 'ended': return 'Ended';
    case 'cancelled': return 'Cancelled';
    default: return r.status;
  }
}

module.exports = { describeItems, cleanItems, yearlyCount, isVerifiedEmail, create, place, approve, decline, getById, listForCentre, setPublished, statusLabel, normEmail, requestCost: (r) => money.requestCostCents(r.items, r.delivery, MENU) };
