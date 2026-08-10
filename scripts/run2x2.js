#!/usr/bin/env node

/**
 * The 2x2: {Opus 4.8, Opus 5} x {current prompt, lean prompt}.
 *
 * The July rejection of Opus 5 is not trustworthy — it ran against a prompt
 * tuned to 4.8 for months, on a scenario suite documented as flaky on both
 * models, first pass only. The diagnostic here is the INTERACTION: if Opus 5
 * only loses on the current prompt, its regressions were prompt artifacts
 * rather than model regressions, and the July verdict was measuring the wrong
 * thing.
 *
 * Design choices that are load-bearing:
 *
 * - ARMS ARE INTERLEAVED PER CASE, not run one after another. Replay reads
 *   TODAY's order state, so a July ticket sees today's fulfillment. That drift
 *   is acceptable ONLY while it is shared: running all four arms on a case
 *   back to back keeps it a common confound instead of a differential one.
 *   Running arm A this hour and arm D next hour would silently attribute a
 *   shipped order to a prompt.
 *
 * - THREE REPEATS, and no conclusion from fewer. The same scenario flips pass
 *   to fail on an unchanged model; temperature is not settable. This project
 *   already learned it the expensive way — run 1 of the carve-out test looked
 *   like a clean win (5/21 vs 9/21) and runs 2 and 3 came back dead even.
 *
 * - THE JUDGE MODEL IS PINNED and never follows the arm. The scoring
 *   instrument has to be the same instrument in all four cells, or the
 *   comparison measures the judge.
 *
 * - STEER IS NEVER REPLAYED. The defect is what the advisor writes unprompted;
 *   feeding it Jamie's correction would hide exactly the behaviour under test.
 *
 * - RESULTS ARE WRITTEN AFTER EVERY DRAFT so a crash costs minutes, not the
 *   run, and --resume picks up where it stopped.
 *
 * Usage:
 *   node scripts/run2x2.js --check            # replayability + cost estimate, no spend
 *   node scripts/run2x2.js --repeat=1         # one pass over all cases and arms
 *   node scripts/run2x2.js --repeat=3 --resume
 *   node scripts/run2x2.js --judge            # judge whatever has been drafted
 *   node scripts/run2x2.js --report           # free, re-reads the saved run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const pricing = require('../shared/aiPricing');
const { MODELS } = pricing;

// Captured BEFORE any arm mutates it. The judge and the cost lookup both use
// this, so neither can drift with the arm under test.
const BASELINE_MODEL = MODELS.OPUS;
const CANDIDATE_MODEL = 'claude-opus-5';
const JUDGE_MODEL = BASELINE_MODEL;

const { setPromptTransform, aiAdvisor } = require('../customer-service/lib/aiAdvisor');
const { apply } = require('./promptVariants');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { buildTurns } = require('./replayTurns');
const { judgeDraft } = require('../eval/judge');
const CASES = require('../eval/cases2x2');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
const words = t => norm(t).split(/\s+/).filter(Boolean).length;

// Sharded across PROCESSES, never threads. `setPromptTransform` and the model
// override are module-level globals, so two arms running concurrently inside
// one process would race — arm A's prompt transform could serve arm B's call
// and the result would be silently, unfalsifiably wrong. A child process per
// shard gives each its own module state. Each shard owns whole CASES, so all
// four arms of a case still run back to back and order-state drift stays a
// shared confound.
//
// Worth the trouble: a draft takes ~3 minutes, of which only ~25s is the API.
// The rest is context building against Shopify, which is I/O and parallelises
// cleanly. Serial, 240 drafts is ~12 hours; at 6 shards it is under two.
const SHARD = arg('shard', '');
const OUT = path.resolve(__dirname, SHARD ? `../eval/2x2-results.shard${SHARD.split('/')[0]}.json` : '../eval/2x2-results.json');
const SHARD_GLOB = n => path.resolve(__dirname, `../eval/2x2-results.shard${n}.json`);

const ARMS = [
  { id: '4.8/current', model: BASELINE_MODEL, variant: 'control' },
  { id: '4.8/lean', model: BASELINE_MODEL, variant: 'lean' },
  { id: 'o5/current', model: CANDIDATE_MODEL, variant: 'control' },
  { id: 'o5/lean', model: CANDIDATE_MODEL, variant: 'lean' },
];

const GROUPS = ['act_vs_ask', 'padding', 'wholesale_rewrite'];
const groupOf = id => GROUPS.find(g => CASES[g].includes(id)) || 'unknown';

// ---------------------------------------------------------------------------

async function turnForDraft(sb, draftId) {
  const { data: d } = await sb.from('cs_ai_drafts').select('ticket_id').eq('id', draftId).single();
  if (!d?.ticket_id) return null;
  const [{ data: ticket }, { data: drafts }] = await Promise.all([
    sb.from('cs_tickets').select('id,conversation_history').eq('id', d.ticket_id).single(),
    sb.from('cs_ai_drafts')
      .select('id,created_at,draft_response,sent_response,intake_state,order_context,operator_steer,draft_history,customer_email,customer_name,order_number,action_type,advisor_status,source')
      .eq('ticket_id', d.ticket_id).eq('source', 'poller').order('created_at'),
  ]);
  if (!ticket || !drafts?.length) return null;
  return buildTurns(ticket, drafts).find(t => t.draft_id === draftId) || null;
}

async function runArm(turn, arm) {
  pricing.MODELS.OPUS = arm.model;
  setPromptTransform(apply(arm.variant));
  const t0 = Date.now();
  try {
    const r = await aiAdvisor({
      customer_email: turn.customer_email,
      customer_name: turn.customer_name || undefined,
      issue_description: turn.issue_description,
      order_number: turn.order_number || undefined,
      intake: turn.intake || undefined,
      // no operatorSteer — the unprompted behaviour is the thing under test
    });
    const s = r?._structured || {};
    const draft = norm(s._composedResponse || '');

    // Cost comes from THIS draft's own token usage, not from an ai_calls query.
    // The live advisor is writing cs_advisor rows the whole time this runs, so
    // a ledger query by component would fold production traffic into the arm
    // comparison — and cost is one of the three things we are here to measure.
    const calls = s._timing?.api_calls || [];
    const usage = calls.reduce((a, c) => ({
      input_tokens: a.input_tokens + (c.input_tokens || 0),
      output_tokens: a.output_tokens + (c.output_tokens || 0),
      cache_read_tokens: a.cache_read_tokens + (c.cache_read_tokens || 0),
      cache_creation_tokens: a.cache_creation_tokens + (c.cache_creation_tokens || 0),
    }), { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });

    return {
      draft,
      words: words(draft),
      status: s.status || null,
      action: s.action_type || null,
      rounds: calls.length,
      ms: s._timing?.total_ms ?? (Date.now() - t0),
      usage,
      cost: pricing.computeCost(arm.model, usage),
    };
  } finally {
    setPromptTransform(null);
    pricing.MODELS.OPUS = BASELINE_MODEL;   // never leave an arm armed
  }
}

const load = () => (fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { started: new Date().toISOString(), drafts: [] });
const save = state => fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
const key = d => `${d.case}|${d.arm}|${d.run}`;

/**
 * Fold the shard files into the main results file. Judging and reporting run
 * single-process against the merged set, so the shards are only ever a
 * drafting-time concern.
 */
function mergeShards() {
  const main = load();
  const seen = new Set(main.drafts.map(key));
  let added = 0;
  for (let i = 0; i < 32; i++) {
    const p = SHARD_GLOB(i);
    if (!fs.existsSync(p)) continue;
    for (const d of JSON.parse(fs.readFileSync(p, 'utf8')).drafts) {
      if (seen.has(key(d))) continue;
      seen.add(key(d)); main.drafts.push(d); added++;
    }
  }
  if (added) { save(main); console.log(`merged ${added} drafts from shards`); }
  return main;
}

// ---------------------------------------------------------------------------

async function check() {
  const sb = getSupabaseClient();
  const ids = GROUPS.flatMap(g => CASES[g]);
  console.log(`${ids.length} cases · ${ARMS.length} arms · models ${BASELINE_MODEL} vs ${CANDIDATE_MODEL}\n`);
  const bad = [];
  for (const id of ids) {
    const turn = await turnForDraft(sb, id);
    const ok = !!turn;
    if (!ok) bad.push(id);
    console.log(`  #${String(id).padEnd(5)} ${groupOf(id).padEnd(18)} ${ok ? `turn ${turn.turn}, jamie ${words(turn.reference.jamie_sent)}w` : 'NOT REPLAYABLE'}`);
  }
  if (bad.length) {
    console.log(`\n⚠️  ${bad.length} not replayable: ${bad.join(', ')} — swap in from CASES.alternates before running`);
  } else {
    console.log('\nall replayable ✓');
  }
  const n = (ids.length - bad.length) * ARMS.length;
  console.log(`\nper repeat: ${n} drafts ≈ $${(n * 0.15).toFixed(0)} advisor + $${(n * 0.03).toFixed(0)} judging`);
  console.log(`3 repeats:  ${n * 3} drafts ≈ $${(n * 3 * 0.15).toFixed(0)} + $${(n * 3 * 0.03).toFixed(0)}`);
}

async function draftAll(repeat) {
  const sb = getSupabaseClient();
  const state = load();
  const done = new Set(state.drafts.map(key));
  const ids = GROUPS.flatMap(g => CASES[g]);

  // This shard's slice of the cases, round-robin so each shard gets a mix of
  // defect groups rather than one shard owning all the slow shipping cases.
  const mine = SHARD
    ? ids.filter((_, i) => i % Number(SHARD.split('/')[1]) === Number(SHARD.split('/')[0]))
    : ids;

  const turns = new Map();
  for (const id of mine) {
    const t = await turnForDraft(sb, id);
    if (t) turns.set(id, t); else console.log(`#${id}: not replayable, skipped`);
  }

  const total = turns.size * ARMS.length * repeat;
  let n = 0;
  for (const [id, turn] of turns) {
    for (let run = 1; run <= repeat; run++) {
      // All four arms back to back on this case, so order-state drift stays
      // a shared confound rather than a differential one.
      for (const arm of ARMS) {
        n++;
        const rec = { case: id, group: groupOf(id), arm: arm.id, run };
        if (done.has(key(rec))) continue;
        console.log(`[${SHARD || 'all'}] ${String(n).padStart(3)}/${total} #${id} run${run} ${arm.id}`);
        try {
          Object.assign(rec, await runArm(turn, arm), { jamie_words: words(turn.reference.jamie_sent) });
        } catch (e) {
          rec.error = e.message;
        }
        state.drafts.push(rec);
        save(state);
      }
    }
  }
  console.log(`\n[${SHARD || 'all'}] ${state.drafts.length} drafts on file`);
}

async function judgeAll() {
  const sb = getSupabaseClient();
  const state = mergeShards();
  const ids = [...new Set(state.drafts.map(d => d.case))];
  const { data } = await sb
    .from('cs_ai_drafts')
    .select('id, conversation_history, order_context, audit_trail, message_type')
    .in('id', ids);
  const ctx = new Map(data.map(d => [d.id, d]));

  const todo = state.drafts.filter(d => d.draft && !d.judged && !d.error);
  console.log(`judging ${todo.length} drafts on ${JUDGE_MODEL}`);
  for (const [i, d] of todo.entries()) {
    process.stdout.write(`\r ${i + 1}/${todo.length}      `);
    try {
      const r = await judgeDraft({ ...ctx.get(d.case), draft_response: d.draft }, { model: JUDGE_MODEL, arm: d.arm });
      d.judged = { would_rewrite: r.would_rewrite, reasons: r.reasons, act: r.findings.act.verdict, findings: r.findings };
    } catch (e) {
      d.judge_error = e.message;
    }
    save(state);
  }
  console.log('');
}

async function report() {
  const state = mergeShards();
  const rows = state.drafts.filter(d => !d.error);
  if (!rows.length) return console.log('nothing drafted yet');

  // Cost and latency come from each draft's own recorded token usage, so
  // concurrent production traffic cannot leak into the arm comparison.
  const byModel = {};
  for (const arm of ARMS) {
    const rs = rows.filter(r => r.arm === arm.id && r.cost != null);
    if (!rs.length) continue;
    const m = byModel[arm.model] = byModel[arm.model] || { n: 0, cost: 0, ms: 0, out: 0 };
    m.n += rs.length;
    m.cost += rs.reduce((a, r) => a + r.cost, 0);
    m.ms += rs.reduce((a, r) => a + (r.ms || 0), 0);
    m.out += rs.reduce((a, r) => a + (r.usage?.output_tokens || 0), 0);
  }

  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '  -');
  const cell = rs => {
    const judged = rs.filter(r => r.judged);
    return {
      n: rs.length,
      acted: rs.filter(r => r.action).length,
      clean: judged.filter(r => !r.judged.would_rewrite).length,
      judged: judged.length,
      askedUnnec: judged.filter(r => r.judged.act === 'ASKED_UNNECESSARILY').length,
      findings: judged.reduce((a, r) => a + (r.judged.findings.unrequested || []).length + (r.judged.findings.ungrounded || []).length, 0),
      words: Math.round(rs.reduce((a, r) => a + r.words, 0) / rs.length),
      ms: Math.round(rs.reduce((a, r) => a + (r.ms || 0), 0) / rs.length),
    };
  };

  console.log(`\n${'='.repeat(86)}`);
  console.log(`2x2 — ${rows.length} drafts, ${[...new Set(rows.map(r => r.run))].length} run(s), judge pinned to ${JUDGE_MODEL}`);
  console.log('='.repeat(86));
  console.log(`\n${'arm'.padEnd(13)} ${'judge-clean'.padEnd(13)} ${'asked unnec.'.padEnd(13)} ${'findings/draft'.padEnd(15)} ${'acted'.padEnd(11)} ${'words'.padEnd(7)} sec`);
  for (const arm of ARMS) {
    const c = cell(rows.filter(r => r.arm === arm.id));
    if (!c.n) continue;
    console.log(`${arm.id.padEnd(13)} ${`${c.clean}/${c.judged} ${pct(c.clean, c.judged)}`.padEnd(13)} ${`${c.askedUnnec}/${c.judged} ${pct(c.askedUnnec, c.judged)}`.padEnd(13)} ${(c.findings / (c.judged || 1)).toFixed(2).padEnd(15)} ${`${c.acted}/${c.n}`.padEnd(11)} ${String(c.words).padEnd(7)} ${(c.ms / 1000).toFixed(1)}`);
  }

  console.log(`\nJamie's own replies on these cases: avg ${Math.round(rows.reduce((a, r) => a + (r.jamie_words || 0), 0) / rows.length)} words`);

  for (const g of GROUPS) {
    const gr = rows.filter(r => r.group === g);
    if (!gr.length) continue;
    console.log(`\n--- ${g} (${[...new Set(gr.map(r => r.case))].length} cases) ---`);
    for (const arm of ARMS) {
      const c = cell(gr.filter(r => r.arm === arm.id));
      if (!c.n) continue;
      console.log(`  ${arm.id.padEnd(13)} clean ${`${c.clean}/${c.judged}`.padEnd(8)} ${pct(c.clean, c.judged).padEnd(5)}  asked-unnec ${String(c.askedUnnec).padStart(2)}  acted ${`${c.acted}/${c.n}`.padEnd(8)} ${c.words}w`);
    }
  }

  console.log('\n--- cost & latency, per draft, measured on this run ---');
  for (const [m, v] of Object.entries(byModel)) {
    console.log(`  ${m.padEnd(20)} ${String(v.n).padStart(4)} drafts  $${(v.cost / v.n).toFixed(3)}/draft  ${(v.ms / v.n / 1000).toFixed(1)}s/draft  ${Math.round(v.out / v.n)} output tokens`);
  }
  const [b, c] = [byModel[BASELINE_MODEL], byModel[CANDIDATE_MODEL]];
  if (b && c) {
    const d = (x, y) => `${x > y ? '+' : ''}${Math.round((100 * (x - y)) / y)}%`;
    console.log(`  Opus 5 vs 4.8:  cost ${d(c.cost / c.n, b.cost / b.n)}  ·  latency ${d(c.ms / c.n, b.ms / b.n)}  ·  output length ${d(c.out / c.n, b.out / b.n)}`);
  }

  console.log(`\n--- the decision rule, fixed in advance ---`);
  const clean = id => { const c = cell(rows.filter(r => r.arm === id)); return c.judged ? c.clean / c.judged : null; };
  const [bc, bl, oc, ol] = ARMS.map(a => clean(a.id));
  const f = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  console.log(`  lean beats current on 4.8?      ${f(bl)} vs ${f(bc)}  → ${bl > bc ? 'YES — adopt lean on 4.8' : 'no'}`);
  console.log(`  Opus 5 matches/beats 4.8 on lean? ${f(ol)} vs ${f(bl)}  → ${ol >= bl ? 'YES — pending the pinned suite at --repeat 3' : 'no — stay on 4.8'}`);
  console.log(`  interaction (was July a prompt artifact?): o5 loses on current by ${f(bc - oc)}, on lean by ${f(bl - ol)}`);
  console.log(`\n  Neither adoption is final until: node scripts/modelSwapEval.js --candidate ${CANDIDATE_MODEL} --repeat 3`);
}

async function main() {
  if (hasFlag('check')) return check();
  if (hasFlag('report')) return report();
  if (hasFlag('judge')) { await judgeAll(); return report(); }

  await draftAll(parseInt(arg('repeat', '1'), 10));

  // A SHARD DRAFTS AND STOPS. Judging and reporting are whole-run operations:
  // they merge every shard file, so letting a shard run them makes each shard
  // pull in all the others, re-judge the union, and write six copies of the
  // same 240 drafts into six files. That is exactly what happened on the first
  // sharded run — it cost about $5 of duplicate judging and, worse, made the
  // monitoring arithmetic report a $173 spend against a real $43, because
  // every draft was being counted once per shard.
  if (SHARD) {
    console.log(`[${SHARD}] drafting done — run \`node scripts/run2x2.js --judge\` once all shards have exited`);
    return;
  }

  await judgeAll();
  await report();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
