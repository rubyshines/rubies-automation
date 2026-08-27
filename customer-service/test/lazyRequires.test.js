const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A destructured `require` inside a function body is wiring with no
 * compile-time reference, the same class the dashboard's inline `onclick`
 * handlers are in — and it fails the same way: the file is valid, the suite is
 * green, and the name is `undefined` until the one line that calls it runs.
 *
 * It cost three unanswered follow-ups on 2026-08-27. `replyGuard` in
 * `autoFollowUp.js` lazily required `getCompanyEmails` from `queueService`,
 * which defines it and never exported it. The resulting TypeError landed inside
 * the guard's own catch, which is written to FAIL CLOSED — so every scheduled
 * follow-up was held, forever, with a message ("could not resolve addresses to
 * check") that reads exactly like Gmail being unreachable. A guard that can
 * never pass is indistinguishable from a queue with nothing due, which is the
 * failure this whole subsystem keeps hitting.
 *
 * Lazy requires are load-bearing here — they break the cycles between
 * queue/cadence/queueService and keep the webhook server's startup cheap — so
 * the answer is not to stop using them but to assert the names resolve.
 */
const ROOT = path.join(__dirname, '..', '..');

// Everything with lazily-required internal wiring. Extend rather than
// generalise to the repo root: a directory added here must actually be safe to
// `require` at test time (no side effects at module load).
const DIRS = ['b2b-outreach', 'customer-service/lib', 'reports/lib', 'lib', 'webhooks'];

const DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Comments hold example paths and prose; neither is a require. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function collectBindings() {
  const found = [];
  for (const dir of DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(DESTRUCTURE)) {
        const names = m[1]
          .split(',')
          .map(s => s.split(':')[0].split('=')[0].trim())
          .filter(n => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
        for (const name of names) {
          found.push({ file, spec: m[2], name });
        }
      }
    }
  }
  return found;
}

test('every destructured internal require resolves to a real export', () => {
  const bindings = collectBindings();

  // A regex that silently matches nothing stays green forever while testing
  // zero things. The repo had ~1,000 of these when this was written.
  assert.ok(
    bindings.length > 500,
    `expected hundreds of destructured requires, found ${bindings.length} — the scanner has stopped matching`,
  );

  const missing = [];
  for (const { file, spec, name } of bindings) {
    let mod;
    try {
      mod = require(path.resolve(path.dirname(file), spec));
    } catch (err) {
      missing.push(`${path.relative(ROOT, file)}: require('${spec}') failed — ${err.message.split('\n')[0]}`);
      continue;
    }
    if (!(name in mod)) {
      missing.push(`${path.relative(ROOT, file)}: { ${name} } is not exported by '${spec}'`);
    }
  }

  assert.deepEqual(missing, [], `unresolvable require bindings:\n  ${missing.join('\n  ')}`);
});

test('the follow-up reply guard can resolve a company\'s addresses', () => {
  // The specific line that broke, pinned: replyGuard's first act is to look up
  // who this send would reach, and it cannot run at all if that name is absent.
  const { getCompanyEmails } = require('../../b2b-outreach/lib/queueService');
  assert.equal(typeof getCompanyEmails, 'function');
});
