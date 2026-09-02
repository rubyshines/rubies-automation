const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const intakeParse = require('../dashboard/public/intakeParse');
const {
  splitContactFormSubject,
  pickNickname,
  parseProductVariant,
  parseOrderFormItems,
  isHelpCenterForm,
  splitHelpCenterForm,
  isOrderFormOutput,
} = require('../dashboard/public/intakeParse');

// ---------------------------------------------------------------------------
// Browser wiring. app.js destructures these off `window.intakeParse` at parse
// time, so a missing export or a script-tag ordering slip white-screens the
// whole dashboard — and app.js itself has no test harness to catch it.
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

describe('dashboard wiring', () => {
  it('exposes window.intakeParse when loaded as a plain browser script', () => {
    const sandbox = { window: {} };
    sandbox.self = sandbox.window;
    vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, 'intakeParse.js'), 'utf8'), sandbox);
    assert.ok(sandbox.window.intakeParse, 'intakeParse.js did not attach to window');
    assert.equal(typeof sandbox.window.intakeParse.splitContactFormSubject, 'function');
  });

  it('exports every name app.js destructures off window.intakeParse', () => {
    const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    const m = app.match(/const\s*\{([^}]+)\}\s*=\s*window\.intakeParse;/);
    assert.ok(m, 'app.js no longer destructures window.intakeParse — update this test');
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.equal(typeof intakeParse[name], 'function', `intakeParse.js is missing ${name}`);
    }
  });

  it('loads intakeParse.js before app.js in index.html', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const parseIdx = html.indexOf('/intakeParse.js');
    const appIdx = html.indexOf('/app.js');
    assert.ok(parseIdx !== -1, 'index.html does not load intakeParse.js');
    assert.ok(appIdx !== -1, 'index.html does not load app.js');
    assert.ok(parseIdx < appIdx, 'intakeParse.js must be loaded before app.js');
  });

  it('registers every local script in both of the server freshness lists', () => {
    // The server hashes a hardcoded list of asset files (the "is the frontend
    // fresh" signal) and rewrites a hardcoded list of asset URLs to carry
    // ?v=<hash>. A script missing from either list can be served stale from
    // the browser/PWA cache after a deploy while the rest of the app is fresh.
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'server.js'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]+src="\/([\w.-]+)\.js"/g)].map(m => m[1]);
    assert.ok(scripts.length >= 2, 'expected index.html to load local scripts');

    const assetFiles = server.match(/const assetFiles = \[([^\]]+)\]/);
    assert.ok(assetFiles, 'server.js assetFiles list not found — update this test');
    const rewrite = server.match(/\(\?:([\w|]+)\)\\\.\(\?:js\|css\)/);
    assert.ok(rewrite, 'server.js asset-URL rewrite not found — update this test');

    for (const name of scripts) {
      assert.ok(assetFiles[1].includes(`'${name}.js'`), `${name}.js is missing from server.js assetFiles`);
      assert.ok(rewrite[1].split('|').includes(name), `${name}.js is missing from the server.js asset-URL rewrite`);
    }
  });
});

// ---------------------------------------------------------------------------
// splitContactFormSubject — chat-widget "<subject>\n-----\n<body>" capture
// ---------------------------------------------------------------------------

describe('splitContactFormSubject', () => {
  it('keeps a customer-typed subject that carries the whole request', () => {
    // Ticket 2890: the operator was shown only "No" on a UK delivery/duties
    // question because the subject was blind-stripped as boilerplate.
    const raw = 'How long does it take for orders to arrive in the UK?\n-------------------------------\nNo';
    assert.deepEqual(splitContactFormSubject(raw), {
      subject: 'How long does it take for orders to arrive in the UK?',
      body: 'No',
    });
  });

  it('separates the category chip from the real message', () => {
    const raw = 'Product Question\n-------------------------------\nIs the Sky one-piece lined?';
    assert.deepEqual(splitContactFormSubject(raw), {
      subject: 'Product Question',
      body: 'Is the Sky one-piece lined?',
    });
  });

  it('keeps a multi-line body intact', () => {
    const raw = 'Report Issue\n-----\nHello,\n\nMy payment keeps failing.\nThanks';
    const { subject, body } = splitContactFormSubject(raw);
    assert.equal(subject, 'Report Issue');
    assert.equal(body, 'Hello,\n\nMy payment keeps failing.\nThanks');
  });

  it('returns the message untouched when there is no divider', () => {
    const raw = 'Do you ship to Norway?';
    assert.deepEqual(splitContactFormSubject(raw), { subject: '', body: 'Do you ship to Norway?' });
  });

  it('does not split when the divider has nothing after it', () => {
    // Guard against ever showing a subject with an empty message body.
    const raw = 'Change shipping address\n-----\n';
    assert.deepEqual(splitContactFormSubject(raw), { subject: '', body: 'Change shipping address\n-----' });
  });

  it('only treats the FIRST line as the subject', () => {
    const raw = 'Line one\nLine two\n-----\nBody';
    assert.deepEqual(splitContactFormSubject(raw), { subject: '', body: raw });
  });

  it('handles empty and null input', () => {
    assert.deepEqual(splitContactFormSubject(''), { subject: '', body: '' });
    assert.deepEqual(splitContactFormSubject(null), { subject: '', body: '' });
  });
});

// ---------------------------------------------------------------------------
// pickNickname — product name vs category word
// ---------------------------------------------------------------------------

describe('pickNickname', () => {
  it('picks the product name over a later category word', () => {
    // Regression: 'BIKINI' sits before 'MIA' in the nickname map, so
    // first-key-wins rendered the Mia halter top as "Bikini".
    assert.equal(pickNickname('MIA HALTER BIKINI TOP'), 'Mia');
  });

  it('picks the product name for the other titles that contain BIKINI', () => {
    assert.equal(pickNickname('STELLA HIGH WAISTED SHAPING BIKINI BOTTOM'), 'Stella');
    assert.equal(pickNickname('RUBY NO-TUCK SHAPING BIKINI BOTTOM'), 'Ruby');
    assert.equal(pickNickname('CHEEKY NO-TUCK SHAPING BIKINI BOTTOM'), 'Cheeky');
  });

  it('still falls back to the category word when no product name is present', () => {
    assert.equal(pickNickname('RUBIES BIKINI SET - BIKINI BOTTOM + BIKINI TOP'), 'Bikini');
  });

  it('resolves the remaining catalog titles to their own names', () => {
    assert.equal(pickNickname('AJ NO-TUCK SHAPING UNDERWEAR'), 'AJ');
    assert.equal(pickNickname('AVA SEAMLESS SHAPING BRA'), 'Ava');
    assert.equal(pickNickname('BROOKE SHAPING BRA'), 'Brooke');
    assert.equal(pickNickname('CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR'), 'Charlie');
    assert.equal(pickNickname('FLO SHAPING DANCE UNDERWEAR'), 'Flo');
    assert.equal(pickNickname('NAOMI GAFF EXTRA STRENGTH SHAPING UNDERWEAR'), 'Naomi');
    assert.equal(pickNickname('SASSY NO-TUCK SHAPING UNDERWEAR'), 'Sassy');
    assert.equal(pickNickname('SERENA NO-TUCK SHAPING SHORTY SHORT'), 'Serena');
    assert.equal(pickNickname('SKY NO-TUCK SHAPING ONE-PIECE'), 'Sky');
  });

  it('does not mistake RUBIES for RUBY', () => {
    assert.equal(pickNickname('RUBIES SHAPING CHEST PADS'), 'RUBIES SHAPING CHEST PADS');
  });

  it('returns the raw title when nothing matches', () => {
    assert.equal(pickNickname('MAGICAL SHAPING GEL CHEST PADS'), 'MAGICAL SHAPING GEL CHEST PADS');
    assert.equal(pickNickname('THE QUINN NO-TUCK BOXER SHORTIES'), 'THE QUINN NO-TUCK BOXER SHORTIES');
  });
});

// ---------------------------------------------------------------------------
// parseProductVariant / parseOrderFormItems
// ---------------------------------------------------------------------------

describe('parseProductVariant', () => {
  it('splits name and variant, nicknaming from the name half only', () => {
    assert.deepEqual(
      parseProductVariant('MIA HALTER BIKINI TOP - Black / 1X'),
      { qty: '1', name: 'Mia', variant: 'Black / 1X' }
    );
  });

  it('carries the quantity through', () => {
    assert.deepEqual(
      parseProductVariant('CHEEKY NO-TUCK SHAPING BIKINI BOTTOM - Black / S', '2'),
      { qty: '2', name: 'Cheeky', variant: 'Black / S' }
    );
  });

  it('handles a title with no variant', () => {
    assert.deepEqual(
      parseProductVariant('BROOKE SHAPING BRA'),
      { qty: '1', name: 'Brooke', variant: '' }
    );
  });

  it('takes the LAST dash as the variant separator on hyphenated titles', () => {
    assert.deepEqual(
      parseProductVariant('AJ NO-TUCK SHAPING UNDERWEAR - Sandstone / 2X'),
      { qty: '1', name: 'AJ', variant: 'Sandstone / 2X' }
    );
  });
});

describe('parseOrderFormItems', () => {
  it('parses the chat order form "1x ... - variant" lines', () => {
    const text = '1x THE BROOKE SHAPING BRA - Sandstone / 2X\n2x MIA HALTER BIKINI TOP - Black / 1X';
    assert.deepEqual(parseOrderFormItems(text), [
      { qty: '1', name: 'Brooke', variant: 'Sandstone / 2X' },
      { qty: '2', name: 'Mia', variant: 'Black / 1X' },
    ]);
  });

  it('parses the help-center comma-separated "Item names:" list', () => {
    const text = 'Order: #31505\nItem names: MIA HALTER BIKINI TOP - Black / 1X, CHEEKY NO-TUCK SHAPING BIKINI BOTTOM - Black / S';
    assert.deepEqual(parseOrderFormItems(text), [
      { qty: '1', name: 'Mia', variant: 'Black / 1X' },
      { qty: '1', name: 'Cheeky', variant: 'Black / S' },
    ]);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(parseOrderFormItems(''), []);
    assert.deepEqual(parseOrderFormItems(null), []);
  });
});

// ---------------------------------------------------------------------------
// Existing form detection — pinned so the extraction to a module is behaviour-safe
// ---------------------------------------------------------------------------

describe('isHelpCenterForm / splitHelpCenterForm', () => {
  const form = "I'd like to edit my order\n-----------\nOrder: #31505\nItem names: MIA HALTER BIKINI TOP - Black / 1X";

  it('detects a labelled metadata block behind a divider', () => {
    assert.equal(isHelpCenterForm(form), true);
  });

  it('is not fooled by a bare divider with no metadata labels', () => {
    assert.equal(isHelpCenterForm('Product Question\n-----------\nIs the Sky lined?'), false);
  });

  it('puts the question and metadata on the right sides regardless of order', () => {
    const a = splitHelpCenterForm(form);
    assert.equal(a.question, "I'd like to edit my order");
    assert.match(a.metadata, /^Order: #31505/);

    const flipped = "Order: #31505\nItem names: MIA HALTER BIKINI TOP - Black / 1X\n-----------\nI'd like to edit my order";
    const b = splitHelpCenterForm(flipped);
    assert.equal(b.question, "I'd like to edit my order");
    assert.match(b.metadata, /^Order: #31505/);
  });
});

describe('isOrderFormOutput', () => {
  it('detects the chat order-form output', () => {
    assert.equal(isOrderFormOutput('Order number: #31505\nSelected items: 1x MIA HALTER BIKINI TOP'), true);
    assert.equal(isOrderFormOutput('#31505 - $105.00 - Jul 1'), true);
  });

  it('leaves ordinary customer text alone', () => {
    assert.equal(isOrderFormOutput('My order number is 31505, can you help?'), false);
    assert.equal(isOrderFormOutput(''), false);
  });
});

// ---------------------------------------------------------------------------
// renderEmailText — plain-text email → display HTML for the inbound strip
// ---------------------------------------------------------------------------

describe('renderEmailText', () => {
  const { renderEmailText } = intakeParse;

  it('escapes HTML — a hostile email cannot inject markup', () => {
    const out = renderEmailText('<script>alert(1)</script> & <b>bold</b>');
    assert.ok(!out.includes('<script>'));
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(out.includes('&amp;'));
  });

  it('turns angle-bracketed URLs (the text export of an HTML link) into anchors', () => {
    const out = renderEmailText('Sign our Petition<https://www.subscribepage.io/keeppolitics>');
    assert.ok(out.includes('<a href="https://www.subscribepage.io/keeppolitics" target="_blank" rel="noopener noreferrer">'));
    assert.ok(out.includes('subscribepage.io/keeppolitics</a>'));
    assert.ok(out.includes('Sign our Petition'));
  });

  it('links bare URLs and mailtos', () => {
    const out = renderEmailText('See https://lejag.org/about or write <mailto:info@lejag.org>');
    assert.ok(out.includes('href="https://lejag.org/about"'));
    assert.ok(out.includes('href="mailto:info@lejag.org"'));
    assert.ok(out.includes('>info@lejag.org</a>'));
  });

  it('strips Outlook image placeholders and cid artifacts', () => {
    const out = renderEmailText('[A picture containing logo  Description automatically generated]\n<https://www.tiktok.com/@lejag_lgbt>\n[cid:52b34f72-321a]Hello');
    assert.ok(!out.includes('Description automatically generated'));
    assert.ok(!out.includes('cid:'));
    assert.ok(out.includes('href="https://www.tiktok.com/@lejag_lgbt"'));
    assert.ok(out.includes('Hello'));
  });

  it('shortens very long URLs for display but keeps the full href', () => {
    const long = 'https://example.org/' + 'a'.repeat(120);
    const out = renderEmailText(long);
    assert.ok(out.includes(`href="${long}"`));
    assert.ok(out.includes('…</a>'));
  });

  it('handles empty and null input', () => {
    assert.equal(renderEmailText(''), '');
    assert.equal(renderEmailText(null), '');
  });
});
