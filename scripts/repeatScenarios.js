#!/usr/bin/env node
/**
 * Run named pinned scenarios N times each and tabulate per-assertion pass rates.
 *
 * Advisor scenarios are non-deterministic (domain_cs.md: "a single run proves
 * nothing"), so every accuracy claim needs --repeat 3 and a mixed result is
 * FLAKY, not a pass. promptSwapEval.js does this for a two-arm prompt A/B; this
 * is the one-arm equivalent for "did my change break anything".
 *
 * It also reports a scenario that produced NO assertions, which is how the two
 * warehouse_hold scenarios were found dead in 2026-08: their anchor orders had
 * shipped, so each printed "⊘ SKIP" and exited 0 while measuring nothing.
 * A zero exit code is not evidence a scenario ran.
 *
 * Usage: node scripts/repeatScenarios.js 3 exchangeMoney donationToolCall
 */
const { execFile } = require('child_process');
const path = require('path');

const repeat = Number(process.argv[2] || 3);
const names = process.argv.slice(3);

function runOnce(name) {
  return new Promise((resolve) => {
    const file = path.join(__dirname, '..', 'customer-service', 'test', 'scenarios', `${name}.js`);
    execFile('node', [file], { maxBuffer: 40 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const asserts = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*([✓✗])\s+(.*)$/);
        if (m) asserts.push({ ok: m[1] === '✓', label: m[2].trim() });
      }
      resolve({ asserts, crashed: !asserts.length, out });
    });
  });
}

(async () => {
  const results = {};
  for (const name of names) {
    results[name] = [];
    for (let i = 0; i < repeat; i++) {
      process.stderr.write(`  ${name} run ${i + 1}/${repeat}...\n`);
      results[name].push(await runOnce(name));
    }
  }

  console.log('\n================ per-assertion results ================\n');
  let anyFail = false, anyFlaky = false;
  for (const [name, runs] of Object.entries(results)) {
    console.log(`### ${name}`);
    const crashed = runs.filter(r => r.crashed).length;
    if (crashed) { console.log(`  !! ${crashed}/${runs.length} runs produced no assertions`); anyFail = true; }
    // Assertion labels vary slightly between runs (they interpolate values), so
    // key on a normalised prefix.
    const key = l => l.replace(/[:(].*$/, '').trim();
    const tally = new Map();
    for (const r of runs) {
      for (const a of r.asserts) {
        const k = key(a.label);
        const t = tally.get(k) || { pass: 0, fail: 0 };
        a.ok ? t.pass++ : t.fail++;
        tally.set(k, t);
      }
    }
    for (const [label, t] of tally) {
      const verdict = t.fail === 0 ? 'PASS' : t.pass === 0 ? 'FAIL' : 'FLAKY';
      if (verdict === 'FAIL') anyFail = true;
      if (verdict === 'FLAKY') anyFlaky = true;
      console.log(`  ${verdict.padEnd(5)} ${t.pass}/${t.pass + t.fail}  ${label}`);
    }
    console.log('');
  }
  console.log(anyFail ? 'RESULT: failures present' : anyFlaky ? 'RESULT: no hard failures, some flaky' : 'RESULT: all green');
})();
