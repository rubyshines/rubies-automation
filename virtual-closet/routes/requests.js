'use strict';
/** The request flow: form, verify by email, confirm, by-hand answer links, report words. */
const express = require('express');
const auth = require('../lib/auth');
const boxes = require('../lib/boxes');
const catalog = require('../lib/catalog');
const requestsLib = require('../lib/requests');
const emails = require('../lib/emails');
const { db, must, logEvent } = require('../lib/db');
const view = require('../views/request');
const closetView = require('../views/closet');

const r = express.Router();

// A link-mode centre has no request door (the minimal cut, 2026-09-21): every
// request route 404s for it, so nothing reachable ever mentions requests.
function loadCentre(req, res, next) {
  return require('../server').loadCentre(req, res, err => {
    if (err) return next(err);
    if (req.centre && req.centre.mode === 'link') return next('route');
    next();
  });
}

function itemsFromBody(b) {
  const out = [];
  const raw = b.items;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') for (const k of Object.keys(raw).sort()) out.push(raw[k]);
  return out;
}

r.get('/:slug/request', loadCentre, async (req, res, next) => {
  try {
    const centre = req.centre;
    if (centre.requests_paused_at) return res.type('html').send(closetView.renderPaused({ centre }));
    const products = await catalog.menu();
    const values = req.query.style ? { items: [{ style: req.query.style }] } : {};
    res.type('html').send(view.form({ centre, products, values }));
  } catch (err) { next(err); }
});

r.get('/:slug/style/:key', loadCentre, async (req, res, next) => {
  try {
    const products = await catalog.menu();
    const style = products.find(p => p.key === req.params.key);
    if (!style) return res.redirect(302, `/${req.centre.slug}/request`);
    res.type('html').send(view.styleSheet({ centre: req.centre, style }));
  } catch (err) { next(err); }
});

r.post('/:slug/request', loadCentre, async (req, res, next) => {
  try {
    const centre = req.centre;
    if (centre.requests_paused_at) return res.type('html').send(closetView.renderPaused({ centre }));
    const products = await catalog.menu();
    const b = req.body;
    const values = { items: itemsFromBody(b), delivery: b.delivery === 'ship' && centre.ship_to_door ? 'ship' : 'pickup', street: b.street, city: b.city, region: b.region, postal: b.postal, words: b.words, share: !!b.share, name: b.name, email: b.email, newsletter: !!b.newsletter };
    const { items, errors } = requestsLib.cleanItems(values.items, centre);
    if (!values.name || !values.name.trim()) errors.push('Tell us the name you go by.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email || '')) errors.push('That email does not look right.');
    if (values.delivery === 'ship' && !(b.street && b.city && b.postal)) errors.push('For shipping we need a street, city and postcode.');
    let limit = null;
    if (!errors.length) {
      const { count, againFrom } = await requestsLib.yearlyCount(centre.id, values.email);
      if (count >= centre.requests_per_year) limit = { reached: true, count, againFrom: againFrom ? againFrom.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'next year' };
    }
    if (errors.length || limit) return res.status(400).type('html').send(view.form({ centre, products, values, errors, limit }));
    const { request, verified } = await requestsLib.create({
      centre, name: values.name, email: values.email, items, delivery: values.delivery,
      address: values.delivery === 'ship' ? { street: b.street, city: b.city, region: b.region || '', postal: b.postal } : null,
      words: values.words, wordsShareable: values.share,
    });
    if (values.newsletter) must(await db().from('vc_events').insert({ centre_id: centre.id, actor: 'visitor', kind: 'request.newsletter_optin', detail: { request_id: request.id } }), 'optin');
    if (!verified) {
      const token = await auth.issueToken('request_verify', { email: request.email, payload: { request_id: request.id, centre_id: centre.id }, ttlHours: 48 });
      await emails.requestConfirm({ centre, request, items: requestsLib.describeItems(items), token });
      return res.type('html').send(view.checkEmail({ centre, request }));
    }
    await afterPlacement(centre, request, { newsletter: values.newsletter });
    res.type('html').send(view.confirmed({ centre, request }));
  } catch (err) { next(err); }
});

r.post('/:slug/request/resend/:id', loadCentre, async (req, res, next) => {
  try {
    const request = await requestsLib.getById(req.params.id);
    if (!request || request.centre_id !== req.centre.id || request.status !== 'unverified') return res.redirect(302, `/${req.centre.slug}/request`);
    const token = await auth.issueToken('request_verify', { email: request.email, payload: { request_id: request.id, centre_id: req.centre.id }, ttlHours: 48 });
    await emails.requestConfirm({ centre: req.centre, request, items: requestsLib.describeItems(request.items), token });
    res.type('html').send(view.checkEmail({ centre: req.centre, request, resent: true }));
  } catch (err) { next(err); }
});

r.get('/:slug/request/confirm/:token', loadCentre, async (req, res, next) => {
  try {
    const t = await auth.consumeToken('request_verify', req.params.token);
    if (!t) return res.status(410).type('html').send(closetView.renderPaused({ centre: req.centre }).replace('Requests are paused', 'This link has expired').replace(/isn't taking new requests right now\. Anything already requested still ships as planned\./, 'Request again and we will send a fresh link.'));
    let request = await requestsLib.getById(t.payload.request_id);
    if (!request || request.centre_id !== req.centre.id) return res.redirect(302, `/${req.centre.slug}`);
    if (request.status === 'unverified') {
      request = await requestsLib.place(request, req.centre);
      const optin = must(await db().from('vc_events').select('id').eq('kind', 'request.newsletter_optin').contains('detail', { request_id: request.id }).limit(1), 'optin?');
      await afterPlacement(req.centre, request, { newsletter: optin.length > 0 });
    }
    res.type('html').send(view.confirmed({ centre: req.centre, request }));
  } catch (err) { next(err); }
});

/** Once a request is placed: tell the requester, tell the centre, and register the person at the store. */
async function afterPlacement(centre, request, { newsletter = false } = {}) {
  const items = requestsLib.describeItems(request.items);
  const to = centre.statements_email || (await firstAdminEmail(centre.id));
  if (request.status === 'needs_answer') {
    const approveToken = await auth.issueToken('request_answer', { email: to, payload: { request_id: request.id, centre_id: centre.id, outcome: 'approve' }, ttlHours: 14 * 24 });
    const declineToken = await auth.issueToken('request_answer', { email: to, payload: { request_id: request.id, centre_id: centre.id, outcome: 'decline' }, ttlHours: 14 * 24 });
    if (to) await emails.requestNeedsAnswer({ centre, to, request, items, approveToken, declineToken });
    // The requester hears "got it" now; approval or decline follows.
    await emails.requestReceived({ centre, request, items, needsAnswer: true });
  } else {
    await emails.requestReceived({ centre, request, items, waiting: request.status === 'waiting' });
    if (to && request.status === 'approved') {
      const box = await boxes.getBox(request.box_id);
      const count = must(await db().from('vc_requests').select('id').eq('box_id', request.box_id).in('status', ['approved', 'in_box']), 'count');
      await emails.requestAutoApproved({ centre, to, request, items, box, count: count.length });
    }
  }
  try {
    const customers = require('../lib/customers');
    await customers.registerRequester({ centre, request, newsletter });
  } catch (err) { console.warn(`[vc] store customer sync skipped: ${err.message}`); }
}

async function firstAdminEmail(centreId) {
  const rows = must(await db().from('vc_memberships').select('vc_users(email)').eq('centre_id', centreId).eq('role', 'admin').limit(1), 'admin email');
  return rows[0]?.vc_users?.email || null;
}

// ---- by-hand answer links (no sign-in) ------------------------------------------------------
r.get('/answer/:token', async (req, res, next) => {
  try {
    const t = await auth.consumeToken('request_answer', req.params.token);
    if (!t) return res.status(410).type('html').send(view.answered({ centre: {}, expired: true }));
    const request = await requestsLib.getById(t.payload.request_id);
    const centre = await require('../lib/centres').getById(t.payload.centre_id);
    if (!request || !centre) return res.redirect(302, '/');
    // Invalidate the sibling link (approve/decline share a request).
    await db().from('vc_tokens').update({ used_at: new Date().toISOString() }).eq('purpose', 'request_answer').is('used_at', null).contains('payload', { request_id: request.id });
    let updated;
    if (t.payload.outcome === 'approve') {
      updated = await requestsLib.approve(request, centre, 'centre:email');
      await emails.requestReceived({ centre, request: updated, items: requestsLib.describeItems(updated.items), approved: true, waiting: updated.status === 'waiting' });
    } else {
      updated = await requestsLib.decline(request, centre, 'centre:email', { counts: false });
      await emails.requestDeclined({ centre, request: updated, againFrom: null });
    }
    res.type('html').send(view.answered({ centre, request: updated, outcome: updated.status }));
  } catch (err) { next(err); }
});

// ---- report published words --------------------------------------------------------------------
r.get('/:slug/report-words', loadCentre, (req, res) => res.type('html').send(view.reportWords({ centre: req.centre })));
r.post('/:slug/report-words', loadCentre, async (req, res, next) => {
  try {
    const which = String(req.body.which || '').slice(0, 500);
    const published = must(await db().from('vc_requests').select('id, words').eq('centre_id', req.centre.id).not('words_published_at', 'is', null), 'published');
    const hit = published.find(p => which && p.words && (p.words.includes(which) || which.includes(p.words.slice(0, 40)))) || published[0];
    if (hit) must(await db().from('vc_word_reports').insert({ request_id: hit.id }), 'report');
    await logEvent(req.centre.id, 'visitor', 'words.reported', { which });
    res.type('html').send(view.reportWords({ centre: req.centre, done: true }));
  } catch (err) { next(err); }
});

module.exports = r;
