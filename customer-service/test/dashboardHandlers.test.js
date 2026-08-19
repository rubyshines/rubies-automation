const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The dashboard's front end has no compiler and no module graph. A call to a
 * function that does not exist is a perfectly valid file that throws
 * ReferenceError the moment a human touches the thing.
 *
 * It has bitten twice in two days:
 *   - `sendComposedDraft` (the Send button for a message you wrote yourself) was
 *     deleted as collateral in an unrelated commit and shipped broken for twelve
 *     days. Composing is what PERSISTS the text, so a click plus a refresh
 *     destroyed the message.
 *   - `loadOutreach()` was written by hand when the pause controls were added.
 *     The real function is `loadOutreachSidebar`. Pausing worked and then threw,
 *     so the operator saw a failure message for an action that had succeeded.
 *
 * Neither is reachable by any other test: the button renders, the endpoint
 * exists, the service function exists, the suite passes. Only the line joining
 * them is wrong. These two checks are the cheapest thing that covers the class.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

const HANDLER_ATTR = /on(?:click|change|input|keydown|keyup|submit|focus|blur)\s*=\s*["'`]?([a-zA-Z0-9_$]+)\s*\(/g;
// Not anchored to line start: this must also catch named function expressions
// like `addEventListener('x', function initLightbox() {...})`.
const FN_DECL = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
const FN_EXPR = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()/g;
// Object method shorthand — `delta(text) {` is character-for-character a call
// followed by a block, so without this every method definition reads as a call
// to something undefined.
const METHOD_SHORTHAND = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^()]*\)\s*\{/g;
const BARE_CALL = /(^|[^.\w$'"`])([a-z][A-Za-z0-9_$]*)\s*\(/g;

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new',
  'delete', 'void', 'do', 'else', 'in', 'of', 'instanceof', 'yield', 'throw', 'var', 'let',
  'const', 'case', 'with', 'super', 'this', 'import', 'export', 'async',
]);

// Browser globals node does not have. Kept short on purpose: every addition is a
// hole in the check, so prefer defining a real function over widening this.
const BROWSER_GLOBALS = new Set([
  'alert', 'confirm', 'prompt', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'getComputedStyle',
  'scrollTo', 'open', 'close', 'blur', 'focus', 'print', 'atob', 'btoa', 'matchMedia', 'createImageBitmap',
]);

/** Remove comments and string/template bodies so prose cannot look like code. */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""');
}

function loadPublicJs() {
  const files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.js'));
  const defined = new Set();
  const params = new Set();
  let code = '';
  let source = '';
  for (const f of files) {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
    for (const m of raw.matchAll(FN_DECL)) defined.add(m[1]);
    for (const m of raw.matchAll(FN_EXPR)) defined.add(m[1]);
    for (const m of raw.matchAll(METHOD_SHORTHAND)) defined.add(m[1]);
    // Single-parameter arrows without parens: `new Promise(resolve => ...)`.
    for (const m of raw.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) params.add(m[1]);
    // Parameter names and locally-bound callbacks can be invoked as bare
    // identifiers; collect them so they are not reported as missing.
    for (const m of raw.matchAll(/(?:function\s*[A-Za-z0-9_$]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/g)) {
      for (const p of m[1].split(',')) {
        // Strip leading punctuation: on `new Promise((resolve, reject) => {` the
        // capture starts inside the outer call, so the first name arrives as
        // "(resolve".
        const name = p.trim().split(/[=:\s]/)[0].replace(/^[^A-Za-z_$]+/, '');
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) params.add(name);
      }
    }
    for (const m of raw.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) params.add(m[1]);
    code += stripNonCode(raw) + '\n';
    source += raw + '\n';
  }
  // Two views, and using the wrong one silently checks nothing. Inline handlers
  // live INSIDE template literals (the panel renders HTML as strings), so they
  // only exist in `source`; bare calls need `code`, where prose and string
  // contents cannot masquerade as identifiers.
  return { files, defined, params, code, source };
}

test('every inline handler in the dashboard resolves to a defined function', () => {
  const { defined, source } = loadPublicJs();
  const html = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))
    .map(f => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')).join('\n');

  const missing = new Set();
  for (const m of (source + '\n' + html).matchAll(HANDLER_ATTR)) {
    if (!KEYWORDS.has(m[1]) && !defined.has(m[1])) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [],
    `handlers wired into the UI with no function behind them: ${[...missing].join(', ')}`);
});

test('no dashboard code calls a function that does not exist', () => {
  const { defined, params, code } = loadPublicJs();
  const missing = new Set();
  for (const m of code.matchAll(BARE_CALL)) {
    const name = m[2];
    if (KEYWORDS.has(name) || BROWSER_GLOBALS.has(name)) continue;
    if (defined.has(name) || params.has(name)) continue;
    if (typeof globalThis[name] === 'function') continue;
    missing.add(name);
  }
  assert.deepEqual([...missing].sort(), [],
    `called but never defined: ${[...missing].sort().join(', ')}`
    + ' — these throw ReferenceError when the code path runs');
});

/**
 * Same class as the handler checks: a nav badge is a `<span>` in the markup and
 * a write in the poll, joined by a string id that nothing verifies. Outreach
 * shipped with neither half, and Free Swimwear and Reviews shipped with a span
 * that only their own tab filled — so the number was blank until you opened the
 * tab, which is the one moment you no longer need it.
 */
test('every nav badge is filled by the background stats poll, and vice versa', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  const inMarkup = new Set([...html.matchAll(/id="tab-count-([a-z]+)"/g)].map(m => m[1]));
  const filledByPoll = new Set([...app.matchAll(/setTabCount\('([a-z]+)'/g)].map(m => m[1]));

  assert.deepEqual([...inMarkup].sort(), [...filledByPoll].sort(),
    'a badge nobody fills reads as "nothing to do" forever, and a write to an id '
    + 'that is not in the nav is silently dropped');
});

test('the guards can actually see something', () => {
  // A regex that silently matched nothing would keep both tests above green
  // forever while checking exactly zero things.
  const { defined, code, source } = loadPublicJs();
  assert.ok(defined.size > 200, `expected many defined functions, found ${defined.size}`);
  assert.ok([...source.matchAll(HANDLER_ATTR)].length > 20, 'expected many wired handlers');
  assert.ok([...code.matchAll(BARE_CALL)].length > 200, 'expected many bare calls to check');
  assert.ok(defined.has('sendComposedDraft'), 'the first regression case should be covered');
  assert.ok(defined.has('loadOutreachSidebar'), 'the second regression case should be covered');

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok([...html.matchAll(/id="tab-count-([a-z]+)"/g)].length >= 5,
    'the badge check needs badges to find, or it passes on an empty set');
});
