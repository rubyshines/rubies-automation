'use strict';
// The hi-fi pass: every user-facing surface of the Virtual Closet (pages and
// emails) carries the rubyshines.com design system and nothing left over from
// the wireframe stage. The operator screens live in the CS dashboard and are
// not covered here on purpose.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MENU, SIZES } = require('../../virtual-closet/lib/catalog');
const money = require('../../virtual-closet/lib/money');
const brand = require('../../virtual-closet/lib/brand');
const closetView = require('../../virtual-closet/views/closet');
const programmeView = require('../../virtual-closet/views/programme');
const requestView = require('../../virtual-closet/views/request');
const centreView = require('../../virtual-closet/views/centre');

const centre = { id: 1, slug: 'demo', name: 'Demo Centre', sizes: SIZES, kids_sizes: false, items_per_request: 2, requests_per_year: 2, goal_cents: 30000, approval_mode: 'automatic', ship_to_door: true, programmes: { closet: true, pass_it_on: true }, address: { city: 'Champaign' }, website: 'https://example.org', logo_url: 'https://example.org/logo.png' };
const sum = { number: 2, raised: 14000, goal: 30000, funded: false, over: 0, state: 'in_progress', box: { id: 9, number: 2 }, sources: money.sourcesCents([{ kind: 'sponsor', amount_cents: 14000 }]), requests: [], approvedCount: 0, waitingCount: 0, ledger: [] };
const user = { id: 1, name: 'Ash', email: 'ash@example.org' };

const WIREFRAME = /class="ph\b|wire-note|placeholder\(|\[Centre logo\]|hi-fi pass/;

test('the stylesheet is the store\'s: its fonts, its colours, square buttons, no wireframe tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../virtual-closet/public/closet.css'), 'utf8');
  assert.ok(css.includes('font-family: "Fixel Display"'), 'Fixel Display is declared');
  assert.ok(css.includes('Motter Corpus Std'), 'the display face is declared');
  for (const c of ['#310C48', '#FB00FF', '#2000A0', '#F3F3F3', '#121212']) assert.ok(css.includes(c), `${c} is in the palette`);
  assert.ok(!/\.ph\b|wire-note|#222\b|#e8e8e8/i.test(css), 'wireframe tokens are gone');
  assert.match(css, /\.btn\s*{[^}]*border-radius:\s*0/, 'buttons are square');
  assert.match(css, /\.chip\s*{[^}]*border-radius:\s*40px/, 'chips are the site\'s pills');
  assert.match(css, /\.bar > span\s*{[^}]*var\(--magenta\)/, 'the progress bar is the one magenta element');
});

test('every public page carries the logo and real product photography, no placeholders', () => {
  const closet = lead => closetView.render({ centre, sum, lastSent: null, products: MENU, lead, words: ['A sentence.'], paused: false });
  const pages = {
    'closet default': closet('default'), 'closet shop': closet('shop'), 'closet request': closet('request'), 'closet sponsor': closet('sponsor'),
    programme: programmeView.programme(), signin: programmeView.signin(), account: programmeView.accountStep({ centre }),
    request: requestView.form({ centre, products: MENU }), style: requestView.styleSheet({ centre, style: MENU[0] }),
    home: centreView.home({ centre, user, role: 'admin', sum, lastSent: null, requests: [], month: { visits: 0, orders: 0, sponsors: 0, requests: 0 }, share: { links: [{ url: 'http://x/demo', note: 'plain' }], post: 'p' }, passItOn: { routed: 0, mapVisits: 0 }, filter: 'all', notCollected: [] }),
    settings: centreView.settings({ centre, user, role: 'admin', team: { members: [user], invites: [] } }),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(html.includes('/public/rubies-logo.svg'), `${name}: the wordmark is in the header`);
    assert.ok(html.includes(brand.FAVICON), `${name}: favicon`);
    assert.ok(!WIREFRAME.test(html), `${name}: no wireframe leftovers`);
    assert.ok(!/undefined|NaN|\[object/.test(html), `${name}: nothing leaked`);
  }
  for (const p of MENU) assert.ok(pages['closet default'].includes(p.image.split('?')[0]), `${p.key}: store photo on the closet page`);
  assert.ok(pages['closet default'].includes('class="swatch"'), 'colourway swatches on the cards');
  assert.ok(pages['closet default'].includes('<i>closet</i>'), 'one display word in the heading, the site\'s way');
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(!/<h[23][^>]*>[^<]*<i>/.test(html), `${name}: the display word lives in the H1 only`);
    assert.ok(!/Cards link to the store|No prices here|Who RUBIES is:/.test(html), `${name}: no designer notes in the copy`);
  }
  assert.ok(pages['closet default'].includes(brand.ILLUSTRATIONS.mirror.src), 'the closet hero is the store\'s illustration');
  assert.ok(pages['closet default'].includes('<h2>About RUBIES</h2>'), 'About RUBIES is a real block on the closet page');
  assert.ok(pages['closet default'].indexOf('<h2>About RUBIES</h2>') < pages['closet default'].indexOf('<h2>How it works</h2>'), 'About sits above How it works');
  assert.ok(pages.programme.includes(brand.ILLUSTRATIONS.beach.src), 'the programme hero is the beach illustration');
  assert.ok(pages.request.indexOf('id="request-form"') < pages.request.indexOf('<h2>Our styles</h2>'), 'the request form comes before the style grid');
  assert.ok(pages.request.includes('data-style-thumb'), 'each item row shows the chosen style');
  assert.ok(pages['closet default'].includes('class="centre-logo"'), 'the centre\'s own logo when it has one');
  assert.ok(pages.style.includes(MENU[0].image.split('?')[0]), 'the style sheet shows the product');
  assert.ok(pages['closet default'].includes('width=600'), 'photos are sized through the CDN');
});

test('every menu style has a store photo on the Shopify CDN and every colourway a swatch', () => {
  for (const p of MENU) {
    assert.match(p.image, /^https:\/\/cdn\.shopify\.com\//, `${p.key} image`);
    for (const c of p.colours) assert.notEqual(brand.swatch(c), brand.COLOURS.grey, `${c} has a swatch colour`);
  }
  assert.equal(brand.swatch('Not A Colour'), brand.COLOURS.grey, 'unknown colourways fall back to the card ground');
});

test('emails wear the brand: hosted logo, purple text, square near-black button, links in the site\'s blue', () => {
  const emails = require('../../virtual-closet/lib/emails');
  const html = emails.layout('Hello there', '<p>Body with <a href="https://rubyshines.com/x">a link</a>.</p>' + emails.btn('https://rubyshines.com/go', 'Go') + emails.btns([['https://a', 'Approve'], ['https://d', 'Decline']]), '<a href="https://rubyshines.com/c">Closet</a>');
  assert.ok(html.includes(brand.LOGO_PNG), 'the pink/green wordmark PNG from the CDN');
  assert.ok(html.includes(`color:${brand.COLOURS.ink}`), 'purple text');
  assert.ok(html.includes(`border-top:4px solid ${brand.COLOURS.magenta}`), 'the magenta rule');
  assert.ok(html.includes(`background:${brand.COLOURS.black};color:${brand.COLOURS.white}`), 'primary button');
  assert.ok(html.includes(`background:${brand.COLOURS.white};color:${brand.COLOURS.black}`), 'secondary button beside it');
  assert.ok(html.includes(`<a href="https://rubyshines.com/x" style="color:${brand.COLOURS.blue}">`), 'plain links get the site\'s link colour');
  assert.ok(html.includes(`<a href="https://rubyshines.com/c" style="color:${brand.COLOURS.soft}">`), 'footer links are soft');
  assert.ok(!/#222|#666|#ddd|#f6f6f6|system-ui/.test(html), 'no wireframe greys or system font');
  assert.ok(html.includes("font-family:'Fixel Display', Assistant"), 'the font stack sits inside the style attribute without breaking it');
  assert.ok(!/style="[^"]*"[^">]*"[^>]*>/.test(html.replace(/<a href="[^"]*" style="[^"]*">/g, '')), 'no style attribute is cut short by a quote');
  assert.ok(html.includes('Never stop shining.'));
});
