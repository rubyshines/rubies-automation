'use strict';
const { STORE } = require('../lib/catalog');

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

/**
 * Every page. `mode` picks the header: public (closet pages), programme (the
 * sign-up site), centre (signed-in private view), plain (account cards).
 */
function page({ title, body, centre, mode = 'public', nav = '', user = null, banner = '', wide = false }) {
  const brand = `<a class="brand" href="${mode === 'centre' ? '/home' : '/'}" aria-label="RUBIES">RUBIES</a>`;
  let header = '';
  if (mode === 'public' && centre) {
    header = `<header class="hd"><div>${brand}<span class="hd-sub">${esc(centre.name)}'s closet</span></div><nav>${nav}</nav></header>`;
  } else if (mode === 'centre') {
    header = `<header class="hd"><div>${brand}<nav class="hd-nav"><a href="/home">Home</a><a href="/history">History</a><a href="/settings">Settings</a></nav></div><div class="hd-user">${esc(centre?.name || '')}${user ? ` · ${esc(user.name || user.email)}` : ''} <a href="/signout">Sign out</a></div></header>`;
  } else if (mode === 'programme') {
    header = `<header class="hd"><div>${brand}</div><nav><a href="/#how">How it works</a><a href="${LINKS.how}">How RUBIES works</a><a class="btn btn-line" href="/#signup">Sign up</a><a class="btn btn-line" href="/signin">Sign in</a></nav></header>`;
  } else {
    header = `<header class="hd"><div>${brand}</div><nav>${nav}</nav></header>`;
  }
  const footer = mode === 'centre' || mode === 'plain'
    ? `<footer class="ft"><span>RUBIES · Never stop shining.</span><span>Questions? <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a></span></footer>`
    : `<footer class="ft"><div><span class="brand-sm">RUBIES</span> · Never stop shining.</div><div class="ft-links"><a href="${LINKS.how}">How RUBIES works</a> · <a href="${LINKS.styles}">Our styles</a> · <a href="${LINKS.sizeGuide}">Size guide</a> · <a href="${LINKS.offer}">Offer details</a> · <a href="${LINKS.terms}">Free pair terms</a>${mode === 'programme' ? ` · <a href="${LINKS.map}">Donation map</a>` : ''}</div>${centre ? `<div class="soft">${esc(centre.name)}${addressLine(centre) ? `, ${esc(addressLine(centre))}` : ''}${centre.website ? ` · <a href="${esc(centre.website)}">${esc(centre.website.replace(/^https?:\/\//, ''))}</a>` : ''}</div>` : ''}</footer>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
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

function wireNote(text) {
  return `<p class="wire-note">${esc(text)}</p>`;
}

function placeholder(label, cls = '') {
  return `<div class="ph ${cls}">${esc(label)}</div>`;
}

module.exports = { page, esc, LINKS, addressLine, wireNote, placeholder };
