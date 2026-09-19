'use strict';
const { STORE } = require('../lib/catalog');
const { FAVICON, ILLUSTRATIONS, swatch } = require('../lib/brand');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const LINKS = {
  how: `${STORE}/pages/how-it-works`,
  styles: `${STORE}/collections/all`,
  sizeGuide: `${STORE}/pages/size-guide`,
  compare: `${STORE}/pages/find-your-fit`,
  about: `${STORE}/pages/about-us`,
  map: `${STORE}/pages/donate-your-pre-loved-rubies-clothing`,
  offer: '/offer-details',
  terms: '/free-pair-terms',
};

/** A Shopify CDN image at a given width (the CDN resizes on the fly). */
function img(url, width) {
  if (!url) return '';
  if (!/cdn\.shopify\.com/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}width=${width}`;
}

const logo = (width = 170) => `<img src="/public/rubies-logo.svg" alt="RUBIES" width="${width}" height="${Math.round(width * 135 / 489)}">`;

/** One of the store's illustrations in a framed art block. */
function illustration(name, cls = 'hero-art') {
  const i = ILLUSTRATIONS[name] || ILLUSTRATIONS.beach;
  return `<div class="${cls}" style="aspect-ratio:${i.ratio}"><img src="${i.src}" alt="${esc(i.alt)}" loading="lazy"></div>`;
}

/**
 * Every page. `mode` picks the header: public (closet pages), programme (the
 * sign-up site), centre (signed-in private view), plain (account cards). The
 * closet page carries only the logo, linked to the store, in its own header
 * and footer; the programme site and the centre's view link the logo home.
 */
function page({ title, body, centre, mode = 'public', nav = '', user = null, banner = '', wide = false }) {
  const home = mode === 'centre' ? '/home' : mode === 'public' ? STORE : '/';
  const brand = `<a class="brand" href="${home}" aria-label="RUBIES">${logo()}</a>`;
  let header = '';
  if (mode === 'public' && centre) {
    header = `<header class="hd"><div>${brand}<span class="hd-sub">${esc(centre.name)}'s closet</span></div><nav>${nav}</nav></header>`;
  } else if (mode === 'centre') {
    header = `<header class="hd"><div>${brand}<nav class="hd-nav"><a href="/home">Home</a><a href="/history">History</a><a href="/settings">Settings</a></nav></div><div class="hd-user">${esc(centre?.name || '')}${user ? ` · ${esc(user.name || user.email)}` : ''} <a href="/signout">Sign out</a></div></header>`;
  } else if (mode === 'programme') {
    header = `<header class="hd"><div>${brand}</div><nav><a href="/#how">How it works</a><a href="${LINKS.about}">About RUBIES</a><a class="btn btn-line" href="/#signup">Sign up</a><a class="btn btn-line" href="/signin">Sign in</a></nav></header>`;
  } else {
    header = `<header class="hd"><div>${brand}</div><nav>${nav}</nav></header>`;
  }
  const ftBrand = `<div class="ft-brand"><a class="brand" href="${STORE}" aria-label="RUBIES">${logo(96)}</a><span>Never stop shining.</span></div>`;
  const footer = mode === 'centre' || mode === 'plain'
    ? `<footer class="ft">${ftBrand}<span>Questions? <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a></span></footer>`
    : `<footer class="ft">${ftBrand}<div class="ft-links"><a href="${LINKS.how}">How RUBIES works</a> · <a href="${LINKS.styles}">Our styles</a> · <a href="${LINKS.sizeGuide}">Size guide</a> · <a href="${LINKS.offer}">Offer details</a> · <a href="${LINKS.terms}">Free pair terms</a>${mode === 'programme' ? ` · <a href="${LINKS.map}">Donation map</a>` : ''}</div>${centre ? `<div class="soft">${esc(centre.name)}${addressLine(centre) ? `, ${esc(addressLine(centre))}` : ''}${centre.website ? ` · <a href="${esc(centre.website)}">${esc(centre.website.replace(/^https?:\/\//, ''))}</a>` : ''}</div>` : ''}</footer>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · RUBIES</title>
<link rel="icon" href="${FAVICON}" type="image/svg+xml">
<link rel="preconnect" href="https://cdn.shopify.com" crossorigin>
<link rel="stylesheet" href="/public/closet.css">
</head>
<body class="${mode}${wide ? ' wide' : ''}">
${banner}
<div class="wrap">
${header}
<main>
${body}
</main>
${footer}
</div>
<script src="/public/closet.js" defer></script>
</body>
</html>`;
}

function addressLine(centre) {
  const a = centre?.address || {};
  return [a.street, a.city, a.region, a.postal].filter(Boolean).join(', ');
}

/** Round colour dots, one per colourway, as the store's product cards show them. */
function swatchesHtml(colours) {
  if (!colours?.length) return '';
  return `<span class="swatches">${colours.map(c => `<span class="swatch" title="${esc(c)}" style="background:${swatch(c)}"></span>`).join('')}</span>`;
}

/**
 * The store's product card: square photo on the light grey ground, the name
 * in uppercase, then a price line (any HTML) beside the swatches.
 */
function productCard(p, { href, price = '', sub = '', swatches = true, id = '' } = {}) {
  const foot = price || swatches ? `<span class="price">${price ? `<span>${price}</span>` : ''}${swatches ? swatchesHtml(p.colours) : ''}</span>` : '';
  return `<a class="product" href="${href}"${id ? ` id="${id}"` : ''}><span class="media"><img src="${img(p.image, 600)}" alt="${esc(p.title)}" loading="lazy" width="300" height="315"></span><span class="body"><span class="name">${esc(p.title)}</span>${foot}${sub ? `<span class="fine">${sub}</span>` : ''}</span></a>`;
}

module.exports = { page, esc, LINKS, addressLine, img, productCard, swatchesHtml, illustration };
