#!/usr/bin/env node

/**
 * Calibrate the content judge against Jamie's own tolerance ruling.
 *
 * This is the step that can quietly invalidate everything downstream. The July
 * model evaluation skipped its equivalent and its verdict is now untrusted; a
 * 2x2 scored by an uncalibrated judge would be the same mistake with more
 * decimal places. So the judge is measured before it is used, on the only
 * labelled data that exists: the 40 unedited sends Jamie read one by one,
 * marking the ones he would have written differently.
 *
 * Two numbers matter and they are not symmetric.
 *   RECALL — of the drafts Jamie flagged, how many does the judge catch. A
 *     judge that misses his flags cannot detect an improvement in the thing he
 *     actually cares about.
 *   PRECISION — of the drafts he let through, how many does the judge flag
 *     anyway. Some of these are real: an unedited send is an UNLABELED sample,
 *     not a clean one (he sends drafts he wouldn't have written), and he only
 *     wrote a note where something bothered him enough to mention. So a
 *     false-positive rate somewhat above zero is expected and is not by itself
 *     disqualifying. A false-positive rate near his flag rate is.
 *
 * The third and strictest number is AGREEMENT ON THE REASON: where both Jamie
 * and the judge flagged a draft, did they point at the same sentence? A judge
 * that flags the right drafts for the wrong reasons will drift the moment the
 * drafts change, which is exactly what the 2x2 will do to them.
 *
 * Usage:
 *   node scripts/calibrateJudge.js --dry-run       # show the set, no API spend
 *   node scripts/calibrateJudge.js                 # run it (~40 Opus calls)
 *   node scripts/calibrateJudge.js --rescore       # re-derive verdicts from saved findings, free
 *   node scripts/calibrateJudge.js --rescore --min-unrequested=2
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { judgeDraft, verdict } = require('../eval/judge');
const { MODELS } = require('../shared/aiPricing');

const TAB = 'Tolerance Check';
const OUT = path.resolve(__dirname, '../eval/judge-calibration.json');

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();

// Jamie's note on draft 1745 is "I doubt you wrote this" — a challenge to the
// provenance of the row, not a judgement on its quality. It cannot be scored
// on this rubric either way, so it leaves the set rather than being counted as
// a flag the judge is expected to reproduce.
const EXCLUDED = { 1745: 'provenance challenge, not a quality ruling' };

async function loadLabels() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.KB_REVIEW_SHEET_ID, range: `'${TAB}'`,
  });
  const [header, ...rows] = res.data.values || [];
  if (!header) throw new Error(`tab "${TAB}" not found`);
  const dCol = header.findIndex(h => /would you have/i.test(h) || /decision/i.test(h));
  const decisionCol = dCol === -1 ? header.length - 1 : dCol;

  return rows
    .filter(r => r[1] && r[2])
    .map(r => ({
      draft_id: Number(r[1]),
      turn: r[2],
      type: r[3],
      note: norm(r[decisionCol]),
      jamie_flagged: !!norm(r[decisionCol]),
    }))
    .filter(x => !EXCLUDED[x.draft_id]);
}

async function loadDrafts(ids) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('cs_ai_drafts')
    .select('id, draft_response, conversation_history, order_context, audit_trail, message_type, draft_history')
    .in('id', ids);
  if (error) throw new Error(error.message);
  return new Map(data.map(d => [d.id, d]));
}

// ---------------------------------------------------------------------------
// Reason agreement
// ---------------------------------------------------------------------------

// Jamie's notes are typed fast and full of typos ("addef", "mesuraments"), so
// matching them to a judge citation by string similarity would be noise. What
// IS reliable is the distinctive content word he quotes back from the draft.
// Pull the longest words from his note, and check whether the judge's cited
// sentences contain them. Reported as a hint for the human read-through, never
// as a score — the read-through is what settles it.
const STOP = new Set(['would','should','there','their','which','about','because','think','thing','something','anything','really','other','these','those','where','while','after','before','never','always','need','needed','superfluous','response','customer','prompt','write','wrote','written','differently']);

function reasonOverlap(note, findings) {
  const cited = [
    ...(findings.unrequested || []).map(f => f.sentence),
    ...(findings.ungrounded || []).map(f => f.claim),
    findings.act?.why || '',
  ].join(' ').toLowerCase();
  if (!cited.trim()) return null;
  const words = (note.toLowerCase().match(/[a-z']{5,}/g) || []).filter(w => !STOP.has(w));
  const hits = [...new Set(words)].filter(w => cited.includes(w));
  return { hits, n: hits.length };
}

// ---------------------------------------------------------------------------

function report(scored, opts) {
  const tp = scored.filter(s => s.jamie_flagged && s.would_rewrite);
  const fn = scored.filter(s => s.jamie_flagged && !s.would_rewrite);
  const fp = scored.filter(s => !s.jamie_flagged && s.would_rewrite);
  const tn = scored.filter(s => !s.jamie_flagged && !s.would_rewrite);
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`CALIBRATION — ${scored.length} drafts · bar: unrequested >= ${opts.minUnrequested}`);
  console.log('='.repeat(72));
  console.log(`Jamie flagged           ${tp.length + fn.length}`);
  console.log(`  judge caught          ${tp.length}   RECALL ${pct(tp.length, tp.length + fn.length)}`);
  console.log(`  judge missed          ${fn.length}`);
  console.log(`Jamie let through       ${fp.length + tn.length}`);
  console.log(`  judge flagged anyway  ${fp.length}   (${pct(fp.length, fp.length + tn.length)} of his clean set)`);
  console.log(`  judge agreed clean    ${tn.length}`);

  const withReason = tp.filter(s => s.overlap?.n > 0);
  console.log(`\nSame reason (word overlap on his note): ${withReason.length}/${tp.length} — READ THESE, the number is only a hint`);

  console.log('\n--- CAUGHT (judge + Jamie) ---');
  for (const s of tp) {
    console.log(`\n#${s.draft_id} [${s.type}, turn ${s.turn}] reasons=${s.reasons.join('+')} overlap=${s.overlap?.hits.join(',') || '-'}`);
    console.log(`  JAMIE: ${s.note.slice(0, 180)}`);
    console.log(`  JUDGE act: ${s.findings.act.verdict} — ${s.findings.act.why}`);
    for (const u of s.findings.unrequested) console.log(`  JUDGE ${u.tag}: "${u.sentence.slice(0, 130)}"`);
    for (const g of s.findings.ungrounded) console.log(`  JUDGE ungrounded: "${g.claim.slice(0, 130)}"`);
  }

  console.log('\n--- MISSED (Jamie flagged, judge did not) ---');
  for (const s of fn) {
    console.log(`\n#${s.draft_id} [${s.type}, turn ${s.turn}]`);
    console.log(`  JAMIE: ${s.note.slice(0, 200)}`);
    console.log(`  JUDGE act: ${s.findings.act.verdict} — ${s.findings.act.why}`);
  }

  console.log('\n--- EXTRA (judge flagged, Jamie let through) ---');
  for (const s of fp) {
    console.log(`\n#${s.draft_id} [${s.type}, turn ${s.turn}] reasons=${s.reasons.join('+')}`);
    console.log(`  JUDGE act: ${s.findings.act.verdict} — ${s.findings.act.why}`);
    for (const u of s.findings.unrequested) console.log(`  JUDGE ${u.tag}: "${u.sentence.slice(0, 130)}"`);
    for (const g of s.findings.ungrounded) console.log(`  JUDGE ungrounded: "${g.claim.slice(0, 130)}"`);
  }

  const dropped = scored.flatMap(s => s.findings.dropped || []);
  if (dropped.length) console.log(`\n⚠️  ${dropped.length} findings dropped for not quoting the draft verbatim (hallucinated citations)`);
}

async function main() {
  const minUnrequested = parseInt(arg('min-unrequested', '1'), 10);

  if (hasFlag('rescore')) {
    if (!fs.existsSync(OUT)) throw new Error(`no saved run at ${OUT} — run without --rescore first`);
    const saved = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const scored = saved.results.map(s => ({ ...s, ...verdict(s.findings, { minUnrequested }) }));
    report(scored, { minUnrequested });
    return;
  }

  const labels = await loadLabels();
  const drafts = await loadDrafts(labels.map(l => l.draft_id));
  const set = labels.filter(l => drafts.has(l.draft_id));
  const missing = labels.filter(l => !drafts.has(l.draft_id));

  console.log(`${set.length} labelled drafts (${set.filter(s => s.jamie_flagged).length} flagged by Jamie)`);
  if (missing.length) console.log(`⚠️  ${missing.length} sheet rows have no draft row: ${missing.map(m => m.draft_id).join(', ')}`);
  console.log(`excluded: ${Object.entries(EXCLUDED).map(([k, v]) => `#${k} (${v})`).join('; ')}`);
  console.log(`model: ${MODELS.OPUS}`);

  if (hasFlag('dry-run')) {
    for (const s of set) console.log(`  #${s.draft_id} [${s.type}, turn ${s.turn}] ${s.jamie_flagged ? 'FLAGGED' : 'clean'}`);
    console.log('\n(dry run — no API calls made)');
    return;
  }

  const results = [];
  let usage = { input: 0, output: 0 };
  for (const [i, s] of set.entries()) {
    process.stdout.write(`\r judging ${i + 1}/${set.length} (#${s.draft_id})…      `);
    try {
      const r = await judgeDraft(drafts.get(s.draft_id), { minUnrequested });
      usage.input += r._usage?.input_tokens || 0;
      usage.output += r._usage?.output_tokens || 0;
      results.push({ ...s, ...r, overlap: reasonOverlap(s.note, r.findings) });
    } catch (e) {
      console.log(`\n  #${s.draft_id} FAILED: ${e.message}`);
    }
  }
  console.log('');

  fs.writeFileSync(OUT, JSON.stringify({ model: MODELS.OPUS, at: new Date().toISOString(), usage, results }, null, 1));
  report(results, { minUnrequested });
  console.log(`\ntokens: ${usage.input} in / ${usage.output} out · written to ${OUT}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { reasonOverlap };
