#!/usr/bin/env node
'use strict';
/**
 * Virtual Closet web service: public closet pages, the programme page with
 * sign-up, the centre's private view, and the request/sponsor flows.
 * Operator screens live in the CS dashboard (customer-service/dashboard),
 * which calls the same lib/ functions.
 *
 *   PORT=3850 node virtual-closet/server.js
 */
require('dotenv').config();
const path = require('path');
const express = require('express');

const auth = require('./lib/auth');
const centres = require('./lib/centres');
const boxes = require('./lib/boxes');
const catalog = require('./lib/catalog');
const { db, must } = require('./lib/db');
const closetView = require('./views/closet');
const { page, esc } = require('./views/layout');

const PORT = parseInt(process.env.PORT || '3850', 10);
const BASE_URL = process.env.VC_BASE_URL || `http://localhost:${PORT}`;
const STARTED = new Date().toISOString();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'virtual-closet', started: STARTED }));
app.use(auth.attach());

// Named routes first: programme site, accounts, centre view, requests, terms.
app.use(require('./routes/accounts'));
for (const mod of ['./routes/centre', './routes/requests']) {
  const r = safeRequire(mod);
  if (r) app.use(r);
}

app.get('/offer-details', (req, res) => {
  res.type('html').send(page({ title: 'Offer details', mode: 'plain', body: `<section class="card narrow"><h1>Offer details</h1><ul class="list"><li>20% off one order with RUBIES, from a centre's closet link. New or returning customers.</li><li>Applied at checkout, no code to type. Once per customer.</li><li>Not combinable with other discount codes. Excludes gift cards.</li><li>For every two items bought through the link, the closet gets one: 25% of the order goes into the centre's box and RUBIES matches it. Underwear, bras and bikini bottoms all count as one item.</li><li>Orders count for the box for 30 days from using the link.</li></ul></section>` }));
});

app.get('/free-pair-terms', (req, res) => {
  res.type('html').send(page({ title: 'Free pair terms', mode: 'plain', body: `<section class="card narrow"><h1>Free pair terms</h1><ul class="list"><li>Free pairs are final: no exchanges or returns, which is why the size guide matters.</li><li>Colour is a preference. If it is out of stock when the shipment goes out, the same style is sent in another colour.</li><li>Items per request and requests per year are set by the centre and counted per email address.</li><li>Your address stays with RUBIES. The centre sees only the name you go by, your items and your words.</li><li>Requests are filled when the centre's shipment goes out. Shipments usually leave RUBIES within a few days of the centre sending them; a shipped item arrives in plain packaging.</li><li>If a centre leaves the programme before your request ships, the request ends with it and we email you.</li><li>Uncollected items stay in the closet for walk-ins.</li><li>No minimum age. Misuse (many requests across addresses, resale) ends the request and may end the centre's requests.</li></ul></section>` }));
});

// ---- public closet pages ---------------------------------------------------
const RESERVED = new Set(['signup', 'signin', 'signout', 'home', 'history', 'settings', 'send', 'account', 'invite', 'verify', 'reset', 'forgot', 'welcome', 'answer',
  'offer-details', 'free-pair-terms', 'health', 'api', 'public', 'favicon.ico', 'robots.txt', 'ops', 'thanks', 'map', 'team']);

async function loadCentre(req, res, next) {
  const slug = String(req.params.slug || '').toLowerCase();
  if (RESERVED.has(slug)) return next('route');
  try {
    const centre = await centres.getBySlug(slug);
    if (!centre || !centres.isPublic(centre)) {
      // Operators and the centre's own team may preview a pending page.
      const canPreview = centre && (req.actingAs || (req.centre && req.centre.id === centre.id));
      if (!canPreview) {
        return res.status(404).type('html').send(page({ title: 'Not found', mode: 'plain', body: `<section class="card narrow"><h1>No closet here</h1><p>There is no closet page at this address. It may be waiting for approval, or the link may be out of date.</p><a href="/">Virtual Closet</a></section>` }));
      }
    }
    req.centre = centre;
    next();
  } catch (err) { next(err); }
}

async function closetContext(centre) {
  const [box, lastSent, products] = await Promise.all([
    boxes.getOpenBox(centre.id, { create: centre.status === 'active', goalCents: centre.goal_cents }),
    boxes.lastSentBox(centre.id),
    catalog.menu(),
  ]);
  const sum = await boxes.summary(centre, box);
  const published = must(await db().from('vc_requests').select('words').eq('centre_id', centre.id).not('words_published_at', 'is', null).order('words_published_at', { ascending: false }).limit(6), 'words');
  return { centre, sum, lastSent, products, words: published.map(r => r.words).filter(Boolean), paused: !!centre.requests_paused_at };
}

app.get('/:slug', loadCentre, async (req, res, next) => {
  try {
    const lead = String(req.query.lead || '');
    const ctx = await closetContext(req.centre);
    if (req.centre.status === 'active') {
      db().from('vc_visits').insert({ centre_id: req.centre.id, lead: closetView.LEADS.has(lead) ? lead : null, source: req.query.from === 'map' ? 'map' : 'link' }).then(() => {}, () => {});
    }
    res.type('html').send(closetView.render({ ...ctx, lead }));
  } catch (err) { next(err); }
});

// Shop: issues a hidden single-use code and sends the shopper to the store (money step wires the code; until then the store).
app.get('/:slug/shop', loadCentre, async (req, res, next) => {
  try {
    const discounts = safeRequire('./lib/discounts');
    if (discounts) return res.redirect(302, await discounts.shopUrlFor(req.centre));
    res.redirect(302, `${catalog.STORE}/collections/all`);
  } catch (err) { next(err); }
});

// Sponsor tiles: cart permalink at the store with the centre attached (money step), else a holding page.
app.get('/:slug/sponsor/:tile', loadCentre, async (req, res, next) => {
  try {
    const tile = catalog.SPONSOR_TILES.find(t => t.key === req.params.tile);
    if (!tile) return res.redirect(302, `/${req.centre.slug}?lead=sponsor`);
    const sponsorship = safeRequire('./lib/sponsorship');
    const box = await boxes.getOpenBox(req.centre.id, { create: true, goalCents: req.centre.goal_cents });
    if (sponsorship) {
      const url = await sponsorship.checkoutUrl({ centre: req.centre, box, tile });
      if (url) return res.redirect(302, url);
    }
    res.type('html').send(page({ title: 'Sponsor', centre: req.centre, mode: 'public', body: `<section class="card narrow"><h1>${tile.label}, ${esc(tile.sub)}</h1><p>Checkout for sponsorships is wired in the money step. This link will send you to the RUBIES store with the amount in your cart and ${esc(req.centre.name)}'s closet attached.</p><a class="btn btn-line" href="/${req.centre.slug}?lead=sponsor">Back</a></section>` }));
  } catch (err) { next(err); }
});

app.get('/:slug/thanks', loadCentre, async (req, res, next) => {
  try {
    const ctx = await closetContext(req.centre);
    const { dollars } = require('./lib/money');
    const amount = parseInt(req.query.cents || '0', 10);
    res.type('html').send(page({ title: 'Thank you', centre: req.centre, mode: 'public', body: `<section class="card narrow"><p class="soft">Order ${esc(req.query.order || '')} · confirmed</p><h1>Thank you.</h1><p>Your ${amount ? dollars(amount) : 'sponsorship'} went into ${esc(req.centre.name)}'s shipment. RUBIES matched it.</p><p><b>Shipment #${ctx.sum.number}</b> · ${dollars(ctx.sum.raised)} raised of ${dollars(ctx.sum.goal)}</p><div class="doors"><a class="btn btn-fill" href="/${req.centre.slug}">Back to ${esc(req.centre.name)}'s closet</a><a class="btn btn-line" href="/${req.centre.slug}?lead=sponsor">Share the closet</a></div><p class="fine">A receipt is on its way from the store.</p></section>` }));
  } catch (err) { next(err); }
});


app.use((req, res) => {
  res.status(404).type('html').send(page({ title: 'Not found', mode: 'plain', body: `<section class="card narrow"><h1>Not found</h1><a href="/">Virtual Closet</a></section>` }));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[vc]', err);
  res.status(500).type('html').send(page({ title: 'Something went wrong', mode: 'plain', body: `<section class="card narrow"><h1>Something went wrong</h1><p>We have logged it. Try again in a moment.</p></section>` }));
});

function safeRequire(mod) {
  try { return require(mod); } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(path.basename(mod))) return null;
    throw err;
  }
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`[vc] Virtual Closet listening on ${BASE_URL}`));
}

module.exports = { app, BASE_URL, loadCentre, closetContext };
