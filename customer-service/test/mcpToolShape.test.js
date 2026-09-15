/**
 * Every MCP tool handler must return the content envelope
 * ({ content: [{ type: 'text', text }] }), never a bare string.
 *
 * customer-service/server.js hands a handler's return value straight back to
 * the client, so a handler returning a plain string fails result validation
 * with "expected object, received string". The tool is then unusable from
 * Claude Code while its CLI twin keeps working, and nothing in the build says
 * so: the module parses, imports and unit-tests clean. `preorder_hygiene` and
 * `preorder_update_notice` shipped that way and were only found when someone
 * tried to run them (2026-09-15).
 *
 * Unchecked wiring in the same family as dashboardHandlers.test.js (inline
 * onclick) and lazyRequires.test.js (lazily destructured require): no
 * compile-time reference joins the handler to the protocol, so a cheap static
 * assertion stands in for one.
 *
 * Run: node --test customer-service/test/mcpToolShape.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOOLS_DIR = path.join(__dirname, '..', 'lib', 'tools');

// From an opening bracket to just past its match.
function matchBracket(src, from) {
  const open = src[from];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Body of `function NAME(...) { ... }`. The parameter list is skipped by
// bracket matching: a destructured signature (`function f({ a } = {})`) puts a
// brace before the body, and naive scanning reads that pattern as the function.
function functionBody(src, name) {
  const m = src.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'));
  if (!m) return null;
  const parenAt = src.indexOf('(', src.indexOf(m[0]));
  const afterParams = matchBracket(src, parenAt);
  if (afterParams === -1) return null;
  const open = src.indexOf('{', afterParams);
  if (open === -1) return null;
  const end = matchBracket(src, open);
  return end === -1 ? null : src.slice(open + 1, end - 1);
}

// Handlers written inline as `handler: async (args) => { ... }`.
function inlineHandlerBodies(src) {
  const out = [];
  for (const m of src.matchAll(/handler:\s*(?:async\s*)?\(/g)) {
    const parenAt = src.indexOf('(', m.index);
    const afterParams = matchBracket(src, parenAt);
    if (afterParams === -1) continue;
    if (!/^\s*=>\s*\{/.test(src.slice(afterParams, afterParams + 12))) continue;
    const open = src.indexOf('{', afterParams);
    const end = matchBracket(src, open);
    if (end !== -1) out.push(src.slice(open + 1, end - 1));
  }
  return out;
}

// Names defined in this file that build the envelope, e.g.
//   const text = (t) => ({ content: [{ type: 'text', text: t }] });
//   function ok(text) { return { content: [...] }; }
function envelopeHelpers(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*=>\s*\(?\s*\{\s*content\s*:/g)) names.add(m[1]);
  for (const m of src.matchAll(/function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{\s*return\s*\{\s*content\s*:/g)) names.add(m[1]);
  return names;
}

// Every `return X` in a body. Nesting is deliberately not modelled: the
// assertion is "at least one return builds an envelope", which a string
// returned from a `.map()` callback inside the body can neither satisfy nor
// break.
function returnExpressions(body) {
  const out = [];
  for (const m of body.matchAll(/\breturn\b/g)) {
    let j = m.index + 6;
    let depth = 0;
    let expr = '';
    while (j < body.length) {
      const ch = body[j];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      if (ch === ')' || ch === '}' || ch === ']') depth--;
      if (depth < 0) break;
      if (ch === ';' && depth === 0) break;
      expr += ch;
      j++;
    }
    if (expr.trim()) out.push(expr.trim());
  }
  return out;
}

describe('every MCP tool handler returns the content envelope, not a bare string', () => {
  const offenders = [];
  let handlersChecked = 0;

  for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    const helpers = envelopeHelpers(src);

    // Does this expression build, or delegate to something that builds, the
    // envelope? A call into another module cannot be resolved statically, so
    // it is allowed unless its name advertises that it renders text — which is
    // exactly the shape of the bug this catches.
    const enveloped = (expr) => {
      if (/\bcontent\s*:/.test(expr)) return true;
      const call = expr.match(/^(?:await\s+)?([A-Za-z0-9_]+)\s*\(/);
      if (!call) return false;
      if (helpers.has(call[1])) return true;
      if (/(Markdown|Text|String|Summary|Report)$/.test(call[1])) return false;
      const inner = functionBody(src, call[1]);
      if (inner !== null) return returnExpressions(inner).some((r) => /\bcontent\s*:/.test(r));
      return true;
    };

    const bodies = [];
    for (const m of src.matchAll(/handler:\s*([A-Za-z0-9_]+)\s*,/g)) {
      if (m[1] === 'async') continue;
      const body = functionBody(src, m[1]);
      if (body !== null) bodies.push([m[1], body]);
    }
    for (const body of inlineHandlerBodies(src)) bodies.push(['(inline)', body]);

    for (const [name, body] of bodies) {
      const returns = returnExpressions(body);
      if (!returns.length) continue;
      handlersChecked++;
      if (!returns.some(enveloped)) {
        offenders.push(`${file} :: ${name} never builds the envelope — returns ${JSON.stringify(returns.map((r) => r.slice(0, 50)).slice(0, 3))}`);
      }
    }
  }

  it('finds enough handlers to be testing something', () => {
    // A static scan that silently matches nothing stays green forever while
    // asserting nothing — the same self-check dashboardHandlers.test.js carries.
    assert.ok(handlersChecked > 80, `only ${handlersChecked} handlers scanned — the scan is broken, not the code`);
  });

  it('has no handler that never builds the envelope', () => {
    assert.deepEqual(offenders, [], `MCP handlers returning a bare string:\n  ${offenders.join('\n  ')}`);
  });
});
