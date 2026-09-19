'use strict';
/** Request a pair (1g, 1o), sent states (1h, 1p), style sheet and size guide (1ah), by-hand answer pages. */
const { page, esc, LINKS, addressLine, placeholder } = require('./layout');
const { KIDS_SIZES } = require('../lib/catalog');
const { errorBox } = require('./programme');
const requestsLib = require('../lib/requests');

function itemRow(products, centre, idx, values = {}) {
  const sizes = [...(centre.sizes || []), ...(centre.kids_sizes ? KIDS_SIZES.map(k => `${k}`) : [])];
  const styleOpts = products.map(p => `<option value="${p.key}" ${values.style === p.key ? 'selected' : ''} data-colours="${esc(p.colours.join('|'))}">${esc(p.title)}</option>`).join('');
  const chosen = products.find(p => p.key === values.style) || products[0];
  const colourOpts = chosen.colours.map(c => `<option ${values.colour === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const sizeOpts = sizes.map(s => `<option value="${s}" ${values.size === s ? 'selected' : ''}>${/^\d+$/.test(s) ? `Kids ${s}` : s}</option>`).join('');
  return `<div class="item"><div class="row"><label>Style <select name="items[${idx}][style]" data-style-select>${styleOpts}</select></label><label>Colour <select name="items[${idx}][colour]" data-colour-select>${colourOpts}</select></label><label>Size <select name="items[${idx}][size]">${sizeOpts}</select></label></div><div class="progress-head"><span class="fine">Colour is a preference. If it's out of stock we send the same style in another colour. <a href="${LINKS.sizeGuide}" target="_blank" rel="noopener">Size guide</a></span><button type="button" class="btn btn-small btn-quiet remove">Remove</button></div></div>`;
}

function form({ centre, products, values = {}, errors = [], limit }) {
  const items = values.items?.length ? values.items : [{}];
  const body = `
<section>
<p><a href="/${centre.slug}">← Back to the closet</a></p>
<h1>Request a pair</h1>
<p class="lede">RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Tell us what you need; it comes with ${esc(centre.name)}'s next shipment, in plain packaging, and we'll email you when it's ready. Only RUBIES and ${esc(centre.name)} see your request. New to RUBIES? <a href="${LINKS.how}">How RUBIES works</a>.</p>
<h2>Our styles</h2>
<div class="products">${products.map(p => `<a class="product" href="/${centre.slug}/style/${p.key}" id="style-${p.key}">${placeholder(p.name, 'ph-sq')}<span class="name">${esc(p.name)}</span><span class="fine">${esc(p.kind === 'underwear' ? 'No-tuck shaping underwear' : p.kind === 'bra' ? 'Shaping bra' : 'Bikini bottom')}</span><span class="soft">Details</span></a>`).join('')}</div>
<div class="card" style="margin-top:16px"><h3>Please check your size first</h3><p>Free pairs can't be exchanged, so a minute with the size guide is worth it. Measure your hips; the guide does the rest.</p><a class="btn btn-line" href="${LINKS.sizeGuide}" target="_blank" rel="noopener">Open the size guide</a></div>
</section>
<section>
${limit?.reached ? `<div class="error">You've requested ${limit.count} time${limit.count === 1 ? '' : 's'} this year at ${esc(centre.name)}; you can request again from ${esc(limit.againFrom)}.</div>` : ''}
${errorBox(errors)}
<form class="form" method="post" action="/${centre.slug}/request" id="request-form">
  <h2>What do you need?</h2>
  <div class="items" id="items">${items.map((it, i) => itemRow(products, centre, i, it)).join('')}</div>
  <template id="item-template">${itemRow(products, centre, '__i__')}</template>
  <button type="button" class="btn btn-small btn-line" id="add-item" data-max="${centre.items_per_request}">+ Add another item</button>
  <p class="fine">Up to ${centre.items_per_request} per request.</p>
  <fieldset><legend>How would you like it?</legend>
    <label class="radio"><input type="radio" name="delivery" value="pickup" ${values.delivery !== 'ship' ? 'checked' : ''} data-reveal="#address"> Pick it up at ${esc(centre.name)}${addressLine(centre) ? `, ${esc(addressLine(centre))}` : ''}</label>
    ${centre.ship_to_door ? `<label class="radio"><input type="radio" name="delivery" value="ship" ${values.delivery === 'ship' ? 'checked' : ''} data-reveal="#address"> Ship it to me</label>` : '<p class="fine">This centre hands pairs out at the front desk.</p>'}
    <div id="address" ${values.delivery === 'ship' ? '' : 'hidden'}>
      <p class="fine">Address (only RUBIES sees this; the centre does not)</p>
      <label>Street <input type="text" name="street" value="${esc(values.street || '')}" autocomplete="street-address"></label>
      <div class="row"><label>City <input type="text" name="city" value="${esc(values.city || '')}" autocomplete="address-level2"></label><label>State <input type="text" name="region" value="${esc(values.region || '')}" autocomplete="address-level1"></label><label>Postcode <input type="text" name="postal" value="${esc(values.postal || '')}" autocomplete="postal-code"></label></div>
    </div>
  </fieldset>
  <label>What would a pair mean to you? <span class="fine">(optional)</span><textarea name="words" placeholder="A sentence is plenty." maxlength="1000">${esc(values.words || '')}</textarea></label>
  <label class="check"><input type="checkbox" name="share" value="1" ${values.share ? 'checked' : ''}> You may share my words on the closet page, without my name.</label>
  <label>The name you go by <input type="text" name="name" value="${esc(values.name || '')}" required maxlength="80"></label>
  <label>Email, for updates about your request <input type="email" name="email" value="${esc(values.email || '')}" required></label>
  <label class="check"><input type="checkbox" name="newsletter" value="1" ${values.newsletter ? 'checked' : ''}> Keep me posted from RUBIES now and then. <span class="fine">Optional.</span></label>
  <div class="card"><h3>Before you send</h3><ul class="list">
    <li>Free pairs are final: no exchanges or returns, which is why the size guide matters.</li>
    <li>Colour is a preference. Out of stock? Same style, another colour.</li>
    <li>Up to ${centre.items_per_request} items per request, ${centre.requests_per_year} request${centre.requests_per_year === 1 ? '' : 's'} a year at ${esc(centre.name)}.</li>
    <li>Your address stays with RUBIES. ${esc(centre.name)} never sees it, only the name you go by, your items and your words.</li>
    <li>Any age. If a centre leaves the programme before your request ships, the request ends with it; we'll email you if that happens.</li></ul>
    <p class="fine">The full list, including delivery times and what happens if a box is delayed: <a href="/free-pair-terms">Free pair terms</a>. By sending you agree to them.</p></div>
  <button class="btn btn-fill" type="submit" ${limit?.reached ? 'disabled' : ''}>Send my request</button>
  <p class="fine">First time requesting with this email? We'll send you a link to confirm it. Nothing is sent to ${esc(centre.name)} until you tap it. Confirmed before? Your request goes straight in.</p>
</form></section>`;
  return page({ title: `Request a pair · ${centre.name}`, centre, mode: 'public', nav: `<a href="/${centre.slug}">Closet</a>`, body });
}

function checkEmail({ centre, request, resent = false }) {
  const items = requestsLib.describeItems(request.items).map(i => `<li>${esc(i.styleName)} · ${esc(i.colour)} · ${esc(i.size)}</li>`).join('');
  const body = `<section class="card narrow"><p class="soft">Check your email</p><h1>One more step, ${esc(request.name)}.</h1><p>We sent a link to <b>${esc(request.email)}</b>. Tap it to confirm your request. Nothing goes to ${esc(centre.name)} until you do.</p>${resent ? '<div class="ok">Sent again.</div>' : ''}<ul class="list">${items}<li class="soft">${request.delivery === 'ship' ? 'Ship it to me' : `Pick up at ${esc(centre.name)}`}</li></ul><form class="doors" method="post" action="/${centre.slug}/request/resend/${request.id}"><button class="btn btn-line">Send again</button><a class="btn btn-quiet" href="/${centre.slug}/request">Wrong address? Change it</a></form></section>`;
  return page({ title: 'Check your email', centre, mode: 'public', body });
}

function confirmed({ centre, request }) {
  const items = requestsLib.describeItems(request.items).map(i => `<li>${esc(i.styleName)} · ${esc(i.colour)} · ${esc(i.size)}</li>`).join('');
  const waiting = request.status === 'waiting';
  const needsAnswer = request.status === 'needs_answer';
  const body = waiting
    ? `<section class="card narrow"><h1>You're on the list, ${esc(request.name)}.</h1><p>This shipment is already funded and being packed, so your request goes in the next one. We'll email ${esc(request.email)} when it's on its way.</p><a class="btn btn-line" href="/${centre.slug}">Back to the closet</a></section>`
    : `<section class="card narrow"><h1>Got it, ${esc(request.name)}.</h1><p>Your request is in ${esc(centre.name)}'s next shipment.</p><ul class="list">${items}<li class="soft">${request.delivery === 'ship' ? 'Shipped to you' : `Pick up at ${esc(centre.name)}`}</li></ul><p>Your email is confirmed. ${needsAnswer ? `${esc(centre.name)} looks over each request; you'll hear from us at ${esc(request.email)}.` : `You'll hear from us at ${esc(request.email)} when it's ready${request.delivery === 'ship' ? '' : ' to pick up'}.`}</p><p class="fine">Free pairs are final.</p><a class="btn btn-line" href="/${centre.slug}">Back to the closet</a></section>`;
  return page({ title: 'Request confirmed', centre, mode: 'public', body });
}

function styleSheet({ centre, style }) {
  const body = `<section class="card narrow"><p><a href="/${centre.slug}/request">← Back to the request</a></p><h1>${esc(style.title)}</h1>${placeholder('product photos, swipe', 'ph-hero')}<p><b>What it does:</b> ${style.kind === 'underwear' ? 'gaff-style shaping with no tucking needed.' : style.kind === 'bra' ? 'a soft shaping bra for everyday wear.' : 'a no-tuck bikini bottom for the pool and beach.'} <b>Colours:</b> ${esc(style.colours.join(', '))}.</p><p><a href="${LINKS.sizeGuide}" target="_blank" rel="noopener">Size guide</a> · <a href="https://rubyshines.com/products/${esc(style.handle)}" target="_blank" rel="noopener">Full page on the store</a></p><a class="btn btn-fill" href="/${centre.slug}/request?style=${style.key}">Choose this style</a></section>`;
  return page({ title: style.title, centre, mode: 'public', body });
}

function answered({ centre, request, outcome, expired = false }) {
  const body = expired
    ? `<section class="card narrow"><h1>This link has expired</h1><p>The request needs your answer in your <a href="/home">private view</a>.</p></section>`
    : `<section class="card narrow"><h1>${outcome === 'approved' ? 'Approved' : outcome === 'waiting' ? 'Approved, waiting for the next box' : 'Declined'}</h1><p>${esc(request.name)}'s request${outcome === 'declined' ? ' has been declined and they have been told, kindly.' : ' is in. They have been told.'}</p><a class="btn btn-line" href="/home">Open Home</a></section>`;
  return page({ title: 'Answered', centre, mode: 'plain', body });
}

function reportWords({ centre, done = false }) {
  const body = done ? `<section class="card narrow"><h1>Thank you</h1><p>RUBIES will look at it.</p><a href="/${centre.slug}">Back to the closet</a></section>`
    : `<section class="card narrow"><h1>Report words on this page</h1><p>If something shared on ${esc(centre.name)}'s page points at a real person or place, or should not be there, tell RUBIES.</p><form class="form" method="post" action="/${centre.slug}/report-words"><label>Which words? <textarea name="which" required></textarea></label><button class="btn btn-fill">Report</button></form></section>`;
  return page({ title: 'Report', centre, mode: 'public', body });
}

module.exports = { form, checkEmail, confirmed, styleSheet, answered, reportWords };
