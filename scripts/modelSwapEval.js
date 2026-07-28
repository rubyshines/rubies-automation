#!/usr/bin/env node
/**
 * modelSwapEval — qualify a candidate model against the incumbent on the pinned
 * advisor scenario suite, measuring accuracy, latency, and cost.
 *
 * Built for project_opus5_migration after the 2026-07-28 Opus 5 evaluation was
 * run as throwaway shell. The founder's adoption bar is same-or-better on ALL
 * THREE dimensions, so pass/fail alone is not enough.
 *
 *   node scripts/modelSwapEval.js --candidate claude-opus-5
 *   node scripts/modelSwapEval.js --candidate claude-opus-5 --full-control
 *   node scripts/modelSwapEval.js --candidate claude-opus-5 --only refundNoAmount,noMirroring
 *
 * HOW IT WORKS
 *   1. Runs every scenario against the candidate (bounded concurrency + hard
 *      per-scenario timeout, so one hang cannot stall the suite).
 *   2. Re-runs each candidate FAILURE against the incumbent as a control arm.
 *      This is the load-bearing step: without it you cannot tell a real
 *      regression from order-state drift or a pre-existing failure. On
 *      2026-07-28, two of six candidate failures were pre-existing and would
 *      have been misattributed to the candidate.
 *   3. Reads ai_calls for each arm's time window to report real cost and API
 *      latency (not estimates).
 *
 * Results stream to disk under temp-analysis-data/model-swap-<timestamp>/ so a
 * killed run keeps partial results.
 */
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MODELS } = require('../shared/aiPricing');
const { getSupabaseClient } = require('../shared/supabaseClient');

const ROOT = path.resolve(__dirname, '..');
const SCENARIO_DIR = path.join(ROOT, 'customer-service/test/scenarios');
const SHIM = path.join(__dirname, 'lib/modelSwapShim.js');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { concurrency: 4, timeout: 240, fullControl: false, only: null, repeat: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidate') args.candidate = argv[++i];
    else if (a === '--incumbent') args.incumbent = argv[++i];
    else if (a === '--only') args.only = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--repeat') args.repeat = Number(argv[++i]);
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--full-control') args.fullControl = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

const USAGE = `
modelSwapEval — candidate vs incumbent on the pinned scenario suite

  --candidate <model>   REQUIRED. Model id to qualify (e.g. claude-opus-5)
  --incumbent <model>   Control model. Default: current MODELS.OPUS (${MODELS.OPUS})
  --only <a,b,c>        Run only these scenarios (basename, no .js)
  --repeat <n>          Run each scenario n times per arm (default 1). Advisor
                        drafts are non-deterministic — a scenario can pass one
                        run and fail the next. Use >=3 before trusting a
                        regression call; cost scales linearly.
  --concurrency <n>     Parallel scenarios per arm (default 4)
  --timeout <seconds>   Hard per-scenario timeout (default 240)
  --full-control        Run the incumbent on ALL scenarios, not just candidate
                        failures. Slower and costlier, but gives full-suite
                        latency/cost baselines for the acceptance criteria.
`;

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------
function listScenarios(only) {
  let files = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.js'));
  if (only) {
    const want = new Set(only.map((n) => (n.endsWith('.js') ? n : `${n}.js`)));
    files = files.filter((f) => want.has(f));
    const missing = [...want].filter((w) => !files.includes(w));
    if (missing.length) throw new Error(`No such scenario(s): ${missing.join(', ')}`);
  }
  return files.sort();
}

/**
 * Run one scenario in a child process with the model override applied.
 * Resolves with { name, verdict, failures[], ms } — never rejects.
 */
function runScenario(file, model, timeoutSec, outDir, runIdx = 0) {
  const name = path.basename(file, '.js');
  const started = Date.now();

  return new Promise((resolve) => {
    const nodeOptions = [process.env.NODE_OPTIONS, `--require ${SHIM}`]
      .filter(Boolean).join(' ');

    const child = spawn(process.execPath, [path.join(SCENARIO_DIR, file)], {
      cwd: ROOT,
      env: { ...process.env, MODEL_SWAP_EVAL_MODEL: model, NODE_OPTIONS: nodeOptions },
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutSec * 1000);

    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      const failures = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim());
      let verdict;
      if (signal === 'SIGKILL') verdict = 'TIMEOUT';
      else if (code === 0 && failures.length === 0) verdict = 'PASS';
      else verdict = 'FAIL';

      const suffix = runIdx > 0 ? `.run${runIdx + 1}` : '';
      fs.writeFileSync(path.join(outDir, `${name}${suffix}.log`), out);
      resolve({ name, verdict, failures, ms });
    });
  });
}

/** Run a list of scenarios with bounded concurrency, streaming results. */
async function runArm(label, files, model, args, outRoot) {
  const outDir = path.join(outRoot, label);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n▶ ${label} arm — ${model} (${files.length} scenario${files.length === 1 ? '' : 's'})`);
  const startedAt = new Date().toISOString();
  const results = [];
  const queue = [...files];

  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      // Repeat runs surface flakiness: advisor drafts are non-deterministic, so
      // a single run cannot distinguish a real regression from variance.
      const runs = [];
      for (let i = 0; i < args.repeat; i++) {
        runs.push(await runScenario(file, model, args.timeout, outDir, i));
      }
      const passes = runs.filter((r) => r.verdict === 'PASS').length;
      const r = {
        name: runs[0].name,
        runs: runs.length,
        passes,
        // A scenario only counts as passing if every run passed. Anything in
        // between is FLAKY and must not be read as a clean pass or a clean fail.
        verdict: passes === runs.length ? 'PASS' : passes === 0
          ? (runs.some((x) => x.verdict === 'TIMEOUT') ? 'TIMEOUT' : 'FAIL')
          : 'FLAKY',
        failures: runs.flatMap((x) => x.failures).slice(0, 4),
        ms: Math.round(runs.reduce((s, x) => s + x.ms, 0) / runs.length),
      };
      results.push(r);
      const icon = { PASS: '✓', TIMEOUT: '⏱', FLAKY: '~' }[r.verdict] || '✗';
      const tally = args.repeat > 1 ? ` [${passes}/${runs.length}]` : '';
      console.log(`  ${icon} ${r.name}${tally} (${(r.ms / 1000).toFixed(1)}s avg)`);
      fs.writeFileSync(
        path.join(outRoot, `${label}-results.json`),
        JSON.stringify(results, null, 2),
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, files.length) }, worker),
  );
  const endedAt = new Date().toISOString();
  return { label, model, results, startedAt, endedAt };
}

// ---------------------------------------------------------------------------
// Cost + latency, measured from ai_calls
// ---------------------------------------------------------------------------
async function armMetrics(arm) {
  const supabase = getSupabaseClient();
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('ai_calls')
      .select('cost_usd, duration_ms, input_tokens, output_tokens, model_id, created_at')
      .eq('model_id', arm.model)
      .gte('created_at', arm.startedAt)
      .lte('created_at', arm.endedAt)
      .range(from, from + PAGE - 1);
    if (error) { console.warn(`  [metrics] ai_calls query failed: ${error.message}`); return null; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  if (!rows.length) return null;

  const durations = rows.map((r) => r.duration_ms || 0).sort((a, b) => a - b);
  const p = (q) => durations[Math.min(durations.length - 1, Math.floor(durations.length * q))];
  const totalCost = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  const outTokens = rows.reduce((s, r) => s + (r.output_tokens || 0), 0);

  return {
    calls: rows.length,
    totalCost,
    costPerScenario: totalCost / arm.results.length,
    medianMs: p(0.5),
    p90Ms: p(0.9),
    outTokens,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function fmtMoney(n) { return n == null ? '     —' : `$${n.toFixed(4)}`; }
function fmtMs(n) { return n == null ? '    —' : `${(n / 1000).toFixed(1)}s`; }

function report(candidateArm, controlArm, candMetrics, ctrlMetrics) {
  const byName = new Map(controlArm ? controlArm.results.map((r) => [r.name, r]) : []);

  const failed = candidateArm.results.filter((r) => r.verdict !== 'PASS');
  const regressions = [];
  const preExisting = [];
  for (const r of failed) {
    const ctrl = byName.get(r.name);
    if (!ctrl) continue;
    (ctrl.verdict === 'PASS' ? regressions : preExisting).push({ cand: r, ctrl });
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('ACCURACY');
  console.log('='.repeat(72));
  const passed = candidateArm.results.filter((r) => r.verdict === 'PASS').length;
  console.log(`candidate  ${candidateArm.model}: ${passed}/${candidateArm.results.length} passed`);

  if (regressions.length) {
    console.log(`\n⚠️  ${regressions.length} REGRESSION(S) — candidate fails where incumbent passes:`);
    for (const { cand, ctrl } of regressions) {
      const tally = cand.runs > 1 ? ` [candidate ${cand.passes}/${cand.runs}, incumbent ${ctrl.passes}/${ctrl.runs}]` : '';
      console.log(`   ${cand.verdict === 'FLAKY' ? '~' : '✗'} ${cand.name}${tally}`);
      cand.failures.slice(0, 2).forEach((f) => console.log(`       ${f}`));
    }
    if (regressions.some((r) => r.cand.runs === 1)) {
      console.log('\n   ⚠️  single run per scenario — advisor drafts are non-deterministic.');
      console.log('       Re-run with --repeat 3 before treating these as real.');
    }
  }
  if (preExisting.length) {
    console.log(`\n   ${preExisting.length} pre-existing failure(s) — fail on BOTH arms, not caused by the candidate:`);
    preExisting.forEach(({ cand }) => console.log(`   – ${cand.name}`));
  }
  if (failed.length && !controlArm) {
    console.log('\n   (no control arm run — cannot classify these as regressions)');
  }
  if (!failed.length) console.log('\n✓ no candidate failures');

  if (candMetrics || ctrlMetrics) {
    console.log(`\n${'='.repeat(72)}`);
    console.log('LATENCY + COST  (measured from ai_calls)');
    console.log('='.repeat(72));
    console.log('                        median      p90     $/scenario    calls');
    const row = (label, m) => console.log(
      `  ${label.padEnd(20)} ${fmtMs(m?.medianMs).padStart(7)} ${fmtMs(m?.p90Ms).padStart(8)} ` +
      `${fmtMoney(m?.costPerScenario).padStart(13)} ${String(m?.calls ?? '—').padStart(8)}`,
    );
    row('candidate', candMetrics);
    row('incumbent', ctrlMetrics);

    if (candMetrics && ctrlMetrics) {
      const dLat = ((candMetrics.medianMs - ctrlMetrics.medianMs) / ctrlMetrics.medianMs) * 100;
      const dCost = ((candMetrics.costPerScenario - ctrlMetrics.costPerScenario) / ctrlMetrics.costPerScenario) * 100;
      console.log(`\n  latency: ${dLat >= 0 ? '+' : ''}${dLat.toFixed(1)}%   cost: ${dCost >= 0 ? '+' : ''}${dCost.toFixed(1)}%`);
      if (!controlArm.results.length || controlArm.results.length < candidateArm.results.length) {
        console.log('  NOTE: incumbent arm ran a subset (failures only). Use --full-control');
        console.log('        for a like-for-like latency/cost comparison.');
      }
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('ACCEPTANCE (project_opus5_migration — all three must hold to adopt)');
  console.log('='.repeat(72));
  const accOk = regressions.length === 0;
  const latOk = candMetrics && ctrlMetrics ? candMetrics.medianMs <= ctrlMetrics.medianMs : null;
  const costOk = candMetrics && ctrlMetrics ? candMetrics.costPerScenario <= ctrlMetrics.costPerScenario : null;
  const mark = (b) => (b === null ? '? unmeasured' : b ? '✓ pass' : '✗ fail');
  console.log(`  accuracy same-or-better : ${mark(accOk)}`);
  console.log(`  latency  same-or-faster : ${mark(latOk)}`);
  console.log(`  cost     same-or-cheaper: ${mark(costOk)}`);
  console.log(`\n  VERDICT: ${accOk && latOk && costOk ? 'ADOPT' : 'DO NOT ADOPT'}`);

  return regressions.length;
}

// ---------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.candidate) {
    console.log(USAGE);
    if (!args.help) console.error('error: --candidate is required');
    process.exit(args.help ? 0 : 1);
  }
  const incumbent = args.incumbent || MODELS.OPUS;
  if (incumbent === args.candidate) {
    throw new Error(`candidate and incumbent are both ${incumbent} — nothing to compare`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = path.join(ROOT, 'temp-analysis-data', `model-swap-${stamp}`);
  fs.mkdirSync(outRoot, { recursive: true });

  const files = listScenarios(args.only);
  console.log(`candidate: ${args.candidate}\nincumbent: ${incumbent}\nresults:   ${outRoot}`);

  const candidateArm = await runArm('candidate', files, args.candidate, args, outRoot);

  const failedNames = candidateArm.results
    .filter((r) => r.verdict !== 'PASS')
    .map((r) => `${r.name}.js`);
  const controlFiles = args.fullControl ? files : failedNames;

  let controlArm = null;
  if (controlFiles.length) {
    controlArm = await runArm('control', controlFiles, incumbent, args, outRoot);
  } else {
    console.log('\n▶ control arm skipped — no candidate failures to explain');
  }

  const candMetrics = await armMetrics(candidateArm);
  const ctrlMetrics = controlArm ? await armMetrics(controlArm) : null;

  const regressionCount = report(candidateArm, controlArm, candMetrics, ctrlMetrics);

  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(
    { candidate: args.candidate, incumbent, candidateArm, controlArm, candMetrics, ctrlMetrics },
    null, 2,
  ));
  console.log(`\nfull results: ${outRoot}`);
  process.exit(regressionCount > 0 ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
