#!/usr/bin/env node

/**
 * Batch A/B a prompt variant across many replayed turns.
 *
 * Costs real API money on the pinned production model. Both arms run against
 * the same live order state within seconds of each other, so drift is a shared
 * confound rather than a differential one.
 *
 * Steer is never replayed — the defect under test is what the advisor writes
 * unprompted, and feeding it Jamie's correction would hide exactly that.
 *
 * Reported per case: whether the arm ACTED (staged an operator action) or only
 * asked, and the reply length. Those are the two measured defects — asking
 * when it could act, and padding. Judging prose quality is a separate pass.
 *
 * Usage:
 *   node scripts/runProbeBatch.js --drafts=1376,1379 --variant=no-overrides
 *   node scripts/runProbeBatch.js --drafts=... --variant=no-overrides --repeat=1
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { setPromptTransform, aiAdvisor } = require('../customer-service/lib/aiAdvisor');
const { apply } = require('./promptVariants');
const { MODELS } = require('../shared/aiPricing');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { buildTurns } = require('./replayTurns');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const norm = t => (t || '').replace(/\s+/g, ' ').trim();
const words = t => norm(t).split(/\s+/).filter(Boolean).length;

/** Rebuild the turn a given draft belongs to, from stored history. */
async function turnForDraft(sb, draftId) {
  const { data: d } = await sb.from('cs_ai_drafts').select('ticket_id').eq('id', draftId).single();
  if (!d) return null;
  const [{ data: ticket }, { data: drafts }] = await Promise.all([
    sb.from('cs_tickets').select('id,conversation_history').eq('id', d.ticket_id).single(),
    sb.from('cs_ai_drafts')
      .select('id,created_at,draft_response,sent_response,intake_state,order_context,operator_steer,draft_history,customer_email,customer_name,order_number,action_type,advisor_status,source')
      .eq('ticket_id', d.ticket_id).eq('source', 'poller').order('created_at'),
  ]);
  if (!ticket || !drafts?.length) return null;
  return buildTurns(ticket, drafts).find(t => t.draft_id === draftId) || null;
}

async function runOnce(turn, variantName) {
  setPromptTransform(apply(variantName));
  try {
    const r = await aiAdvisor({
      customer_email: turn.customer_email,
      customer_name: turn.customer_name || undefined,
      issue_description: turn.issue_description,
      order_number: turn.order_number || undefined,
      intake: turn.intake || undefined,
    });
    const s = r?._structured || {};
    const draft = norm(s._composedResponse || '');
    return { draft, words: words(draft), status: s.status || null, action: s.action_type || null };
  } finally {
    setPromptTransform(null);
  }
}

async function main() {
  const draftIds = arg('drafts', '').split(',').filter(Boolean).map(Number);
  const variant = arg('variant', 'no-overrides');
  const repeat = parseInt(arg('repeat', '1'), 10);
  if (!draftIds.length) throw new Error('pass --drafts=id,id,...');

  const sb = getSupabaseClient();
  console.log(`${draftIds.length} cases x ${repeat} run(s) x 2 arms on ${MODELS.OPUS}\n`);

  const out = [];
  for (const id of draftIds) {
    const turn = await turnForDraft(sb, id);
    if (!turn) { console.log(`draft ${id}: no replayable turn, skipped`); continue; }
    const row = { draft_id: id, turn: turn.turn, needed_steer: turn.reference.needed_a_steer, jamie_words: words(turn.reference.jamie_sent), arms: {} };
    for (const v of ['control', variant]) {
      row.arms[v] = [];
      for (let i = 0; i < repeat; i++) {
        try { row.arms[v].push(await runOnce(turn, v)); }
        catch (e) { row.arms[v].push({ error: e.message }); }
      }
    }
    const fmt = v => {
      const rs = row.arms[v].filter(r => !r.error);
      if (!rs.length) return 'ERR';
      const acted = rs.filter(r => r.action).length;
      const w = Math.round(rs.reduce((a, r) => a + r.words, 0) / rs.length);
      return `acted ${acted}/${rs.length}  ${w}w`;
    };
    console.log(`draft ${String(id).padEnd(5)} turn ${turn.turn}  jamie ${String(row.jamie_words).padStart(3)}w   control: ${fmt('control').padEnd(20)} ${variant}: ${fmt(variant)}`);
    out.push(row);
  }

  const agg = v => {
    const rs = out.flatMap(r => r.arms[v]).filter(r => !r.error);
    return { n: rs.length, acted: rs.filter(r => r.action).length, words: Math.round(rs.reduce((a, r) => a + r.words, 0) / (rs.length || 1)) };
  };
  const c = agg('control'), t = agg(variant);
  const jw = Math.round(out.reduce((a, r) => a + r.jamie_words, 0) / (out.length || 1));
  console.log('\n' + '-'.repeat(72));
  console.log(`control      staged an action ${c.acted}/${c.n}   avg ${c.words} words`);
  console.log(`${variant.padEnd(13)}staged an action ${t.acted}/${t.n}   avg ${t.words} words`);
  console.log(`Jamie's own sent replies on these cases: avg ${jw} words`);

  const p = path.resolve(__dirname, `../eval/replay/batch-${variant}.json`);
  fs.writeFileSync(p, JSON.stringify({ variant, model: MODELS.OPUS, cases: out }, null, 1));
  console.log(`\nwritten to ${p}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
