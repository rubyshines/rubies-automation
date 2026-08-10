#!/usr/bin/env node

/**
 * Qualify a prompt variant on the pinned scenario suite — the gate any prompt
 * change should clear before it ships. (Built for the lean prompt, which was
 * dropped 2026-08-10; the gate is variant-agnostic and outlived it.)
 *
 * The thing this exists to catch is NOT "did the change fix what we aimed at" —
 * whatever measured that already answered it. It is the opposite failure, and
 * this project has lived it: on 2026-07-28 a prompt fix landed the target
 * metric perfectly
 * (0/10 dropped holds against a 20-60% baseline) while driving a completely
 * different assertion — "reply invents order composition" — from 0/5 to 4/6.
 * Watching only the target would have traded a hold bug for a hallucination in
 * customer-facing text.
 *
 * So this reports PER ASSERTION, not per scenario. Every ✓ and ✗ line the
 * scenarios print is collected across runs and both arms, and the output is
 * ranked by regression: assertions that passed on the current prompt and fail
 * on the variant. A scenario-level pass/fail would hide exactly the swap that
 * bit us before.
 *
 * Repeats are mandatory for the same reason they are in the 2x2 — advisor
 * drafts are non-deterministic and a scenario flips between pass and fail on
 * an unchanged model, so a single run cannot tell a regression from variance.
 *
 * Usage:
 *   node scripts/promptSwapEval.js --variant=no-overrides --repeat=3
 *   node scripts/promptSwapEval.js --variant=no-overrides --repeat=1 --only=noMirroring,refundNoAmount
 *   node scripts/promptSwapEval.js --report        # free, re-reads the saved run
 *
 * --variant is required and must name a variant registered in promptVariants.js.
 * There is deliberately no default: the arm under test is the whole point, and a
 * default silently measures something nobody asked about.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCENARIO_DIR = path.join(ROOT, 'customer-service/test/scenarios');
const SHIM = path.join(__dirname, 'lib/promptVariantShim.js');
const OUT = path.join(ROOT, 'eval/prompt-swap-results.json');
const LOGS = path.join(ROOT, 'eval/prompt-swap-logs');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);

function listScenarios(only) {
  let files = fs.readdirSync(SCENARIO_DIR).filter(f => f.endsWith('.js'));
  if (only) {
    const want = new Set(only.split(',').filter(Boolean).map(n => (n.endsWith('.js') ? n : `${n}.js`)));
    files = files.filter(f => want.has(f));
  }
  return files.sort();
}

/** One scenario, one arm, one run. Never rejects — a crash is a data point. */
function runScenario(file, variant, timeoutSec, runIdx) {
  const name = path.basename(file, '.js');
  return new Promise(resolve => {
    const nodeOptions = [process.env.NODE_OPTIONS, `--require ${SHIM}`].filter(Boolean).join(' ');
    const child = spawn(process.execPath, [path.join(SCENARIO_DIR, file)], {
      cwd: ROOT,
      env: { ...process.env, PROMPT_VARIANT_EVAL: variant, NODE_OPTIONS: nodeOptions },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      fs.mkdirSync(path.join(LOGS, variant), { recursive: true });
      fs.writeFileSync(path.join(LOGS, variant, `${name}.run${runIdx + 1}.log`), out);

      // Every assertion the scenario printed, with its outcome. The text after
      // the marker is the assertion's identity across runs and arms.
      const asserts = out.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('✓') || l.startsWith('✗'))
        .map(l => ({ ok: l.startsWith('✓'), label: l.slice(1).trim() }));

      resolve({
        name,
        crashed: signal === 'SIGKILL' ? 'TIMEOUT' : (code !== 0 && !asserts.length ? 'ERROR' : null),
        asserts,
      });
    });
  });
}

async function runArm(variant, files, repeat, timeout, concurrency) {
  console.log(`\n▶ ${variant} — ${files.length} scenarios x ${repeat} run(s)`);
  const results = [];
  const queue = [];
  for (const f of files) for (let i = 0; i < repeat; i++) queue.push([f, i]);

  let done = 0;
  async function worker() {
    while (queue.length) {
      const [file, i] = queue.shift();
      const r = await runScenario(file, variant, timeout, i);
      done++;
      process.stdout.write(`\r  ${done}/${files.length * repeat}   ${r.name.padEnd(28)}`);
      results.push({ ...r, variant, run: i + 1 });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log('');
  return results;
}

/** assertion label → { control: {pass,n}, variant: {pass,n} } */
function tally(rows, variantName) {
  const map = new Map();
  for (const r of rows) {
    for (const a of r.asserts) {
      const k = `${r.name} :: ${a.label}`;
      if (!map.has(k)) map.set(k, { scenario: r.name, label: a.label, control: { pass: 0, n: 0 }, variant: { pass: 0, n: 0 } });
      const side = r.variant === 'control' ? map.get(k).control : map.get(k).variant;
      side.n++; if (a.ok) side.pass++;
    }
  }
  return map;
}

function report(state) {
  const map = tally(state.rows, state.variant);
  const rate = s => (s.n ? s.pass / s.n : null);
  const rows = [...map.values()].map(r => ({ ...r, cRate: rate(r.control), vRate: rate(r.variant) }));

  const regressions = rows.filter(r => r.cRate != null && r.vRate != null && r.vRate < r.cRate);
  const improvements = rows.filter(r => r.cRate != null && r.vRate != null && r.vRate > r.cRate);
  const onlyControl = rows.filter(r => r.vRate == null);
  const onlyVariant = rows.filter(r => r.cRate == null);

  const f = r => `${r.control.pass}/${r.control.n} → ${r.variant.pass}/${r.variant.n}`;
  const crashes = state.rows.filter(r => r.crashed);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`SCENARIO SUITE — control vs ${state.variant} · ${state.repeat} run(s) each`);
  console.log('='.repeat(78));
  const cAll = rows.reduce((a, r) => a + r.control.pass, 0), cN = rows.reduce((a, r) => a + r.control.n, 0);
  const vAll = rows.reduce((a, r) => a + r.variant.pass, 0), vN = rows.reduce((a, r) => a + r.variant.n, 0);
  console.log(`assertions passing:  control ${cAll}/${cN} (${Math.round(100 * cAll / cN)}%)   ${state.variant} ${vAll}/${vN} (${Math.round(100 * vAll / vN)}%)`);
  if (crashes.length) console.log(`⚠️  ${crashes.length} scenario runs crashed or timed out: ${[...new Set(crashes.map(c => `${c.variant}/${c.name}:${c.crashed}`))].join(', ')}`);

  console.log(`\n--- REGRESSIONS (${regressions.length}) — assertions the variant made WORSE ---`);
  if (!regressions.length) console.log('  none');
  for (const r of regressions.sort((a, b) => (a.vRate - a.cRate) - (b.vRate - b.cRate))) {
    console.log(`  ${(r.cRate === 1 && r.vRate === 0) ? '🔴' : '⚠️ '} ${f(r).padEnd(14)} ${r.scenario} :: ${r.label.slice(0, 90)}`);
  }

  console.log(`\n--- IMPROVEMENTS (${improvements.length}) ---`);
  for (const r of improvements.slice(0, 15)) console.log(`  ✓ ${f(r).padEnd(14)} ${r.scenario} :: ${r.label.slice(0, 90)}`);

  if (onlyControl.length) {
    console.log(`\n--- assertions that only APPEARED on control (${onlyControl.length}) — usually a scenario that died early on the variant ---`);
    for (const r of onlyControl.slice(0, 12)) console.log(`  ? ${r.scenario} :: ${r.label.slice(0, 90)}`);
  }
  if (onlyVariant.length) {
    console.log(`\n--- assertions that only appeared on ${state.variant} (${onlyVariant.length}) ---`);
    for (const r of onlyVariant.slice(0, 12)) console.log(`  ? ${r.scenario} :: ${r.label.slice(0, 90)}`);
  }

  const hard = regressions.filter(r => r.cRate === 1 && r.vRate === 0);
  console.log(`\n--- verdict ---`);
  console.log(`  hard regressions (passed every control run, failed every ${state.variant} run): ${hard.length}`);
  console.log(`  ${hard.length === 0 ? `✅ nothing the suite was watching broke — ${state.variant} is safe to merge on this evidence` : `❌ do NOT merge until these are understood`}`);
}

async function main() {
  if (hasFlag('report')) {
    if (!fs.existsSync(OUT)) throw new Error('no saved run');
    return report(JSON.parse(fs.readFileSync(OUT, 'utf8')));
  }

  const variant = arg('variant', '');
  if (!variant) {
    const { VARIANTS } = require('./promptVariants');
    throw new Error(`--variant is required (registered: ${Object.keys(VARIANTS).filter(v => v !== 'control').join(', ')})`);
  }
  const repeat = parseInt(arg('repeat', '3'), 10);
  const timeout = parseInt(arg('timeout', '300'), 10);
  const concurrency = parseInt(arg('concurrency', '4'), 10);
  const files = listScenarios(arg('only', ''));

  console.log(`${files.length} scenarios · control vs ${variant} · ${repeat} run(s) · concurrency ${concurrency}`);
  console.log(`≈ ${files.length * repeat * 2} scenario runs`);
  if (hasFlag('dry-run')) return console.log(files.map(f => '  ' + f).join('\n'));

  const rows = [
    ...await runArm('control', files, repeat, timeout, concurrency),
    ...await runArm(variant, files, repeat, timeout, concurrency),
  ];
  const state = { variant, repeat, at: new Date().toISOString(), rows };
  fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
  report(state);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
