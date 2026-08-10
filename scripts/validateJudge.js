#!/usr/bin/env node

/**
 * Does the judge track CONTENT, or has it quietly rediscovered word count?
 *
 * The confusion matrix cannot answer this. On the 39 labelled drafts a bare
 * "flag anything over 69 words" rule scores the same F1 as the judge, and it
 * still does inside a length-matched band. That looks damning until you notice
 * the two disagree about which drafts: the length rule buys its precision by
 * missing four of Jamie's eleven flags, including drafts of 38 and 43 words.
 * Length and padding are correlated in this population because complex cases
 * are both longer and likelier to carry clutter, and observing correlated
 * variables cannot separate them.
 *
 * An intervention can. Hold the case fixed and change ONE thing:
 *
 *   REPAIR — take a draft the judge flagged, delete exactly the sentence it
 *     cited, re-judge. Content improves, length falls a little.
 *   INJECT — take a draft the judge called clean, add ONE invented sentence
 *     lifted from Jamie's own complaints, re-judge. Content degrades, length
 *     rises a little.
 *
 * A content judge clears the repairs and catches the injections. A word
 * counter does neither reliably, and in particular cannot catch an injection
 * into a 30-word draft that is still far under any useful threshold.
 *
 * This matters because of how the judge gets USED. In the 2x2 it scores four
 * arms on the SAME twenty cases, so case complexity is held constant and the
 * only thing varying is what each arm chose to write. A length-driven judge in
 * that setting would simply crown whichever arm writes less — which is the
 * answer this project already knows to be wrong: on the eleven padded drafts
 * the advisor wrote 79-84 words against Jamie's own 76 on the same cases.
 *
 * Two supporting checks live here too: the length correlation that raised the
 * alarm in the first place, and a self-consistency re-judge (the advisor flips
 * run to run, so it is fair to ask whether its judge does too).
 *
 * Re-run this whenever the rubric changes. A rubric edit that fixes a false
 * positive can silently break the injection test, and the injection test is the
 * only thing standing between this project and a length-driven verdict.
 *
 * Usage:
 *   node scripts/validateJudge.js                  # the intervention test (~13 calls)
 *   node scripts/validateJudge.js --length         # free, reads the saved calibration
 *   node scripts/validateJudge.js --stability=10   # ~10 calls
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { getSupabaseClient } = require('../shared/supabaseClient');
const { judgeDraft } = require('../eval/judge');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const CAL = path.resolve(__dirname, '../eval/judge-calibration.json');

// Straight from Jamie's own tolerance notes — these are the exact species of
// sentence he objected to, not inventions of mine.
const INJECTIONS = [
  "We'll make sure she feels seen and special.",
  'Your comfort comes first, always.',
  "I love that you're getting these for your family.",
  "You'll get a confirmation email with all the details.",
  'That should give them a bit of room to grow into as well.',
  'I want to make sure I get this exactly right for you.',
  "It's on its way to you at no cost.",
  'You are not the first to make this comment.',
];

/** Pearson r — enough to see a length dependence if one is there. */
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return den ? num / den : 0;
}

async function lengthCheck() {
  const saved = JSON.parse(fs.readFileSync(CAL, 'utf8'));
  const sb = getSupabaseClient();
  const { data } = await sb.from('cs_ai_drafts').select('id, draft_response').in('id', saved.results.map(r => r.id));
  const words = new Map(data.map(d => [d.id, String(d.draft_response || '').trim().split(/\s+/).length]));

  const rows = saved.results.map(r => ({
    id: r.id,
    words: words.get(r.id) || 0,
    findings: (r.findings.unrequested || []).length + (r.findings.ungrounded || []).length,
    flagged: r.would_rewrite,
  }));

  const r = pearson(rows.map(x => x.words), rows.map(x => x.findings));
  const flagged = rows.filter(x => x.flagged);
  const clean = rows.filter(x => !x.flagged);
  const mean = a => (a.length ? Math.round(a.reduce((s, x) => s + x.words, 0) / a.length) : 0);

  console.log('=== LENGTH INDEPENDENCE ===');
  console.log(`correlation(draft words, findings) r = ${r.toFixed(2)}`);
  console.log(`mean words — judge-flagged ${mean(flagged)} (n=${flagged.length}) · judge-clean ${mean(clean)} (n=${clean.length})`);
  console.log(rows.filter(x => x.words > 120 && !x.flagged).map(x => `  long but clean: #${x.id} (${x.words}w)`).join('\n') || '  (no long-but-clean drafts)');
  console.log(rows.filter(x => x.words < 60 && x.flagged).map(x => `  short but flagged: #${x.id} (${x.words}w, ${x.findings} findings)`).join('\n') || '  (no short-but-flagged drafts)');
  console.log(`\nread: |r| under ~0.4 with both tails populated means the judge is scoring content, not length.`);
}

async function stabilityCheck(n) {
  const saved = JSON.parse(fs.readFileSync(CAL, 'utf8'));
  // Half flagged, half clean — a judge can look stable on obvious cases alone.
  const flagged = saved.results.filter(r => r.would_rewrite).slice(0, Math.ceil(n / 2));
  const clean = saved.results.filter(r => !r.would_rewrite).slice(0, Math.floor(n / 2));
  const pick = [...flagged, ...clean];

  const sb = getSupabaseClient();
  const { data } = await sb
    .from('cs_ai_drafts')
    .select('id, draft_response, conversation_history, order_context, audit_trail, message_type')
    .in('id', pick.map(p => p.id));
  const byId = new Map(data.map(d => [d.id, d]));

  console.log(`\n=== SELF-CONSISTENCY (${pick.length} drafts, second pass) ===`);
  let agree = 0;
  for (const p of pick) {
    const again = await judgeDraft(byId.get(p.id));
    const same = again.would_rewrite === p.would_rewrite;
    if (same) agree++;
    console.log(`  #${p.id}  run1 ${p.would_rewrite ? 'REWRITE' : 'clean  '} (${(p.findings.unrequested || []).length}u)  run2 ${again.would_rewrite ? 'REWRITE' : 'clean  '} (${(again.findings.unrequested || []).length}u)  ${same ? '' : '← DISAGREES'}`);
  }
  console.log(`\nverdict agreement ${agree}/${pick.length}`);
}

const words = t => String(t || '').trim().split(/\s+/).length;

/** Insert the sentence just before the valediction, where padding really lands. */
function inject(draft, sentence) {
  const lines = draft.split('\n');
  const vi = lines.findIndex(l => /^(Talk soon|Take care|Thanks|Best|Warmly)\s*,\s*$/i.test(l.trim()));
  if (vi <= 0) return `${draft.trim()}\n\n${sentence}`;
  return [...lines.slice(0, vi - 1), sentence, '', ...lines.slice(vi)].join('\n');
}

function repair(draft, sentence) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const flat = norm(draft);
  const target = norm(sentence).replace(/[.!?]+$/, '');
  const at = flat.toLowerCase().indexOf(target.toLowerCase());
  if (at === -1) return null;
  return norm(flat.slice(0, at) + flat.slice(at + target.length)).replace(/\s+([.,!?])/g, '$1');
}

async function interventionTest() {
  const n = parseInt(arg('n', '8'), 10);
  const saved = JSON.parse(fs.readFileSync(CAL, 'utf8'));
  const sb = getSupabaseClient();
  const { data } = await sb
    .from('cs_ai_drafts')
    .select('id, draft_response, conversation_history, order_context, audit_trail, message_type')
    .in('id', saved.results.map(r => r.id));
  const byId = new Map(data.map(d => [d.id, d]));

  // REPAIR: flagged drafts whose single cited sentence we can actually excise.
  const repairs = saved.results
    .filter(r => r.would_rewrite && (r.findings.unrequested || []).length === 1 && !(r.findings.ungrounded || []).length)
    .map(r => {
      const row = byId.get(r.id);
      const fixed = repair(row.draft_response, r.findings.unrequested[0].sentence);
      return fixed && { id: r.id, row, fixed, cut: r.findings.unrequested[0].sentence };
    })
    .filter(Boolean)
    .slice(0, n);

  // INJECT: judge-clean drafts, one invented sentence each.
  const injects = saved.results
    .filter(r => !r.would_rewrite)
    .map((r, i) => {
      const row = byId.get(r.id);
      return { id: r.id, row, added: INJECTIONS[i % INJECTIONS.length] };
    })
    .slice(0, n);

  console.log(`REPAIR ${repairs.length} · INJECT ${injects.length} · ${repairs.length + injects.length} judge calls\n`);

  console.log('=== REPAIR — delete the cited sentence, expect the flag to clear ===');
  let cleared = 0;
  for (const r of repairs) {
    const res = await judgeDraft({ ...r.row, draft_response: r.fixed });
    const ok = !res.would_rewrite;
    if (ok) cleared++;
    console.log(`  #${r.id}  ${words(r.row.draft_response)}w → ${words(r.fixed)}w  ${ok ? 'CLEARED ✓' : `still flagged (${res.reasons.join('+')}) ✗`}`);
    if (!ok) for (const u of res.findings.unrequested) console.log(`      still: "${u.sentence.slice(0, 90)}"`);
  }

  console.log('\n=== INJECT — add one invented sentence, expect it caught and cited ===');
  let caught = 0; let cited = 0;
  for (const r of injects) {
    const draft = inject(r.row.draft_response, r.added);
    const res = await judgeDraft({ ...r.row, draft_response: draft });
    const hit = res.would_rewrite;
    const namedIt = (res.findings.unrequested || []).some(u =>
      u.sentence.toLowerCase().replace(/\s+/g, ' ').includes(r.added.toLowerCase().slice(0, 25).replace(/\s+/g, ' ')));
    if (hit) caught++;
    if (namedIt) cited++;
    console.log(`  #${r.id}  ${words(r.row.draft_response)}w → ${words(draft)}w  ${hit ? 'CAUGHT ✓' : 'MISSED ✗'} ${namedIt ? '(cited the injection)' : hit ? '(flagged something else)' : ''}`);
    console.log(`      injected: "${r.added}"`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`repairs cleared    ${cleared}/${repairs.length}`);
  console.log(`injections caught  ${caught}/${injects.length}  · cited by name ${cited}/${injects.length}`);
  const shortHits = injects.length ? 'see per-row word counts above — an injection caught in a sub-50-word draft cannot be a length effect' : '';
  console.log(shortHits);
}

async function main() {
  const only = process.argv.some(a => a === '--length' || a.startsWith('--stability'));
  if (process.argv.includes('--length')) await lengthCheck();
  if (process.argv.some(a => a.startsWith('--stability'))) await stabilityCheck(parseInt(arg('stability', '10'), 10));
  if (!only) await interventionTest();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
