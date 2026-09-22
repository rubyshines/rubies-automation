'use strict';
/**
 * The closet page: one page, four arrangements picked by ?lead=
 * (wireframes 1ag, 1c, 1d, 1e, 2a) and the progress module states (1f).
 */
const { page, esc, LINKS, img, productCard, illustration } = require('./layout');
const { SPONSOR_TILES } = require('../lib/catalog');
const money = require('../lib/money');
const { dollars } = money;
const { displaySizes } = require('../lib/centres');

const LEADS = new Set(['shop', 'request', 'sponsor']);

function render({ centre, sum, lastSent, products, lead, words, paused, balance }) {
  if (centre.mode === 'link') {
    // The minimal cut (2026-09-21): one arrangement, whatever ?lead says.
    // Every figure on the page is in the centre's own currency (Jamie, 2026-09-22).
    const ctx = { centre, products, balance: balance || { raisedCents: 0, orders: 0, sponsors: 0 }, slug: centre.slug, name: centre.name, currency: centre.currency || money.SHOP_CURRENCY };
    return page({ title: `${centre.name} Virtual Closet`, body: linkOnly(ctx), centre, mode: 'public', nav: '' });
  }
  lead = LEADS.has(lead) ? lead : 'default';
  const ctx = { centre, sum, lastSent, products, words, paused, slug: centre.slug, name: centre.name, sizes: displaySizes(centre) };
  const body = lead === 'shop' ? shopFirst(ctx) : lead === 'request' ? requestFirst(ctx) : lead === 'sponsor' ? sponsorFirst(ctx) : allEqual(ctx);
  const nav = lead === 'request' ? `<a href="/${centre.slug}?lead=shop">Shop</a><a href="/${centre.slug}?lead=sponsor">Sponsor</a>`
    : lead === 'shop' ? `<a href="/${centre.slug}/request">Request a pair</a><a href="/${centre.slug}?lead=sponsor">Sponsor</a>`
    : `<a href="${LINKS.styles}">Visit the store</a>`;
  return page({ title: `${centre.name}'s closet`, body, centre, mode: 'public', nav });
}

// ---- modules -------------------------------------------------------------

function shopBtn(ctx, label = 'Shop with 20% off') {
  return `<a class="btn btn-fill" href="/${ctx.slug}/shop">${esc(label)}</a>`;
}
const offerLink = `<a href="${LINKS.offer}">Offer details</a>`;

function requestBtn(ctx, label = 'Request a pair') {
  if (ctx.paused) {
    return `<p class="soft">Requests are paused at ${esc(ctx.name)} for now. Check back soon, or ask at the front desk.</p><span class="btn btn-line disabled" aria-disabled="true">${esc(label)}</span>`;
  }
  return `<a class="btn btn-line" href="/${ctx.slug}/request">${esc(label)}</a>`;
}

function requestLine(ctx) {
  if (ctx.sum.number === 1 && ctx.sum.state === 'empty') return 'It comes with the first shipment, to the closet or to your door.';
  return 'It comes with the next shipment, to the closet or to your door.';
}

/** The centre's own logo above the heading, when it has given us one. */
function centreLogo(ctx) {
  return ctx.centre.logo_url ? `<img class="centre-logo" src="${esc(ctx.centre.logo_url)}" alt="${esc(ctx.name)}">` : '';
}

/** A store photo as the hero's picture: the product itself, the way the store shows it. */
function heroArt(ctx, key) {
  const p = ctx.products.find(x => x.key === key) || ctx.products[0];
  if (!p) return '';
  return `<div class="hero-art"><img src="${img(p.image, 900)}" alt="${esc(p.title)}" width="600" height="600"></div>`;
}

function progress(ctx, { hero = false, strip = false } = {}) {
  const s = ctx.sum;
  const pct = s.goal ? Math.min(100, Math.round((s.raised / s.goal) * 100)) : 0;
  const bar = `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  let line;
  switch (s.state) {
    case 'empty': line = 'Be the first. RUBIES matches every dollar.'; break;
    case 'grown': line = 'The goal grew to cover everyone who asked.'; break;
    case 'funded': line = `Funded. Anything more grows the shipment until ${esc(ctx.name)} sends it.`; break;
    case 'over': line = `Funded, ${dollars(s.over)} over. Anything more grows the shipment until ${esc(ctx.name)} sends it.`; break;
    default: line = `${s.sources.sponsorCount} sponsor${s.sources.sponsorCount === 1 ? '' : 's'} so far. RUBIES matches every dollar.`;
  }
  const arrived = ctx.lastSent && ctx.lastSent.delivered_at
    ? `<p class="fine">Shipment #${ctx.lastSent.number} arrived at ${esc(ctx.name)} on ${fmtDate(ctx.lastSent.delivered_at)}${ctx.lastSent.items_count ? ` with ${ctx.lastSent.items_count} items` : ''}.</p>`
    : ctx.lastSent ? `<p class="fine">Shipment #${ctx.lastSent.number} is on its way to ${esc(ctx.name)}.</p>` : '';
  const status = s.state === 'funded' || s.state === 'over' ? `<span class="tag">Funded</span>` : `<span class="soft">Open</span>`;
  const count = `${s.sources.sponsorCount} sponsor${s.sources.sponsorCount === 1 ? '' : 's'}`;
  if (strip) {
    // The fundraiser band: the amount, the goal, the bar and the count the way
    // GoFundMe shows them, with the sponsor button beside it.
    return `<section class="fund" id="progress"><div class="fund-copy"><div class="progress-head"><b>Shipment #${s.number}</b>${status}</div><div class="amount">${dollars(s.raised)} <small>raised of ${dollars(s.goal)} goal</small></div>${bar}<p class="fine">${count} · ${s.state === 'funded' || s.state === 'over' ? line : 'RUBIES matches every dollar'}</p></div><div class="fund-cta"><a class="btn btn-fill" href="#sponsor">Sponsor the closet</a><p class="fine">From $16, a pair of underwear.</p></div></section>`;
  }
  return `<div class="progress${hero ? ' progress-hero' : ''}" id="progress"><div class="progress-head"><b>Shipment #${s.number}</b>${status}</div><div class="amount">${dollars(s.raised)} <small>raised of ${dollars(s.goal)} goal</small></div>${bar}<p class="fine">${line}</p>${arrived}</div>`;
}

/** The tiles read in the centre's currency: £10, £25... A sponsor pays that round number at the store through Shopify Markets. */
function tiles(ctx) {
  return SPONSOR_TILES.map(t => `<a class="gift" href="/${ctx.slug}/sponsor/${t.key}"><b>${ctx.currency ? dollars(t.cents, ctx.currency) : t.label}</b>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}</a>`).join('');
}

function amounts(ctx) {
  return `<div class="amounts" id="sponsor"><p><b>RUBIES matches every dollar.</b> Pick an amount; you pay at the RUBIES store.</p><div class="gifts">${tiles(ctx)}</div></div>`;
}

// ---- link mode: the whole page ---------------------------------------------

/**
 * The fundraiser band: "$88 raised of $1,000 goal", the bar, then the match
 * line. Lifetime raised against the centre's goal (Jamie, 2026-09-21).
 */
function totalLine(ctx) {
  const b = ctx.balance;
  const cur = ctx.currency;
  const goal = Math.max(1, ctx.centre.goal_cents || money.LINK_DEFAULT_GOAL_CENTS);
  const pct = Math.min(100, Math.round((b.raisedCents / goal) * 100));
  const bar = `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  let line, fine;
  if (!b.raisedCents) { line = `Be the first. Every order and every sponsor dollar counts for ${esc(ctx.name)}'s Virtual Closet.`; fine = ''; }
  else {
    line = `RUBIES matches it: <b>${dollars(b.raisedCents * 2, cur)}</b> of underwear and swimwear for the closet.`;
    fine = `<p class="fine">From ${n(b.orders, 'order', 'orders')} and ${n(b.sponsors, 'sponsor', 'sponsors')}.${b.raisedCents >= goal ? ' Goal reached, and everything from here keeps the closet stocked.' : ''}</p>`;
  }
  return `<section class="fund fund-link" id="total"><div class="fund-copy"><div class="amount">${dollars(b.raisedCents, cur)} <small>raised of ${dollars(goal, cur)} goal</small></div>${bar}<p>${line}</p>${fine}</div></section>`;
}

// The About RUBIES copy on the link page, as Jamie wrote it (2026-09-21).
const LINK_ABOUT = 'RUBIES makes great fitting, super comfortable clothing made specifically for trans girls and women that look, wear and feel like regular underwear and swimwear. No tucking or tight compression.';

function linkOnly(ctx) {
  // The menu's retail prices are the store's USD prices; a centre in another
  // currency shows no prices here and the store shows its market's own.
  const usd = ctx.currency === money.SHOP_CURRENCY;
  return `
<section class="hero">
  <div class="hero-copy">
    <h1>Shop 20% off gender-affirming gear.</h1>
    <p class="lede">Shop RUBIES and support ${esc(ctx.name)} Virtual Closet. ${esc(ctx.name)} uses what's raised to give free gender-affirming clothing to people who need it. RUBIES will donate a quarter of the value of your order to the closet.</p>
    ${shopBtn(ctx)}
  </div>
  ${illustration('mirror')}
</section>
${aboutSection(LINK_ABOUT)}
${totalLine(ctx)}
<section id="sponsor">
  <h2>Here as an ally? Sponsor the closet. Help someone feel comfortable and confident.</h2>
  <div class="gifts gifts-4">${tiles(ctx)}</div>
  <p class="fine fine-after">You pay at the RUBIES online store. It goes straight to ${esc(ctx.name)}'s Virtual Closet.</p>
</section>
<section><h2>The styles</h2>${productGrid(ctx, { discounted: usd, prices: usd, foot: false, note: false })}<p class="fine fine-after">Tap a style to shop it with 20% off. <a href="${LINKS.how}">Learn how RUBIES works</a>.</p></section>`;
}

function productGrid(ctx, { prices = true, discounted = false, details = false, foot = true, note = true } = {}) {
  const cards = ctx.products.map(p => {
    const price = discounted
      ? `<s>${dollars(p.retail_cents)}</s> <b>${dollars(Math.round(p.retail_cents * 0.8))}</b>${note ? ' <span class="fine">with your 20%</span>' : ''}`
      : prices ? dollars(p.retail_cents) : '';
    // A style tap goes through Shop so the 20% and the centre travel with it.
    const href = details ? `/${ctx.slug}/style/${p.key}` : `/${ctx.slug}/shop?to=${encodeURIComponent(`/products/${p.handle}`)}`;
    return productCard(p, { href, price, sub: details ? 'Details' : '' });
  }).join('');
  const line = details ? `Sizes at ${esc(ctx.name)}: ${esc(ctx.sizes)}.` : `Tap a style to shop it with 20% off. Sizes at ${esc(ctx.name)}: ${esc(ctx.sizes)}.`;
  return `<div class="products">${cards}</div>${foot ? `<p class="fine">${line}</p>` : ''}`;
}

/** Who RUBIES is, for the visitor who arrived from a centre's post and has never heard of us. */
function aboutSection(copy) {
  // Link page: the beach illustration on the left, the words on the right (Jamie, 2026-09-21).
  if (copy) return `<section class="about">${illustration('beach', 'about-art')}<div><h2>About RUBIES</h2><p>${copy}</p><p>Learn more <a href="${LINKS.about}">about RUBIES</a>.</p></div></section>`;
  return `<section class="about"><div><h2>About RUBIES</h2><p>RUBIES is a small brand making gender-affirming underwear and swimwear for trans girls and women. No tucking, no compression, just a smooth line in something that feels like regular underwear. Every pair is tested with our community and comes with a money-back guarantee at the store. Every girl deserves to shine.</p><p><a href="${LINKS.how}">How RUBIES works</a> · <a href="${LINKS.sizeGuide}">Size guide</a> · <a href="${LINKS.about}">About us</a></p></div>${illustration('beach', 'about-art')}</section>`;
}

function howItWorks(ctx, variant = 'default') {
  const steps = variant === 'request'
    ? [`Tell us the style, colour and size you'd like. Up to ${ctx.centre.items_per_request} items, ${ctx.centre.requests_per_year} times a year.`,
       `It goes into ${esc(ctx.name)}'s next shipment. We email you when it's on its way.`,
       'Collect it at the front desk, or it arrives at your door from RUBIES. Free pairs are final, so check your size.']
    : [`Shop, request or sponsor. Everything lands in one shipment for ${esc(ctx.name)}.`,
       'RUBIES matches every dollar in it.',
       `At its goal, the shipment goes to ${esc(ctx.name)}. Pairs go to the people who requested, then to anyone who walks in.`];
  return `<section class="how" id="how"><h2>How it works</h2><ol class="steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol></section>`;
}

function wordsSection(ctx) {
  if (!ctx.words?.length) return '';
  return `<section class="words"><h2>Words from the community</h2>${ctx.words.map(w => `<blockquote>“${esc(w)}”</blockquote>`).join('')}<p class="fine">Shared with permission, without names. <a href="/${ctx.slug}/report-words">Report</a></p></section>`;
}

// ---- arrangements --------------------------------------------------------

function allEqual(ctx) {
  return `
<section class="hero">
  <div class="hero-copy">
    ${centreLogo(ctx)}
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede">Gender-affirming underwear and swimwear for trans girls and women, from RUBIES. Stocked by ${esc(ctx.name)}'s community, matched by RUBIES.</p>
  </div>
  ${illustration('mirror')}
</section>
<section class="three doors-3">
  <div class="card"><h3>Shop</h3><p>20% off one order with RUBIES, from this link. For every two items bought, the closet gets one. ${offerLink}</p>${shopBtn(ctx)}</div>
  <div class="card"><h3>Request a pair</h3><p>Tell us what you need. ${requestLine(ctx)}</p>${requestBtn(ctx)}</div>
  <div class="card"><h3>Sponsor</h3><p>Put a pair in the shipment. RUBIES matches every dollar.</p><a class="btn btn-sun" href="#sponsor">Sponsor the closet</a></div>
</section>
<section>
  <h2>Sponsor the closet</h2>
  <div class="sponsor-block">
  ${progress(ctx)}
  ${amounts(ctx)}
  </div>
</section>
<section><h2>What goes in the closet</h2>${productGrid(ctx)}</section>
${aboutSection()}
${howItWorks(ctx)}
${wordsSection(ctx)}`;
}

function shopFirst(ctx) {
  return `
<section class="hero">
  <div class="hero-copy">
    ${centreLogo(ctx)}
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede"><b>Shop with 20% off. Every two items puts one in the closet.</b></p>
    <p>RUBIES makes gender-affirming underwear and swimwear for trans girls and women. 20% off one order from this link, and for every two items bought, ${esc(ctx.name)}'s closet gets one.</p>
    ${shopBtn(ctx, 'Shop the store with 20% off')}
    <p class="fine">${offerLink}</p>
  </div>
  ${heroArt(ctx, 'aj')}
</section>
<section>${productGrid(ctx, { discounted: true })}</section>
${aboutSection()}
${progress(ctx, { strip: true })}
<section class="two">
  <div class="card"><h3>Need a pair?</h3><p>Request what you need. ${requestLine(ctx)}</p>${requestBtn(ctx)}</div>
  <div class="card"><h3>Sponsor the closet</h3><p>Put a pair in the shipment. RUBIES matches every dollar.</p>${amounts(ctx)}</div>
</section>
${howItWorks(ctx)}`;
}

function requestFirst(ctx) {
  return `
<section class="hero">
  <div class="hero-copy">
    ${centreLogo(ctx)}
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede"><b>Need a pair? Request one here.</b></p>
    <p>Gender-affirming underwear and swimwear for trans girls and women, from RUBIES. Pick a style and size, and it comes with ${esc(ctx.name)}'s next shipment: collect it at the centre or have it sent to your door in plain packaging. No cost to you.</p>
    <div class="doors">${requestBtn(ctx)}<a class="btn btn-line" href="${LINKS.sizeGuide}">Check my size first</a></div>
    <p class="fine">Only RUBIES and ${esc(ctx.name)} see your request. <a href="${LINKS.how}">How RUBIES works</a></p>
  </div>
  ${illustration('mirror')}
</section>
<section><h2>What's in the closet</h2>${productGrid(ctx, { prices: false, details: true })}</section>
${aboutSection()}
${howItWorks(ctx, 'request')}
<section class="two">
  <div class="card"><h3>Want to help instead?</h3><p>Shop with 20% off one order; for every two items bought, the closet gets one. ${offerLink}</p>${shopBtn(ctx)}</div>
  <div class="card"><h3>Sponsor the closet</h3><p>Put a pair in the shipment. RUBIES matches every dollar.</p><a class="btn btn-sun" href="/${ctx.slug}?lead=sponsor#sponsor">Sponsor the closet</a></div>
</section>
<section class="strip quiet" id="progress"><div class="quiet-fund"><span><b>Shipment #${ctx.sum.number}</b> · ${dollars(ctx.sum.raised)} raised of ${dollars(ctx.sum.goal)} goal</span><div class="bar bar-slim" role="progressbar" aria-valuenow="${ctx.sum.goal ? Math.min(100, Math.round((ctx.sum.raised / ctx.sum.goal) * 100)) : 0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${ctx.sum.goal ? Math.min(100, Math.round((ctx.sum.raised / ctx.sum.goal) * 100)) : 0}%"></span></div></div></section>`;
}

function sponsorFirst(ctx) {
  return `
<section class="hero hero-sponsor">
  <div class="hero-copy">
    ${centreLogo(ctx)}
    <h1>${esc(ctx.name)}'s closet</h1>
    ${progress(ctx, { hero: true })}
    <p>Gender-affirming underwear and swimwear for trans girls and women. RUBIES matches every dollar; at the goal, the shipment leaves for ${esc(ctx.name)}.</p>
    <div class="doors"><a class="btn btn-sun" href="#sponsor">Sponsor the closet</a><a class="btn btn-line" href="/${ctx.slug}/shop">Shop with 20% off</a>${requestBtn(ctx)}</div>
  </div>
</section>
<section class="tabs" data-tabs>
  <div class="tab-row"><button class="tab active" data-tab="sponsor">Sponsor</button><button class="tab" data-tab="shop">Shop</button><button class="tab" data-tab="request">Request</button></div>
  <div class="tab-pane" data-pane="sponsor"><p>Pick what to put in the shipment.</p>${amounts(ctx)}</div>
  <div class="tab-pane" data-pane="shop" hidden><p>20% off one order with RUBIES. ${offerLink}</p>${shopBtn(ctx)}${productGrid(ctx)}</div>
  <div class="tab-pane" data-pane="request" hidden><p>Tell us what you need. ${requestLine(ctx)}</p>${requestBtn(ctx)}</div>
</section>
<section><h2>What's in the shipment</h2>${productGrid(ctx, { prices: false, foot: false })}<p class="fine">Five styles, sizes ${esc(ctx.sizes)}. Requested items go in first; the centre picks the rest.</p></section>
${aboutSection()}
${howItWorks(ctx)}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/** The request-form URL opened directly while paused (2c). */
function renderPaused({ centre }) {
  const body = `<section class="card narrow"><h1>Requests are paused</h1><p>${esc(centre.name)} isn't taking new requests right now. Anything already requested still ships as planned.</p><a class="btn btn-line" href="/${centre.slug}">Back to the closet</a></section>`;
  return page({ title: `Requests are paused`, body, centre, mode: 'public' });
}

module.exports = { render, renderPaused, LEADS, fmtDate, linkOnly };
