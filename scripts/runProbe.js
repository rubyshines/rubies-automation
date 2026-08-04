#!/usr/bin/env node

/**
 * A/B a prompt variant against the shipped prompt on a replayed turn.
 *
 * Costs real API money — runs the production path on the pinned production
 * model (MODELS.OPUS, currently 4.8). Testing inside Claude Code would run
 * Opus 5, which is NOT what production uses and whose behaviour on this prompt
 * is measurably different (it wrote 14% more output in the 07-28 eval).
 *
 * Order state drifts: a July ticket replayed today sees today's fulfillment.
 * That is fine here and it is worth being precise about why — both arms run
 * against the SAME live state within seconds of each other, so drift is a
 * shared confound, not a differential one. What we lose is comparability to
 * the reply Jamie sent in July; what we keep is a valid control-vs-treatment
 * comparison, which is the actual question.
 *
 * Steer is deliberately NOT replayed. The defect on 2949 is what the advisor
 * wrote UNPROMPTED; feeding it Jamie's correction would hide exactly the
 * behaviour under test.
 *
 * Usage:
 *   node scripts/runProbe.js --ticket=2949 --turn=2 --variant=no-large-order --repeat=3
 *   node scripts/runProbe.js --ticket=2949 --turn=2 --variant=no-large-order --repeat=3 --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { setPromptTransform, aiAdvisor } = require('../customer-service/lib/aiAdvisor');
const { apply } = require('./promptVariants');
const { MODELS } = require('../shared/aiPricing');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

async function runOnce(turn, variantName) {
  setPromptTransform(apply(variantName));
  try {
    const r = await aiAdvisor({
      customer_email: turn.customer_email,
      customer_name: turn.customer_name || undefined,
      issue_description: turn.issue_description,
      order_number: turn.order_number || undefined,
      intake: turn.intake || undefined,
      // no operatorSteer — we want the unprompted behaviour
    });
    const s = r?._structured || {};
    return {
      draft: norm(s._composedResponse || ''),
      status: s.status || null,
      action_type: s.action_type || null,
      tools: (s.audit || []).filter(a => /^Tool call:/.test(a)).map(a => a.replace(/^Tool call: /, '').split('(')[0]),
      ms: s._timing?.total_ms ?? null,
    };
  } finally {
    setPromptTransform(null);   // never leave a variant armed
  }
}

async function main() {
  const ticket = parseInt(arg('ticket', ''), 10);
  const turnNo = parseInt(arg('turn', '1'), 10);
  const variant = arg('variant', 'no-large-order');
  const repeat = parseInt(arg('repeat', '3'), 10);

  const packPath = path.resolve(__dirname, `../eval/replay/ticket-${ticket}.json`);
  if (!fs.existsSync(packPath)) throw new Error(`no replay pack — run: node scripts/replayTurns.js --ticket=${ticket}`);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const turn = pack.turns.find(t => t.turn === turnNo);
  if (!turn) throw new Error(`ticket ${ticket} has no turn ${turnNo}`);

  console.log(`ticket ${ticket} turn ${turnNo} — control vs ${variant}, ${repeat}x each, model ${MODELS.OPUS}`);
  console.log(`\nCUSTOMER: ${turn.issue_description.split('[LATEST CUSTOMER MESSAGE]')[1]?.trim().slice(0, 300)}`);
  console.log(`\nSHIPPED PROMPT wrote (unprompted, at the time):\n  ${turn.reference.advisor_first_draft.slice(0, 300)}`);
  console.log(`\nJAMIE SENT:\n  ${turn.reference.jamie_sent.slice(0, 300)}`);

  if (hasFlag('dry-run')) {
    const before = require('./promptVariants').VARIANTS.control('x');
    console.log('\n(dry run — no API calls made)');
    return;
  }

  const results = { control: [], [variant]: [] };
  for (let i = 0; i < repeat; i++) {
    for (const v of ['control', variant]) {
      process.stdout.write(`\nrun ${i + 1} ${v} ... `);
      try {
        const r = await runOnce(turn, v);
        results[v].push(r);
        process.stdout.write(`${r.status}/${r.action_type || 'no action'} ${r.ms}ms`);
      } catch (e) {
        process.stdout.write(`FAILED: ${e.message}`);
        results[v].push({ error: e.message });
      }
    }
  }

  console.log('\n\n' + '='.repeat(72));
  for (const v of ['control', variant]) {
    console.log(`\n### ${v.toUpperCase()}`);
    results[v].forEach((r, i) => {
      if (r.error) return console.log(`  [${i + 1}] ERROR ${r.error}`);
      console.log(`  [${i + 1}] status=${r.status} action=${r.action_type || '-'} tools=[${r.tools.join(',')}]`);
      console.log(`      ${r.draft.slice(0, 320)}`);
    });
  }

  const outPath = path.resolve(__dirname, `../eval/replay/probe-${ticket}-t${turnNo}-${variant}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ticket, turn: turnNo, variant, model: MODELS.OPUS, reference: turn.reference, results }, null, 1));
  console.log(`\nwritten to ${outPath}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
