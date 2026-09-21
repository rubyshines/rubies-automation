'use strict';
/** The centre's private view: Home, requests answers, settings, team, account, history, send the box. */
const express = require('express');
const auth = require('../lib/auth');
const centres = require('../lib/centres');
const boxes = require('../lib/boxes');
const requestsLib = require('../lib/requests');
const emails = require('../lib/emails');
const { db, must, logEvent } = require('../lib/db');
const view = require('../views/centre');
const { SIZES } = require('../lib/catalog');

const r = express.Router();
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const actorOf = req => (req.actingAs ? `operator:${req.actingAs.operator}` : `user:${req.user.id}`);

function requireCentre(req, res, next) {
  if (!req.centre) return res.redirect(302, '/');
  next();
}
const guard = [auth.requireUser, requireCentre];

function monthStart() { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }

async function monthStats(centre) {
  const since = monthStart();
  const [visits, ledger, reqs] = await Promise.all([
    must(await db().from('vc_visits').select('id, source').eq('centre_id', centre.id).gte('visited_at', since), 'visits'),
    must(await db().from('vc_ledger').select('kind').eq('centre_id', centre.id).gte('created_at', since).in('kind', ['order_credit', 'sponsor']), 'month ledger'),
    must(await db().from('vc_requests').select('id').eq('centre_id', centre.id).gte('created_at', since).neq('status', 'unverified'), 'month requests'),
  ]);
  return {
    visits: visits.length, mapVisits: visits.filter(v => v.source === 'map').length,
    orders: ledger.filter(l => l.kind === 'order_credit').length, sponsors: ledger.filter(l => l.kind === 'sponsor').length, requests: reqs.length,
  };
}

async function passItOnStats(centre, month) {
  let routed = 0;
  if (centre.donation_partner_id) {
    const rows = must(await db().from('donation_routings').select('id').eq('partner_id', centre.donation_partner_id).gte('created_at', monthStart()), 'routings');
    routed = rows.length;
  }
  return { routed, mapVisits: month.mapVisits };
}

function shareLinks(centre) {
  const base = `${emails.BASE}/${centre.slug}`;
  return {
    links: [
      { url: base, note: 'the plain link: all three equally' },
      { url: `${base}?lead=shop`, note: 'shopping first: socials, the store' },
      { url: `${base}?lead=request`, note: 'requesting first: noticeboard, front desk' },
      { url: `${base}?lead=sponsor`, note: 'sponsoring first: donors, drives' },
    ],
    post: `${centre.name} now has a Virtual Closet with RUBIES: gender-affirming underwear and swimwear, free for anyone in our community who needs it. Shop with 20% off, request a pair, or sponsor the closet, and RUBIES matches every dollar. ${base}`,
  };
}

// ---- Home ------------------------------------------------------------------
r.get('/home', ...guard, async (req, res, next) => {
  try {
    const centre = req.centre;
    const box = await boxes.getOpenBox(centre.id, { create: centre.status === 'active', goalCents: centre.goal_cents });
    const [sum, lastSent, requests, month] = await Promise.all([
      boxes.summary(centre, box), boxes.lastSentBox(centre.id), requestsLib.listForCentre(centre.id), monthStats(centre),
    ]);
    const notCollected = lastSent?.status === 'delivered' && (Date.now() - new Date(lastSent.delivered_at)) > 14 * 86400000
      ? requests.filter(q => q.box_id === lastSent.id && q.status === 'ready') : [];
    res.type('html').send(view.home({
      centre, user: req.user, role: req.role, actingAs: req.actingAs, sum, lastSent, requests, month,
      share: shareLinks(centre), passItOn: await passItOnStats(centre, month), flash: req.query.flash, filter: req.query.filter, notCollected,
    }));
  } catch (err) { next(err); }
});

r.post('/home/pause', ...guard, async (req, res, next) => {
  try {
    const pause = req.body.action === 'pause';
    await centres.update(req.centre.id, { requests_paused_at: pause ? new Date().toISOString() : null }, actorOf(req));
    res.redirect(302, `/home?flash=${encodeURIComponent(pause ? 'Requests paused.' : 'Requests resumed.')}`);
  } catch (err) { next(err); }
});

// ---- requests: answer, words --------------------------------------------------
async function ownRequest(req, res) {
  const request = await requestsLib.getById(req.params.id);
  if (!request || request.centre_id !== req.centre.id) { res.status(404).send('Not found'); return null; }
  return request;
}
r.post('/requests/:id/approve', ...guard, async (req, res, next) => {
  try {
    const request = await ownRequest(req, res); if (!request) return;
    const updated = await requestsLib.approve(request, req.centre, actorOf(req));
    const items = requestsLib.describeItems(updated.items);
    await emails.requestReceived({ centre: req.centre, request: updated, items, approved: true, waiting: updated.status === 'waiting' });
    res.redirect(302, '/home?flash=Approved.');
  } catch (err) { next(err); }
});
r.get('/requests/:id/decline', ...guard, async (req, res, next) => {
  try {
    const request = await ownRequest(req, res); if (!request) return;
    res.type('html').send(view.declineForm({ centre: req.centre, request }));
  } catch (err) { next(err); }
});
r.post('/requests/:id/decline', ...guard, async (req, res, next) => {
  try {
    const request = await ownRequest(req, res); if (!request) return;
    const updated = await requestsLib.decline(request, req.centre, actorOf(req), { counts: !!req.body.counts, note: req.body.note || null });
    const { againFrom } = await requestsLib.yearlyCount(req.centre.id, updated.email);
    await emails.requestDeclined({ centre: req.centre, request: updated, againFrom: againFrom && req.body.counts ? againFrom.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null, note: req.body.note || null });
    res.redirect(302, '/home?flash=Declined%20and%20sent.');
  } catch (err) { next(err); }
});
r.post('/requests/:id/publish', ...guard, auth.requireAdmin, async (req, res, next) => {
  try { const request = await ownRequest(req, res); if (!request) return; await requestsLib.setPublished(request, true, { userId: req.user.id, label: actorOf(req) }); res.redirect(302, '/home'); } catch (err) { next(err); }
});
r.post('/requests/:id/unpublish', ...guard, auth.requireAdmin, async (req, res, next) => {
  try { const request = await ownRequest(req, res); if (!request) return; await requestsLib.setPublished(request, false, { userId: req.user.id, label: actorOf(req) }); res.redirect(302, '/home'); } catch (err) { next(err); }
});
r.post('/requests/:id/remind', ...guard, async (req, res, next) => {
  try {
    const request = await ownRequest(req, res); if (!request) return;
    const box = request.box_id ? await boxes.getBox(request.box_id) : null;
    await emails.requestReady({ centre: req.centre, request, items: requestsLib.describeItems(request.items), note: box?.pickup_note || view.defaultPickupNote(req.centre), reminder: true });
    must(await db().from('vc_requests').update({ reminded_at: new Date().toISOString() }).eq('id', request.id), 'reminded');
    res.redirect(302, '/home?flash=Reminder%20sent.');
  } catch (err) { next(err); }
});

// ---- add to the box (paid at the store; wired in the money step) -----------------
r.post('/add-to-box', ...guard, async (req, res, next) => {
  try {
    const dollars = Math.max(1, parseInt(req.body.dollars, 10) || 0);
    let sponsorship = null;
    try { sponsorship = require('../lib/sponsorship'); } catch { /* not built yet */ }
    const box = await boxes.getOpenBox(req.centre.id, { create: true, goalCents: req.centre.goal_cents });
    if (sponsorship) {
      const url = await sponsorship.checkoutUrl({ centre: req.centre, box, tile: { key: 'centre', cents: dollars * 100 }, centreAdd: true });
      if (url) return res.redirect(302, url);
    }
    res.redirect(302, `/home?flash=${encodeURIComponent(`Card payment for $${dollars} is wired in the money step.`)}`);
  } catch (err) { next(err); }
});

// ---- settings ----------------------------------------------------------------------
async function renderSettings(req, res, extra = {}) {
  const team = await auth.teamFor(req.centre.id);
  res.type('html').send(view.settings({ centre: req.centre, user: req.user, role: req.role, team, actingAs: req.actingAs, saved: req.query.saved ? 'Saved.' : '', invitesSent: !!req.query.invited, ...extra }));
}
r.get('/settings', ...guard, (req, res, next) => renderSettings(req, res).catch(next));

r.post('/settings/closet', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const b = req.body;
    const patch = {
      sizes: arr(b.sizes).filter(s => SIZES.includes(s)), kids_sizes: !!b.kids_sizes,
      items_per_request: parseInt(b.items_per_request, 10) || 2, requests_per_year: parseInt(b.requests_per_year, 10) || 2,
      goal_cents: (parseInt(b.goal, 10) || 300) * 100, approval_mode: b.approval_mode === 'by_hand' ? 'by_hand' : 'automatic',
      ship_to_door: b.ship_to_door === '1', requests_paused_at: b.paused ? (req.centre.requests_paused_at || new Date().toISOString()) : null,
    };
    if (!patch.sizes.length && !patch.kids_sizes) return renderSettings(req, res, { errors: ['Pick at least one size.'] });
    req.centre = await centres.update(req.centre.id, patch, actorOf(req));
    res.redirect(302, '/settings?saved=1#closet');
  } catch (err) { next(err); }
});
r.post('/settings/pass-it-on', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const b = req.body;
    const patch = req.centre.programmes?.pass_it_on
      ? { map_listed: !!b.map_listed, map_pin_to_closet: !!b.map_pin_to_closet, pass_it_on_paused_at: b.pass_it_on_paused ? (req.centre.pass_it_on_paused_at || new Date().toISOString()) : null }
      : b.join ? { programmes: { ...(req.centre.programmes || {}), pass_it_on: true } } : {};
    if (Object.keys(patch).length) req.centre = await centres.update(req.centre.id, patch, actorOf(req));
    res.redirect(302, '/settings?saved=1#pass-it-on');
  } catch (err) { next(err); }
});
r.post('/settings/centre', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const b = req.body;
    const patch = {
      name: String(b.name || req.centre.name).trim(), website: b.website || null, logo_url: b.logo_url || null,
      address: { street: b.street || '', city: b.city || '', region: b.region || '', postal: b.postal || '', country: b.country || 'US', hours: b.hours || '', phone: b.phone || '' },
      statements_email: b.statements_email || null,
    };
    req.centre = await centres.update(req.centre.id, patch, actorOf(req));
    res.redirect(302, '/settings?saved=1#centre');
  } catch (err) { next(err); }
});

// ---- team ------------------------------------------------------------------------------
r.post('/settings/team/invite', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const email = auth.normEmail(req.body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return renderSettings(req, res, { errors: ['That email does not look right.'] });
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const crypto = require('crypto');
    const raw = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    must(await db().from('vc_invitations').insert({ centre_id: req.centre.id, email, role, token_hash: crypto.createHash('sha256').update(raw).digest('hex'), invited_by: req.user.id, expires_at: expiresAt }), 'invite');
    await emails.invitation({ email, token: raw, centre: req.centre, invitedBy: req.user.name || req.user.email, expiresAt });
    await logEvent(req.centre.id, actorOf(req), 'team.invited', { email, role });
    res.redirect(302, '/settings?invited=1#team');
  } catch (err) { next(err); }
});
r.post('/settings/team/invite/:id/resend', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const inv = must(await db().from('vc_invitations').select('*').eq('id', req.params.id).eq('centre_id', req.centre.id).maybeSingle(), 'invite');
    if (!inv || inv.accepted_at) return res.redirect(302, '/settings#team');
    const crypto = require('crypto');
    const raw = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    must(await db().from('vc_invitations').update({ token_hash: crypto.createHash('sha256').update(raw).digest('hex'), expires_at: expiresAt, revoked_at: null }).eq('id', inv.id), 'resend');
    await emails.invitation({ email: inv.email, token: raw, centre: req.centre, invitedBy: req.user.name || req.user.email, expiresAt });
    res.redirect(302, '/settings?invited=1#team');
  } catch (err) { next(err); }
});
r.post('/settings/team/invite/:id/revoke', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    must(await db().from('vc_invitations').update({ revoked_at: new Date().toISOString() }).eq('id', req.params.id).eq('centre_id', req.centre.id), 'revoke');
    res.redirect(302, '/settings#team');
  } catch (err) { next(err); }
});
r.post('/settings/team/:userId/role', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    if (role === 'member' && (await auth.adminCount(req.centre.id)) <= 1) return renderSettings(req, res, { errors: ['At least one admin at all times. Make someone else admin first.'] });
    await auth.setRole(req.centre.id, userId, role);
    await logEvent(req.centre.id, actorOf(req), 'team.role', { user_id: userId, role });
    if (role === 'admin') { const u = await auth.getUserById(userId); if (u) await emails.madeAdmin({ user: u, centre: req.centre, by: req.user.name || req.user.email }); }
    res.redirect(302, '/settings?saved=1#team');
  } catch (err) { next(err); }
});
r.post('/settings/team/handover', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const to = parseInt(req.body.to, 10);
    if (!to || to === req.user.id) return res.redirect(302, '/settings#team');
    await auth.setRole(req.centre.id, to, 'admin');
    await auth.setRole(req.centre.id, req.user.id, 'member');
    await logEvent(req.centre.id, actorOf(req), 'team.handover', { to });
    const u = await auth.getUserById(to); if (u) await emails.madeAdmin({ user: u, centre: req.centre, by: req.user.name || req.user.email });
    res.redirect(302, '/settings?saved=1#team');
  } catch (err) { next(err); }
});
r.post('/settings/team/:userId/remove', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (userId === req.user.id) return renderSettings(req, res, { errors: ['Hand over admin before removing yourself.'] });
    const team = await auth.teamFor(req.centre.id);
    const target = team.members.find(m => m.id === userId);
    if (target?.role === 'admin' && (await auth.adminCount(req.centre.id)) <= 1) return renderSettings(req, res, { errors: ['At least one admin at all times.'] });
    await auth.removeMember(req.centre.id, userId);
    await logEvent(req.centre.id, actorOf(req), 'team.removed', { user_id: userId });
    res.redirect(302, '/settings?saved=1#team');
  } catch (err) { next(err); }
});

// ---- account -----------------------------------------------------------------------------
r.post('/settings/account/email', ...guard, async (req, res, next) => {
  try {
    const email = auth.normEmail(req.body.email);
    if (!email || email === req.user.email) return res.redirect(302, '/settings#account');
    if (await auth.getUserByEmail(email)) return renderSettings(req, res, { errors: ['That email already has an account.'] });
    const token = await auth.issueToken('change_email', { userId: req.user.id, email, ttlHours: 24 });
    await emails.confirmEmailChange({ newEmail: email, token });
    res.redirect(302, `/settings?saved=1#account`);
  } catch (err) { next(err); }
});
r.get('/account/email/:token', async (req, res, next) => {
  try {
    const t = await auth.consumeToken('change_email', req.params.token);
    if (!t) return res.status(410).send('This link has expired.');
    const user = await auth.getUserById(t.user_id);
    await auth.updateUser(user.id, { email: t.email, email_verified_at: new Date().toISOString() });
    await emails.emailChanged({ oldEmail: user.email, newEmail: t.email });
    res.redirect(302, '/settings?saved=1#account');
  } catch (err) { next(err); }
});
r.post('/settings/account/password', ...guard, async (req, res, next) => {
  try {
    if (!auth.verifyPassword(req.body.current, req.user.password_hash)) return renderSettings(req, res, { errors: ['Current password is wrong.'] });
    const pp = auth.passwordProblem(req.body.password); if (pp) return renderSettings(req, res, { errors: [pp] });
    await auth.updateUser(req.user.id, { password_hash: auth.hashPassword(req.body.password) });
    res.redirect(302, '/settings?saved=1#account');
  } catch (err) { next(err); }
});

// ---- leave ------------------------------------------------------------------------------------
r.post('/settings/leave', ...guard, auth.requireAdmin, async (req, res, next) => {
  try {
    await centres.setStatus(req.centre.id, 'left', actorOf(req), { left_at: new Date().toISOString(), map_listed: false });
    const open = must(await db().from('vc_requests').select('*').eq('centre_id', req.centre.id).in('status', ['needs_answer', 'approved', 'waiting']), 'open requests');
    if (open.length) {
      must(await db().from('vc_requests').update({ status: 'ended', updated_at: new Date().toISOString() }).in('id', open.map(o => o.id)), 'end requests');
      for (const q of open) await emails.requestEnded({ centre: req.centre, request: q });
    }
    await emails.deliver({ to: emails.OPERATOR_EMAIL, subject: `${req.centre.name} left the programme`, html: `<p>${req.centre.name} left. Anything raised in the open box ships as a final box: see the queue.</p>`, text: `${req.centre.name} left the programme.` });
    res.redirect(302, '/home?flash=You%20have%20left%20the%20programme.%20Anything%20raised%20still%20ships%20to%20you.');
  } catch (err) { next(err); }
});

// ---- history ----------------------------------------------------------------------------------
r.get('/history', ...guard, async (req, res, next) => {
  try {
    const list = await boxes.listBoxes(req.centre.id);
    const rows = [];
    for (const b of list) {
      const sum = await boxes.summary(req.centre, b);
      rows.push({ ...b, raised: sum.raised, match: sum.ledger.filter(l => l.kind === 'match').reduce((s, l) => s + l.amount_cents, 0), requestsFilled: sum.requests.filter(q => boxes.APPROVED.has(q.status)).length, waiting: b.status === 'open' ? sum.waitingCount : 0 });
    }
    const donations = req.centre.donation_partner_id ? must(await db().from('donation_routings').select('*').eq('partner_id', req.centre.donation_partner_id).order('created_at', { ascending: false }).limit(50), 'routings') : [];
    const statements = must(await db().from('vc_statements').select('month').eq('centre_id', req.centre.id).order('month', { ascending: false }), 'statements');
    res.type('html').send(view.history({ centre: req.centre, user: req.user, boxes: rows, donations, statements, actingAs: req.actingAs }));
  } catch (err) { next(err); }
});
r.get('/history/box/:number', ...guard, async (req, res, next) => {
  try {
    const box = await boxes.getBoxByNumber(req.centre.id, parseInt(req.params.number, 10));
    if (!box) return res.status(404).send('No such box');
    const sum = await boxes.summary(req.centre, box);
    const words = sum.requests.filter(q => q.words_published_at).map(q => q.words);
    res.type('html').send(view.boxDetail({ centre: req.centre, user: req.user, box, sum, plan: box.fill_plan, words, actingAs: req.actingAs }));
  } catch (err) { next(err); }
});

// ---- send the box ------------------------------------------------------------------------------
function planFromBody(b, centre) {
  const { MENU } = require('../lib/catalog');
  const plan = [];
  for (const s of MENU) for (const z of centre.sizes || SIZES) {
    const qty = parseInt(b[`q_${s.key}_${z}`], 10) || 0;
    if (qty > 0) plan.push({ style: s.key, size: z, qty });
  }
  return plan;
}
r.get('/send', ...guard, async (req, res, next) => {
  try {
    const box = await boxes.getOpenBox(req.centre.id, { create: true, goalCents: req.centre.goal_cents });
    const preview = await boxes.sendPreview(req.centre, box, { fillMode: 'auto' });
    res.type('html').send(view.sendBox({ centre: req.centre, user: req.user, preview, fillMode: 'auto', pickupNote: view.defaultPickupNote(req.centre), deliveryNote: view.defaultDeliveryNote(req.centre), actingAs: req.actingAs }));
  } catch (err) { next(err); }
});
r.post('/send', ...guard, async (req, res, next) => {
  try {
    const box = await boxes.getOpenBox(req.centre.id, { create: true, goalCents: req.centre.goal_cents });
    const fillMode = req.body.fill_mode === 'chosen' ? 'chosen' : 'auto';
    const plan = fillMode === 'chosen' ? planFromBody(req.body, req.centre) : null;
    const pickupNote = req.body.pickup_note || view.defaultPickupNote(req.centre);
    const deliveryNote = req.body.delivery_note || view.defaultDeliveryNote(req.centre);
    if (req.body.action !== 'send') {
      const preview = await boxes.sendPreview(req.centre, box, { fillMode, plan });
      return res.type('html').send(view.sendBox({ centre: req.centre, user: req.user, preview, fillMode, pickupNote, deliveryNote, actingAs: req.actingAs }));
    }
    let result;
    try {
      result = await boxes.sendBox(req.centre, box, { fillMode, plan, pickupNote, deliveryNote, actor: actorOf(req), rememberNotes: !!req.body.remember });
    } catch (err) {
      const preview = await boxes.sendPreview(req.centre, box, { fillMode, plan });
      return res.status(400).type('html').send(view.sendBox({ centre: req.centre, user: req.user, preview, fillMode, pickupNote, deliveryNote, errors: [err.message], actingAs: req.actingAs }));
    }
    for (const q of result.requests) {
      await emails.requestOnItsWay({ centre: req.centre, request: q, items: requestsLib.describeItems(q.items), note: q.delivery === 'ship' ? deliveryNote : null });
    }
    await emails.deliver({ to: emails.OPERATOR_EMAIL, subject: `Box to pack: ${req.centre.name} #${result.box.number}`, text: `${result.box.items_count} items. Packing list in Operations.`, html: `<p>${req.centre.name} sent box #${result.box.number}: ${result.box.items_count} items, ${result.requests.length} requests. <a href="${emails.OPS_BASE}/closets#box-${result.box.id}">Open the packing list</a>.</p>` });
    res.type('html').send(view.sent({ centre: req.centre, user: req.user, box: result.box, nextBox: result.nextBox }));
  } catch (err) { next(err); }
});

// ---- share tools -------------------------------------------------------------------------------------
r.get('/share/qr.svg', ...guard, async (req, res, next) => {
  try {
    const url = `${emails.BASE}/${req.centre.slug}${req.query.lead ? `?lead=${req.query.lead}` : ''}`;
    const svg = await require('qrcode').toString(url, { type: 'svg', margin: 2, color: { dark: '#310C48', light: '#FFFFFF' } });
    res.type('image/svg+xml').send(svg);
  } catch (err) { next(err); }
});

// Operator impersonation starts here: the dashboard mints a session and a
// signed one-time link; this sets the cookie on the closet domain.
r.get('/ops/enter', async (req, res) => {
  const crypto = require('crypto');
  const secret = process.env.VC_SESSION_SECRET || process.env.SESSION_SECRET || 'dev-only-secret';
  const sid = String(req.query.sid || ''), sig = String(req.query.sig || '');
  const expected = crypto.createHmac('sha256', secret).update(`enter:${sid}`).digest('base64url');
  if (!sid || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(403).send('Bad link');
  auth.setSessionCookie(res, sid, req);
  res.redirect(302, '/home');
});

// Operator impersonation ends here (the dashboard starts it).
r.get('/ops/stop', async (req, res) => {
  if (req.session) await auth.revokeSession(req.session.id);
  auth.clearSessionCookie(res);
  res.redirect(302, `${emails.OPS_BASE}/closets`);
});

module.exports = r;
