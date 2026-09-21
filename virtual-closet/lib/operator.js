'use strict';
/**
 * The RUBIES side (wireframes 2e to 2h), called by the CS dashboard's
 * /api/closets routes. Every action is logged on the centre.
 */
const { db, must, fetchAllPaginated, logEvent } = require('./db');
const centres = require('./centres');
const boxes = require('./boxes');
const requestsLib = require('./requests');
const auth = require('./auth');
const emails = require('./emails');
const money = require('./money');
const { MENU, styleByKey } = require('./catalog');
const { allowLiveWrite } = require('../../shared/liveWrites');

const opActor = email => `operator:${email || 'operator'}`;

// ---- needs attention -------------------------------------------------------------
async function needsAttention() {
  const now = Date.now();
  const day = 86400000;
  const [pending, sentBoxes, unanswered, fundedOpen, reports, allCentres] = await Promise.all([
    centres.list({ status: 'pending' }),
    must(await db().from('vc_boxes').select('*, vc_centres(name, slug)').eq('status', 'sent').order('sent_at'), 'sent boxes'),
    must(await db().from('vc_requests').select('centre_id, created_at').eq('status', 'needs_answer').lt('created_at', new Date(now - 14 * day).toISOString()), 'unanswered'),
    must(await db().from('vc_boxes').select('*, vc_centres(name, goal_cents, sizes)').eq('status', 'open'), 'open boxes'),
    must(await db().from('vc_word_reports').select('*, vc_requests(words, centre_id, vc_centres(name))').is('resolved_at', null).order('reported_at'), 'reports'),
    centres.list({ status: 'active' }),
  ]);
  const newCentres = [];
  for (const c of pending) {
    const team = await auth.teamFor(c.id);
    const admin = team.members.find(m => m.role === 'admin');
    // A sign-up whose admin never verified their email is not a queue item:
    // RUBIES is only told about a centre once that link is tapped.
    if (!admin?.email_verified_at) continue;
    newCentres.push({ ...c, admin, verified: true, ageDays: Math.floor((now - new Date(c.created_at)) / day) });
  }
  const waitingOn = [];
  const byCentre = new Map();
  for (const u of unanswered) byCentre.set(u.centre_id, (byCentre.get(u.centre_id) || 0) + 1);
  for (const [centreId, n] of byCentre) { const c = await centres.getById(centreId); waitingOn.push({ kind: 'unanswered', centre: c, text: `${c.name} has ${n} request${n === 1 ? '' : 's'} unanswered for 14+ days (by-hand approval)` }); }
  for (const b of fundedOpen) {
    const c = await centres.getById(b.centre_id);
    if (!c || c.status !== 'active') continue;
    const sum = await boxes.summary(c, b);
    if (sum.funded) {
      const fundedSince = sum.ledger.filter(l => money.RAISE_KINDS.has(l.kind)).map(l => l.created_at).sort().pop();
      const days = fundedSince ? Math.floor((now - new Date(fundedSince)) / day) : 0;
      if (days >= 30) waitingOn.push({ kind: 'funded_not_sent', centre: c, text: `${c.name}'s box #${b.number} has been fundable for ${days} days, not sent` });
    }
  }
  for (const c of allCentres) {
    const team = await auth.teamFor(c.id);
    const admins = team.members.filter(m => m.role === 'admin');
    const lastActive = team.members.map(m => m.last_active_at).filter(Boolean).sort().pop();
    if (admins.length === 1 && lastActive && (now - new Date(lastActive)) > 90 * day) waitingOn.push({ kind: 'lonely_admin', centre: c, text: `${c.name} has one admin, last active ${Math.floor((now - new Date(lastActive)) / day)} days ago` });
  }
  const week = new Date(now - 7 * day).toISOString();
  const [weekLedger, weekRequests, weekBoxes, matchOwed] = await Promise.all([
    must(await db().from('vc_ledger').select('kind, amount_cents, centre_id').gte('created_at', week).in('kind', ['order_credit', 'sponsor', 'centre_add']), 'week ledger'),
    must(await db().from('vc_requests').select('id, email, centre_id, created_at').gte('created_at', week).neq('status', 'unverified'), 'week requests'),
    must(await db().from('vc_boxes').select('id').gte('shipped_at', week), 'week boxes'),
    must(await db().from('vc_ledger').select('amount_cents, kind, vc_boxes!inner(status)').eq('vc_boxes.status', 'open').in('kind', ['order_credit', 'sponsor', 'centre_add', 'carry_in', 'adjustment']), 'match owed'),
  ]);
  const unusual = [];
  const ordersByCentre = new Map();
  for (const l of weekLedger.filter(l => l.kind === 'order_credit')) ordersByCentre.set(l.centre_id, (ordersByCentre.get(l.centre_id) || 0) + 1);
  for (const [centreId, n] of ordersByCentre) if (n >= 25) { const c = await centres.getById(centreId); unusual.push(`${c.name}: ${n} orders from closet links this week`); }
  const reqByEmail = new Map();
  for (const q of weekRequests) { const k = `${q.centre_id}|${q.email}`; reqByEmail.set(k, (reqByEmail.get(k) || 0) + 1); }
  for (const [k, n] of reqByEmail) if (n >= 3) { const c = await centres.getById(parseInt(k, 10)); unusual.push(`${n} requests from one email at ${c.name} in 7 days`); }
  return {
    newCentres,
    boxesToPack: sentBoxes.map(b => ({ ...b, centre: b.vc_centres })),
    waitingOn,
    reports: reports.map(r => ({ id: r.id, words: r.vc_requests?.words, centre: r.vc_requests?.vc_centres?.name, request_id: r.vc_requests ? r.request_id : null, reported_at: r.reported_at })),
    week: {
      activeCentres: allCentres.length,
      orders: weekLedger.filter(l => l.kind === 'order_credit').length,
      sponsoredCents: weekLedger.filter(l => l.kind === 'sponsor').reduce((s, l) => s + l.amount_cents, 0),
      requests: weekRequests.length,
      boxesShipped: weekBoxes.length,
      matchOwedCents: matchOwed.reduce((s, l) => s + l.amount_cents, 0),
    },
    unusual,
  };
}

/** The same list as the "Needs attention" email. */
async function attentionEmailItems() {
  const a = await needsAttention();
  const items = [];
  for (const c of a.newCentres) items.push({ text: `${c.name} signed up ${c.ageDays} day${c.ageDays === 1 ? '' : 's'} ago, not yet reviewed`, anchor: `#centre-${c.id}` });
  for (const b of a.boxesToPack) items.push({ text: `${b.centre.name} sent box #${b.number}: ${b.items_count || '?'} items to pack`, anchor: `#box-${b.id}` });
  for (const w of a.waitingOn) items.push({ text: w.text, anchor: `#centre-${w.centre.id}` });
  for (const r of a.reports) items.push({ text: `Reported words on ${r.centre}'s page`, anchor: '#reports' });
  for (const u of a.unusual) items.push({ text: u });
  return items;
}

// ---- centres ---------------------------------------------------------------------------
async function listCentres({ status } = {}) {
  const rows = await centres.list(status ? { status } : {});
  const out = [];
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  for (const c of rows) {
    const box = await boxes.getOpenBox(c.id);
    const sum = box ? await boxes.summary(c, box) : null;
    const [orders, unanswered, team] = await Promise.all([
      must(await db().from('vc_ledger').select('id').eq('centre_id', c.id).eq('kind', 'order_credit').gte('created_at', monthAgo), 'orders 30d'),
      must(await db().from('vc_requests').select('id').eq('centre_id', c.id).eq('status', 'needs_answer'), 'unanswered'),
      auth.teamFor(c.id),
    ]);
    out.push({
      ...c, box: sum ? { number: sum.number, raised: sum.raised, goal: sum.goal, funded: sum.funded, approved: sum.approvedCount, waiting: sum.waitingCount } : null,
      unanswered: unanswered.length, orders30d: orders.length,
      lastSignIn: team.members.map(m => m.last_active_at).filter(Boolean).sort().pop() || null,
      admins: team.members.filter(m => m.role === 'admin').length,
    });
  }
  return out;
}

async function centreDetail(id) {
  const centre = await centres.getById(id);
  if (!centre) return null;
  const [team, boxList, requests, events, codes, visits] = await Promise.all([
    auth.teamFor(centre.id), boxes.listBoxes(centre.id),
    must(await db().from('vc_requests').select('*').eq('centre_id', centre.id).order('created_at', { ascending: false }), 'requests'),
    must(await db().from('vc_events').select('*').eq('centre_id', centre.id).order('created_at', { ascending: false }).limit(60), 'events'),
    must(await db().from('vc_discount_codes').select('issued_at, used_at').eq('centre_id', centre.id), 'codes'),
    must(await db().from('vc_visits').select('lead, source, visited_at').eq('centre_id', centre.id).gte('visited_at', new Date(Date.now() - 90 * 86400000).toISOString()), 'visits'),
  ]);
  const boxRows = [];
  for (const b of boxList) { const sum = await boxes.summary(centre, b); boxRows.push({ ...b, raised: sum.raised, goal: sum.goal, funded: sum.funded, sources: sum.sources, requests: sum.requests.length, ledger: sum.ledger }); }
  const published = requests.filter(r => r.words_published_at).length;
  return {
    centre, team, boxes: boxRows, requests: requests.map(r => ({ ...r, items_text: requestsLib.describeItems(r.items).map(i => `${i.styleName} · ${i.colour} · ${i.size}`).join(', '), status_label: requestsLib.statusLabel(r) })),
    events, codes: { issued: codes.length, used: codes.filter(c => c.used_at).length }, visits: visits.length, published,
  };
}

// ---- approval queue ------------------------------------------------------------------------
async function approveCentre(id, operatorEmail) {
  const centre = await centres.getById(id);
  if (!centre || centre.status !== 'pending') throw new Error('Centre is not waiting for approval.');
  const team = await auth.teamFor(centre.id);
  const admin = team.members.find(m => m.role === 'admin');
  if (!admin?.email_verified_at) throw new Error("The admin's email is not verified yet.");
  let donationPartnerId = centre.donation_partner_id;
  if (centre.programmes?.pass_it_on && !donationPartnerId) {
    // This cascades a long way: a donation_partners row that CS routing reads
    // at runtime to send a real customer's return, then a publish that merges
    // to the theme repo and deploys rubyshines.com. A centre signed up against
    // a dev server is test data by construction, so it must not travel. The
    // operator's own MCP tools stay unguarded — a person running
    // donation_partner_create by hand is doing their job, not leaking a fixture.
    if (allowLiveWrite(`list ${centre.name} on the public donation map`)) {
      donationPartnerId = await createDonationPartner(centre);
    }
  }
  await centres.setStatus(centre.id, 'active', opActor(operatorEmail), { approved_at: new Date().toISOString(), approved_by: operatorEmail || 'operator', donation_partner_id: donationPartnerId });
  await boxes.getOpenBox(centre.id, { create: true, goalCents: centre.goal_cents });
  const updated = await centres.getById(centre.id);
  const to = centre.statements_email || admin.email;
  await emails.welcome({ centre: updated, to });
  if (centre.statements_email && centre.statements_email !== admin.email) await emails.welcome({ centre: updated, to: admin.email });
  return updated;
}

/** Pass It On: a donation partner row through the existing registry tool (geocode, map listing). */
async function createDonationPartner(centre) {
  const tools = require('../../customer-service/lib/tools/donationPartners');
  const create = tools.find(t => t.name === 'donation_partner_create');
  if (!create) throw new Error('donation_partner_create tool not found');
  const a = centre.address || {};
  const mailing = ['RUBIES Returns', `c/o ${centre.name}`, a.street, [a.city, a.region, a.postal].filter(Boolean).join(', '), a.country].filter(Boolean).join('\n');
  const adultSizes = (centre.sizes || []).length > 0;
  const result = await create.handler({
    name: centre.name, mailing_address: mailing, website_url: centre.website || undefined, logo_url: centre.logo_url || undefined,
    description: `${centre.name} runs a closet of gender-affirming clothing for its community and takes exchanged and returned RUBIES items.`,
    accepts_smaller_sizes: !!centre.kids_sizes, accepts_larger_sizes: adultSizes, confirmed: true,
  });
  const partner = result?._structured?.partner || result?._structured?.partners?.[0];
  if (!partner?.id) throw new Error(`Partner creation returned no id: ${(result?.content?.[0]?.text || '').slice(0, 200)}`);
  try { const publish = tools.find(t => t.name === 'donation_partner_publish'); if (publish) await publish.handler({}); } catch (err) { console.warn(`[vc] map publish skipped: ${err.message}`); }
  return partner.id;
}

async function askForMore(id, operatorEmail, message) {
  const centre = await centres.getById(id);
  const team = await auth.teamFor(centre.id);
  const admin = team.members.find(m => m.role === 'admin');
  if (admin) await emails.deliver({ to: admin.email, subject: `A question about ${centre.name}'s sign-up`, text: message, html: `<p>${message.replace(/\n/g, '<br>')}</p><p>Reply to this email. Jamie, RUBIES</p>` });
  await logEvent(centre.id, opActor(operatorEmail), 'centre.asked_for_more', { message });
}

async function declineCentre(id, operatorEmail, reason) {
  await centres.setStatus(id, 'left', opActor(operatorEmail), { left_at: new Date().toISOString(), paused_reason: reason || null, map_listed: false });
}

async function pauseCentre(id, operatorEmail, reason) {
  await centres.setStatus(id, 'paused', opActor(operatorEmail), { paused_reason: reason || null });
}
async function resumeCentre(id, operatorEmail) {
  await centres.setStatus(id, 'active', opActor(operatorEmail), { paused_reason: null });
}

async function overrideSettings(id, patch, operatorEmail) {
  const centre = await centres.update(id, patch, opActor(operatorEmail));
  const team = await auth.teamFor(centre.id);
  for (const m of team.members.filter(x => x.role === 'admin')) {
    await emails.deliver({ to: m.email, subject: `RUBIES changed a setting for ${centre.name}`, text: `Changed: ${Object.keys(patch).join(', ')}`, html: `<p>RUBIES changed ${Object.keys(patch).join(', ')} on ${centre.name}'s closet. <a href="${emails.BASE}/settings">See settings</a>.</p>` });
  }
  return centre;
}

/** "Open their Home as them": a session for the centre's admin, flagged as the operator. Returns the cookie value to set. */
async function impersonate(id, operatorEmail) {
  const team = await auth.teamFor(id);
  const admin = team.members.find(m => m.role === 'admin') || team.members[0];
  if (!admin) throw new Error('This centre has no team member to open as.');
  const sid = await auth.createSession(admin.id, { actingAs: { operator: operatorEmail } });
  await logEvent(id, opActor(operatorEmail), 'operator.opened_as_centre', { user_id: admin.id });
  return sid;
}

// ---- boxes and packing -------------------------------------------------------------------------------
async function listBoxesAll({ status } = {}) {
  let q = db().from('vc_boxes').select('*, vc_centres(name, slug)').order('sent_at', { ascending: false, nullsFirst: false });
  if (status) q = q.eq('status', status);
  const rows = must(await q.limit(200), 'boxes');
  const out = [];
  for (const b of rows) {
    const centre = await centres.getById(b.centre_id);
    const sum = await boxes.summary(centre, b);
    out.push({ ...b, centre, raised: sum.raised, match: sum.ledger.filter(l => l.kind === 'match').reduce((s, l) => s + l.amount_cents, 0), requests: sum.requests.filter(r => boxes.APPROVED.has(r.status) || ['in_box', 'shipped', 'ready', 'collected'].includes(r.status)).length });
  }
  return out;
}

async function packingList(boxId) {
  const box = await boxes.getBox(boxId);
  if (!box) return null;
  const centre = await centres.getById(box.centre_id);
  const sum = await boxes.summary(centre, box);
  const requests = sum.requests.filter(r => ['in_box', 'shipped', 'ready', 'collected', 'approved'].includes(r.status));
  const team = await auth.teamFor(centre.id);
  const admin = team.members.find(m => m.role === 'admin');
  const plan = (box.fill_plan || []).map(l => ({ ...l, styleName: styleByKey(l.style)?.name || l.style }));
  const t = money.sendTotals({ raised: sum.raised, shippedRequestCount: requests.filter(r => r.delivery === 'ship').length, placedProductCents: requests.reduce((s, r) => s + money.requestCostCents(r.items, 'pickup', MENU), 0) + money.planValueCents(box.fill_plan || [], MENU) });
  return { box, centre, admin, requests: requests.map(r => ({ ...r, items: requestsLib.describeItems(r.items) })), plan, totals: t, sizes: centre.sizes };
}

async function markShipped(boxId, { carrier, tracking, operatorEmail }) {
  const box = await boxes.getBox(boxId);
  const centre = await centres.getById(box.centre_id);
  const updated = await boxes.markShipped(box, { carrier, tracking, actor: opActor(operatorEmail) });
  const sum = await boxes.summary(centre, updated);
  const requests = sum.requests.filter(r => ['in_box', 'shipped'].includes(r.status));
  const to = centre.statements_email || (await firstAdmin(centre.id));
  const nextBox = await boxes.getOpenBox(centre.id);
  if (to) await emails.boxOnItsWay({ centre, to, box: updated, items: updated.items_count || sum.requests.length, pickups: requests.filter(r => r.delivery !== 'ship').map(r => r.name), doors: requests.filter(r => r.delivery === 'ship').map(r => r.name), nextBox });
  return updated;
}

async function markDelivered(boxId, { operatorEmail }) {
  const box = await boxes.getBox(boxId);
  const centre = await centres.getById(box.centre_id);
  const { box: updated, pickups } = await boxes.markDelivered(box, { actor: opActor(operatorEmail) });
  for (const p of pickups) await emails.requestReady({ centre, request: p, items: requestsLib.describeItems(p.items), note: box.pickup_note || centre.pickup_note || `Come to the front desk at ${centre.name} and ask for the closet.` });
  const to = centre.statements_email || (await firstAdmin(centre.id));
  if (to) await emails.boxArrived({ centre, to, box: updated, pickups: pickups.length });
  // Sponsors of this box hear it arrived.
  const sponsors = must(await db().from('vc_ledger').select('detail').eq('box_id', box.id).eq('kind', 'sponsor'), 'sponsors');
  const seen = new Set();
  for (const s of sponsors) { const e = s.detail?.email; if (e && !seen.has(e)) { seen.add(e); await emails.sponsorArrived({ centre, to: e, box: updated, items: updated.items_count || 0, requests: pickups.length }); } }
  return updated;
}

// ---- requests --------------------------------------------------------------------------------------------
async function listRequests({ status, q } = {}) {
  let query = db().from('vc_requests').select('*, vc_centres(name, slug, status)').neq('status', 'unverified').order('created_at', { ascending: false }).limit(300);
  if (status === 'open') query = query.in('status', ['approved', 'in_box', 'waiting']);
  else if (status === 'needs_answer') query = query.eq('status', 'needs_answer');
  else if (status) query = query.eq('status', status);
  const rows = must(await query, 'requests');
  const needle = (q || '').toLowerCase();
  return rows.filter(r => !needle || r.email.includes(needle) || (r.name || '').toLowerCase().includes(needle))
    .map(r => ({ ...r, centre: r.vc_centres, items_text: requestsLib.describeItems(r.items).map(i => `${i.styleName} · ${i.colour} · ${i.size}`).join(', '), status_label: requestsLib.statusLabel(r) }));
}

async function requestDetail(id) {
  const r = await requestsLib.getById(id);
  if (!r) return null;
  const centre = await centres.getById(r.centre_id);
  const { count } = await requestsLib.yearlyCount(centre.id, r.email);
  const events = must(await db().from('vc_events').select('*').eq('centre_id', centre.id).contains('detail', { request_id: r.id }).order('created_at'), 'request events');
  const box = r.box_id ? await boxes.getBox(r.box_id) : null;
  return { request: { ...r, items: requestsLib.describeItems(r.items), status_label: requestsLib.statusLabel(r) }, centre, yearCount: count, events, box };
}

async function swapItem(id, { index, colour, size, style, operatorEmail }) {
  const r = await requestsLib.getById(id);
  const items = [...r.items];
  const from = items[index];
  items[index] = { style: style || from.style, colour: colour || from.colour, size: size || from.size };
  must(await db().from('vc_requests').update({ items, swap: { from, to: items[index], at: new Date().toISOString() }, updated_at: new Date().toISOString() }).eq('id', id), 'swap');
  await logEvent(r.centre_id, opActor(operatorEmail), 'request.swapped', { request_id: id, from, to: items[index] });
}

async function cancelRequest(id, { reason, emailThem, operatorEmail }) {
  const r = await requestsLib.getById(id);
  must(await db().from('vc_requests').update({ status: 'cancelled', decided_by: opActor(operatorEmail), decided_at: new Date().toISOString(), decline_note: reason, updated_at: new Date().toISOString() }).eq('id', id), 'cancel');
  await logEvent(r.centre_id, opActor(operatorEmail), 'request.cancelled', { request_id: id, reason });
  if (emailThem) { const centre = await centres.getById(r.centre_id); await emails.requestDeclined({ centre, request: r, againFrom: null }); }
}

async function resolveReport(reportId, resolution, operatorEmail) {
  const rep = must(await db().from('vc_word_reports').select('*').eq('id', reportId).maybeSingle(), 'report');
  if (!rep) return;
  if (resolution === 'unpublish') {
    const r = await requestsLib.getById(rep.request_id);
    if (r) await requestsLib.setPublished(r, false, { label: opActor(operatorEmail) });
  }
  must(await db().from('vc_word_reports').update({ resolution, resolved_at: new Date().toISOString() }).eq('id', reportId), 'resolve report');
}

async function addToBoxAsRubies(centreId, cents, operatorEmail, note) {
  const centre = await centres.getById(centreId);
  const box = await boxes.getOpenBox(centre.id, { create: true, goalCents: centre.goal_cents });
  const { credit } = require('./ledger');
  return credit({ centre, box, kind: 'adjustment', amountCents: cents, sourceType: 'operator', sourceId: `${operatorEmail}-${Date.now()}`, detail: { note, by: operatorEmail } });
}

async function firstAdmin(centreId) {
  const rows = must(await db().from('vc_memberships').select('vc_users(email)').eq('centre_id', centreId).eq('role', 'admin').limit(1), 'admin');
  return rows[0]?.vc_users?.email || null;
}

module.exports = {
  needsAttention, attentionEmailItems, listCentres, centreDetail, approveCentre, askForMore, declineCentre, pauseCentre, resumeCentre,
  overrideSettings, impersonate, listBoxesAll, packingList, markShipped, markDelivered, listRequests, requestDetail, swapItem, cancelRequest,
  resolveReport, addToBoxAsRubies, fetchAllPaginated,
};
