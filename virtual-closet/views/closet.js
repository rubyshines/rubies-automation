'use strict';
/**
 * The closet page: one page, four arrangements picked by ?lead=
 * (wireframes 1ag, 1c, 1d, 1e, 2a) and the progress module states (1f).
 */
const { page, esc, LINKS, addressLine, placeholder } = require('./layout');
const { SPONSOR_TILES, productUrl } = require('../lib/catalog');
const { dollars } = require('../lib/money');
const { displaySizes } = require('../lib/centres');

const LEADS = new Set(['shop', 'request', 'sponsor']);

function render({ centre, sum, lastSent, products, lead, words, paused }) {
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
  return `<a class="btn btn-fill" href="/${ctx.slug}/shop">${esc(label)}</a><p class="fine">20% off one order with RUBIES, from this link. <a href="${LINKS.offer}">Offer details</a></p>`;
}

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
  if (strip) {
    return `<section class="strip" id="progress"><div><b>Shipment #${s.number}</b> · ${dollars(s.raised)} raised of ${dollars(s.goal)} · RUBIES matches every dollar</div><a class="btn btn-small btn-sun" href="#sponsor">Sponsor the closet</a></section>`;
  }
  return `<div class="progress${hero ? ' progress-hero' : ''}" id="progress"><div class="progress-head"><b>Shipment #${s.number}</b><span class="soft">${s.state === 'funded' || s.state === 'over' ? 'Funded' : `Ships when ${esc(ctx.name)} sends it`}</span></div><div class="amount">${dollars(s.raised)} <small>raised of ${dollars(s.goal)}</small></div>${bar}<p class="fine">${line}</p>${arrived}</div>`;
}

function amounts(ctx, { cta = 'Sponsor' } = {}) {
  const tiles = SPONSOR_TILES.map(t => `<a class="gift" href="/${ctx.slug}/sponsor/${t.key}"><b>${t.label}</b><small>${esc(t.sub)}</small></a>`).join('');
  return `<div class="gifts" id="sponsor">${tiles}</div><p class="fine">Pick an amount; checkout happens at the RUBIES store. RUBIES matches every dollar, so $16 becomes a $32 pair.</p>`;
}

function productGrid(ctx, { prices = true, discounted = false, details = false } = {}) {
  const cards = ctx.products.map(p => {
    const price = discounted
      ? `${dollars(p.retail_cents)} · <b>${dollars(Math.round(p.retail_cents * 0.8))}</b> with your 20%`
      : prices ? `${dollars(p.retail_cents)} · ${'○'.repeat(Math.min(5, p.colours.length))}` : '';
    const href = details ? `/${ctx.slug}/request#style-${p.key}` : productUrl(p);
    return `<a class="product" href="${href}">${placeholder(p.name + ' on model', 'ph-sq')}<span class="name">${esc(p.title.toUpperCase())}</span>${price ? `<span class="price">${price}</span>` : ''}${details ? `<span class="soft">Details</span>` : ''}</a>`;
  }).join('');
  return `<div class="products">${cards}</div><p class="fine">${details ? 'No prices here; Details opens the style sheet. ' : 'Cards link to the store with the discount. '}Sizes at ${esc(ctx.name)}: ${esc(ctx.sizes)}.</p>`;
}

function howItWorks(ctx, variant = 'default') {
  const steps = variant === 'request'
    ? [`Tell us the style, colour and size you'd like. Up to ${ctx.centre.items_per_request} items, ${ctx.centre.requests_per_year} times a year.`,
       `It goes into ${esc(ctx.name)}'s next shipment. We email you when it's on its way.`,
       'Collect it at the front desk, or it arrives at your door from RUBIES. Free pairs are final, so check your size.']
    : [`Shop, request or sponsor. Everything lands in one shipment for ${esc(ctx.name)}.`,
       'RUBIES matches every dollar in it.',
       `At its goal, the shipment goes to ${esc(ctx.name)}. Pairs go to the people who requested, then to anyone who walks in.`];
  return `<section class="how" id="how"><h2>How it works</h2><ol class="steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol><p class="soft">Who RUBIES is: a small brand making gender-affirming underwear and swimwear for trans girls and women. <a href="${LINKS.about}">About RUBIES</a></p></section>`;
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
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede">Gender-affirming underwear and swimwear for trans girls and women, from RUBIES. Stocked by ${esc(ctx.name)}'s community, matched by RUBIES.</p>
  </div>
  ${placeholder(`${ctx.centre.logo_url ? 'Centre logo' : '[Centre logo]'} + illustration`, 'ph-hero')}
</section>
<section class="three">
  <div class="card"><h3>Shop</h3><p>20% off one order with RUBIES, from this link. For every two items bought, the closet gets one.</p>${shopBtn(ctx)}</div>
  <div class="card"><h3>Request a pair</h3><p>Tell us what you need. ${requestLine(ctx)}</p>${requestBtn(ctx)}</div>
  <div class="card"><h3>Sponsor</h3><p>Put a pair in the shipment. RUBIES matches every dollar.</p><a class="btn btn-sun" href="#sponsor">Sponsor the closet</a></div>
</section>
<section class="sponsor-block">
  ${progress(ctx)}
  ${amounts(ctx)}
</section>
<section><h2>What goes in the closet</h2>${productGrid(ctx)}</section>
${howItWorks(ctx)}
${wordsSection(ctx)}`;
}

function shopFirst(ctx) {
  return `
<section class="hero">
  <div class="hero-copy">
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede"><b>Shop with 20% off. Every two items puts one in the closet.</b></p>
    <p>RUBIES makes gender-affirming underwear and swimwear for trans girls and women. 20% off one order from this link, and for every two items bought, ${esc(ctx.name)}'s closet gets one.</p>
    ${shopBtn(ctx, 'Shop the store with 20% off')}
  </div>
  ${placeholder('hero product photo, models in product', 'ph-hero')}
</section>
<section>${productGrid(ctx, { discounted: true })}</section>
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
    <h1>${esc(ctx.name)}'s closet</h1>
    <p class="lede"><b>Need a pair? Request one here.</b></p>
    <p>Gender-affirming underwear and swimwear for trans girls and women, from RUBIES. Pick a style and size, and it comes with ${esc(ctx.name)}'s next shipment: collect it at the centre or have it sent to your door in plain packaging. No cost to you.</p>
    <div class="doors">${requestBtn(ctx)}<a class="btn btn-line" href="${LINKS.sizeGuide}">Check my size first</a></div>
    <p class="fine">Only RUBIES and ${esc(ctx.name)} see your request. <a href="${LINKS.how}">How RUBIES works</a></p>
  </div>
  ${placeholder('product photo, calm, no fundraising imagery', 'ph-hero')}
</section>
<section><h2>What's in the closet</h2>${productGrid(ctx, { prices: false, details: true })}</section>
${howItWorks(ctx, 'request')}
<section class="two">
  <div class="card"><h3>Want to help instead?</h3><p>Shop with 20% off one order; for every two items bought, the closet gets one.</p>${shopBtn(ctx)}</div>
  <div class="card"><h3>Sponsor the closet</h3><p>Put a pair in the shipment. RUBIES matches every dollar.</p><a class="btn btn-sun" href="/${ctx.slug}?lead=sponsor#sponsor">Sponsor the closet</a></div>
</section>
<section class="strip quiet"><div>Shipment #${ctx.sum.number} · ${dollars(ctx.sum.raised)} raised of ${dollars(ctx.sum.goal)}</div></section>`;
}

function sponsorFirst(ctx) {
  return `
<section class="hero hero-sponsor">
  <div class="hero-copy">
    <h1>${esc(ctx.name)}'s closet · Shipment #${ctx.sum.number}</h1>
    ${progress(ctx, { hero: true })}
    <p>Gender-affirming underwear and swimwear for trans girls and women. RUBIES matches every dollar; at the goal, the shipment leaves for ${esc(ctx.name)}.</p>
    <div class="doors"><a class="btn btn-sun" href="#sponsor">Sponsor the closet</a><a class="btn btn-line" href="/${ctx.slug}/shop">Shop with 20% off</a>${requestBtn(ctx)}</div>
  </div>
</section>
<section class="tabs" data-tabs>
  <div class="tab-row"><button class="tab active" data-tab="sponsor">Sponsor</button><button class="tab" data-tab="shop">Shop</button><button class="tab" data-tab="request">Request</button></div>
  <div class="tab-pane" data-pane="sponsor"><p>Pick what to put in the shipment.</p>${amounts(ctx)}</div>
  <div class="tab-pane" data-pane="shop" hidden><p>20% off one order with RUBIES.</p>${shopBtn(ctx)}${productGrid(ctx)}</div>
  <div class="tab-pane" data-pane="request" hidden><p>Tell us what you need. ${requestLine(ctx)}</p>${requestBtn(ctx)}</div>
</section>
<section><h2>What's in the shipment</h2>${productGrid(ctx, { prices: false })}<p class="fine">Five styles, sizes ${esc(ctx.sizes)}. Requested items go in first; the centre picks the rest.</p></section>
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

module.exports = { render, renderPaused, LEADS, fmtDate };
