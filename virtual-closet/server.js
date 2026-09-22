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
const { liveWriteMode } = require('../shared/liveWrites');
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
app.get('/health', (req, res) => res.json({ ok: true, service: 'virtual-closet', started: STARTED, ...liveWriteMode() }));
app.use(auth.attach());

// Named routes first: programme site, accounts, centre view, requests, terms.
app.use(require('./routes/accounts'));
for (const mod of ['./routes/centre', './routes/requests']) {
  const r = safeRequire(mod);
  if (r) app.use(r);
}

app.get('/offer-details', (req, res) => {
  res.type('html').send(page({ title: 'Offer details', mode: 'plain', body: `<section class="card narrow"><h1>Offer details</h1><ul class="list"><li>20% off one order with RUBIES, from a centre's closet link. New or returning customers.</li><li>Applied at checkout, no code to type. Once per customer.</li><li>Not combinable with other discount codes. Excludes gift cards.</li><li>For every two items bought through the link, the closet gets one: 25% of the order goes into the centre's box and RUBIES matches it. Underwear, bras and bikini bottoms all count as one item.</li></ul></section>` }));
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
  if (centres.isLink(centre)) {
    // Link mode: no boxes, no words, no pause. The page needs the styles and the balance.
    const ledger = require('./lib/ledger');
    const [products, balance] = await Promise.all([catalog.menu(), ledger.balance(centre)]);
    return { centre, products, balance, sum: null, lastSent: null, words: [], paused: false };
  }
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

// Shop, or a tap on a style: a hidden single-use code applied at the store,
// landing on the product when `to` names one. The code is remembered in a
// cookie on this host so a second tap on the same device reuses it while it
// is unused. The store learns about the closet from a `vc` parameter on the
// landing path (slug, code, tap time, centre name, and `used` when this
// device's earlier code was already spent), which the theme keeps in its own
// cookie; that is what fills the closet bar and puts the centre on the cart.
const SHOP_COOKIE = 'vc_code';
app.get('/:slug/shop', loadCentre, async (req, res, next) => {
  try {
    const discounts = safeRequire('./lib/discounts');
    if (!discounts) return res.redirect(302, `${catalog.STORE}/collections/all`);
    const remembered = (auth.readCookie(req, SHOP_COOKIE) || '').split('|');
    const previousCode = remembered[0] === req.centre.slug ? remembered[1] : null;
    const visit = await discounts.shopVisit(req.centre, { redirect: req.query.to, previousCode });
    if (visit.code) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const cookies = [`${SHOP_COOKIE}=${encodeURIComponent(`${req.centre.slug}|${visit.code}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`];
      // The store's theme reads `vc_closet` (same fields as the landing
      // parameter). When this service answers on closet.rubyshines.com the
      // cookie can be set for the whole domain, so the store has the closet
      // even when the landing query is lost: Shopify's theme preview rewrites
      // it, and so could any redirect the store adds later (2026-09-22).
      if (/(^|\.)rubyshines\.com$/i.test(String(req.hostname || ''))) {
        const value = [req.centre.slug, visit.code, Date.now(), req.centre.name || '', visit.used ? 'used' : ''].join('|');
        cookies.push(`vc_closet=${encodeURIComponent(value)}; Domain=.rubyshines.com; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
      }
      res.setHeader('Set-Cookie', cookies);
    }
    res.redirect(302, visit.url);
  } catch (err) { next(err); }
});

// The store's theme asks whether the code in its cookie has been spent, so
// the closet bar can go once the order is in. Public, no secrets: a code is
// only ever in the shopper's own URL and cookie. Answers for our codes only.
app.get('/api/code/:code', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', catalog.STORE);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const discounts = safeRequire('./lib/discounts');
    const known = discounts ? await discounts.centreForCode(req.params.code) : null;
    if (!known) return res.status(404).json({ ok: false });
    res.json({ ok: true, used: !!known.order_id });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// Sponsor tiles: cart permalink at the store with the centre attached (money step), else a holding page.
app.get('/:slug/sponsor/:tile', loadCentre, async (req, res, next) => {
  try {
    const tile = catalog.SPONSOR_TILES.find(t => t.key === req.params.tile);
    if (!tile) return res.redirect(302, `/${req.centre.slug}?lead=sponsor`);
    const sponsorship = safeRequire('./lib/sponsorship');
    const box = centres.isLink(req.centre) ? null : await boxes.getOpenBox(req.centre.id, { create: true, goalCents: req.centre.goal_cents });
    if (sponsorship) {
      const url = await sponsorship.checkoutUrl({ centre: req.centre, box, tile });
      if (url) return res.redirect(302, url);
    }
    res.type('html').send(page({ title: 'Sponsor', centre: req.centre, mode: 'public', body: `<section class="card narrow"><h1>${tile.label}${tile.sub ? `, ${esc(tile.sub)}` : ''}</h1><p>Checkout for sponsorships is not set up on this deployment. This link will send you to the RUBIES store with the amount in your cart and ${esc(req.centre.name)}'s closet attached.</p><a class="btn btn-line" href="/${req.centre.slug}#sponsor">Back</a></section>` }));
  } catch (err) { next(err); }
});

// The centre's link as a QR, for the welcome email and anything printed.
// Public, so the centre can fetch it again without asking. Link mode only.
async function qrFor(req, res, next, type) {
  try {
    if (!centres.isLink(req.centre)) return next('route');
    const QRCode = require('qrcode');
    const url = `${BASE_URL}/${req.centre.slug}`;
    if (type === 'svg') {
      res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 2, color: { dark: '#310C48', light: '#FFFFFF' } }));
    } else {
      res.type('image/png').send(await QRCode.toBuffer(url, { type: 'png', width: 720, margin: 2, color: { dark: '#310C48', light: '#FFFFFF' } }));
    }
  } catch (err) { next(err); }
}
app.get('/:slug/qr.png', loadCentre, (req, res, next) => qrFor(req, res, next, 'png'));
app.get('/:slug/qr.svg', loadCentre, (req, res, next) => qrFor(req, res, next, 'svg'));

// The printable table sign, the same PDF the welcome email attaches, so a
// centre can reprint it from the address printed on the sign itself.
app.get('/:slug/qr-sign', loadCentre, async (req, res, next) => {
  try {
    if (!centres.isLink(req.centre)) return next('route');
    const pdf = await require('./lib/sign').signPdf(req.centre, { url: `${BASE_URL}/${req.centre.slug}` });
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${req.centre.slug}-virtual-closet-sign.pdf"`).send(pdf);
  } catch (err) { next(err); }
});

app.get('/:slug/thanks', loadCentre, async (req, res, next) => {
  try {
    const ctx = await closetContext(req.centre);
    const { dollars } = require('./lib/money');
    const amount = parseInt(req.query.cents || '0', 10);
    if (centres.isLink(req.centre)) {
      const b = ctx.balance;
      const cur = req.centre.currency;
      return res.type('html').send(page({ title: 'Thank you', centre: req.centre, mode: 'public', body: `<section class="card narrow"><p class="soft">Order ${esc(req.query.order || '')} · confirmed</p><h1>Thank you.</h1><p>Your ${amount ? dollars(amount, cur) : 'sponsorship'} went to ${esc(req.centre.name)}'s Virtual Closet. Thanks for your support.</p>${b.raisedCents ? `<p><b>${dollars(b.raisedCents, cur)}</b> raised so far. RUBIES matches it: ${dollars(b.raisedCents * 2, cur)} of underwear and swimwear for the closet.</p>` : ''}<div class="doors"><a class="btn btn-fill" href="/${req.centre.slug}">Back to ${esc(req.centre.name)}'s Virtual Closet</a></div><p class="fine">A receipt is on its way from the store.</p></section>` }));
    }
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
  app.listen(PORT, () => {
    const mode = liveWriteMode();
    // Say it out loud on every boot: a guard stuck off is otherwise
    // indistinguishable from there being nothing to write.
    console.log(`[vc] Virtual Closet listening on ${BASE_URL}`);
    console.log(mode.live
      ? `[vc] live deployment: writes to Shopify and the donation map are ON`
      : `[vc] not the live deployment (no ${mode.signal}): discount codes and donation-map listings are skipped`);
  });
}

module.exports = { app, BASE_URL, loadCentre, closetContext };
