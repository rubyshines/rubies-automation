const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Every handler wired into the dashboard UI must actually exist.
 *
 * `sendComposedDraft` — the Send button on a message the operator wrote
 * themselves — was deleted by an unrelated commit and shipped broken for twelve
 * days. Clicking Send threw ReferenceError, and because the compose step is what
 * persists the text, a failed send plus a refresh destroyed the message.
 *
 * Nothing caught it: the button rendered, the endpoint existed, the service
 * function existed, the tests passed. Only the one line joining them was gone.
 * A static check is the cheapest possible guard for that whole class — an inline
 * handler is a call into global scope with no import to break and no bundler to
 * complain.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

const HANDLER_ATTR = /on(?:click|change|input|keydown|keyup|submit|focus|blur)\s*=\s*["'`]?([a-zA-Z0-9_$]+)\s*\(/g;
const FN_DECL = /^(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/gm;
const FN_EXPR = /^(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()/gm;

// Reserved words that can precede a paren inside a template literal and look
// like a handler name to the regex above.
const NOT_HANDLERS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof']);

function readAll(dir, ext) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

test('every inline handler in the dashboard resolves to a defined function', () => {
  const js = readAll(PUBLIC_DIR, '.js');
  const html = readAll(PUBLIC_DIR, '.html');

  const defined = new Set();
  for (const m of js.matchAll(FN_DECL)) defined.add(m[1]);
  for (const m of js.matchAll(FN_EXPR)) defined.add(m[1]);

  const missing = new Set();
  for (const m of (js + '\n' + html).matchAll(HANDLER_ATTR)) {
    const name = m[1];
    if (NOT_HANDLERS.has(name) || defined.has(name)) continue;
    missing.add(name);
  }

  assert.deepEqual([...missing], [],
    `handlers wired into the UI with no function behind them: ${[...missing].join(', ')}`
    + ' — clicking these throws ReferenceError at runtime');
});

test('the guard can actually see a missing handler', () => {
  // Without this, a regex that silently matched nothing would keep the test
  // above green forever while checking exactly zero handlers.
  const js = readAll(PUBLIC_DIR, '.js');
  const found = [...js.matchAll(HANDLER_ATTR)].map(m => m[1]);
  assert.ok(found.length > 20, `expected to find many wired handlers, found ${found.length}`);
  assert.ok(found.includes('sendComposedDraft'), 'the regression case itself should be covered');
});
