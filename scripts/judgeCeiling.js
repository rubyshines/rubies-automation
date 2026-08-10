#!/usr/bin/env node

/**
 * What would Jamie's own replies score?
 *
 * Without this, a number like "32% clean" is uninterpretable. It could mean
 * the advisor is two thirds of the way to human quality, or nowhere near it,
 * and nothing in the 2x2 distinguishes those. The ceiling is the missing
 * denominator: run the same judge, on the same cases, against the reply Jamie
 * actually sent.
 *
 * Two honest limits on reading it as a true ceiling:
 *
 * 1. The judge is told which tools the ADVISOR called, because that is what is
 *    recorded. Jamie writes from things he simply knows — a carrier suspension,
 *    a supplier conversation — and the grounding axis has no way to verify
 *    those, so it will flag some of them. His score on grounding is therefore
 *    a floor, not a fair reading. The act and padding axes are unaffected and
 *    are where the interesting comparison lives.
 *
 * 2. On cases where he sent the advisor's draft untouched, his reply IS the
 *    advisor's reply, so those score identically by construction. Those are
 *    excluded — the ceiling only means anything on cases where he wrote
 *    something different.
 *
 * Usage:
 *   node scripts/judgeCeiling.js            # the 2x2's 20 cases
 *   node scripts/judgeCeiling.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { getSupabaseClient } = require('../shared/supabaseClient');
const { judgeDraft } = require('../eval/judge');
const CASES = require('../eval/cases2x2');

const OUT = path.resolve(__dirname, '../eval/judge-ceiling.json');
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
const words = t => norm(t).split(/\s+/).filter(Boolean).length;

function rewriteScore(draft, sent) {
  const set = t => new Set(norm(t).toLowerCase().match(/[a-z']{4,}/g) || []);
  const d = set(draft), s = set(sent);
  if (!d.size) return 0;
  let keep = 0; for (const w of d) if (s.has(w)) keep++;
  return 1 - keep / d.size;
}

async function main() {
  const sb = getSupabaseClient();
  const ids = ['act_vs_ask', 'padding', 'wholesale_rewrite'].flatMap(g => CASES[g]);
  const { data: cases, error } = await sb.from('cs_ai_drafts')
    .select('id, message_type, draft_response, sent_response, conversation_history, order_context, audit_trail')
    .in('id', ids);
  if (error) throw new Error(error.message);

  // Only 8 of the 2x2's 20 cases have a reply Jamie meaningfully rewrote, and a
  // ceiling from 8 samples is noise. Top up from recent drafts he discarded and
  // wrote himself — same shape of data, full context, and by construction they
  // are replies he chose to write rather than tolerate.
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: recent } = await sb.from('cs_ai_drafts')
    .select('id, message_type, draft_response, sent_response, conversation_history, order_context, audit_trail')
    .eq('source', 'poller').gte('created_at', since)
    .not('sent_response', 'is', null).not('draft_response', 'is', null)
    .limit(1000);

  const seen = new Set(cases.map(c => c.id));
  const data = [...cases, ...(recent || []).filter(r => !seen.has(r.id))];

  const usable = data
    .filter(d => d.sent_response && norm(d.sent_response).length > 20)
    .map(d => ({ ...d, rw: rewriteScore(d.draft_response, d.sent_response) }))
    // Where he sent the draft untouched, his reply and the advisor's are the
    // same text and the comparison is vacuous.
    .filter(d => d.rw > 0.25 && words(d.sent_response) >= 15)
    .sort((a, b) => b.rw - a.rw)
    .slice(0, 25);

  console.log(`${usable.length} replies Jamie meaningfully wrote himself (from ${data.length} candidates)`);
  console.log(`his replies average ${Math.round(usable.reduce((a, d) => a + words(d.sent_response), 0) / usable.length)} words`);

  if (hasFlag('dry-run')) return console.log('\n(dry run — no API calls)');

  const rows = [];
  for (const [i, d] of usable.entries()) {
    process.stdout.write(`\r judging ${i + 1}/${usable.length}   `);
    const r = await judgeDraft({ ...d, draft_response: d.sent_response });
    rows.push({
      id: d.id, type: d.message_type, would_rewrite: r.would_rewrite, reasons: r.reasons,
      act: r.findings.act.verdict,
      unrequested: (r.findings.unrequested || []).map(u => `${u.tag}: ${u.sentence.slice(0, 80)}`),
      ungrounded: (r.findings.ungrounded || []).map(g => g.claim.slice(0, 80)),
    });
  }
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));

  const clean = rows.filter(r => !r.would_rewrite).length;
  // Grounding is the axis the data cannot fairly judge him on (see header).
  const cleanExGrounding = rows.filter(r => !r.reasons.filter(x => x !== 'grounding').length).length;

  console.log(`\n\n${'='.repeat(66)}`);
  console.log(`CEILING — Jamie's own replies, same judge, same cases`);
  console.log('='.repeat(66));
  console.log(`  clean                       ${clean}/${rows.length}  (${Math.round(100 * clean / rows.length)}%)`);
  console.log(`  clean ignoring grounding    ${cleanExGrounding}/${rows.length}  (${Math.round(100 * cleanExGrounding / rows.length)}%)`);
  console.log(`  asked unnecessarily         ${rows.filter(r => r.act === 'ASKED_UNNECESSARILY').length}/${rows.length}`);
  console.log(`\n  ^ this is the bar. The advisor's numbers only mean something against it.\n`);

  for (const r of rows.filter(r => r.would_rewrite)) {
    console.log(`  #${r.id} [${r.type}] ${r.reasons.join('+')}`);
    for (const u of r.unrequested) console.log(`      ${u}`);
    for (const g of r.ungrounded) console.log(`      ungrounded: ${g}`);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
