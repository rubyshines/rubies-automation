#!/usr/bin/env node

/**
 * Blind check on the content judge — the step every previous scorer here
 * skipped.
 *
 * The holdout grader, the edit-rate tripwire and the daily closeness judge
 * were all trusted straight into use, and all three turned out to be wrong in
 * a specific way nobody had looked for. This judge agrees with Jamie on the 39
 * drafts it was CALIBRATED on, which is not evidence of anything — it was
 * tuned against them. The question is whether it agrees on drafts it has never
 * seen.
 *
 * Three deliberate choices:
 *
 * 1. BLIND. The sheet does not show the judge's verdict. Jamie marks the draft
 *    cold; the comparison happens on read-back. Showing him the machine's
 *    opinion first would anchor him and the exercise would prove nothing.
 *
 * 2. BOTH POPULATIONS. The calibration set was entirely drafts he SENT
 *    UNEDITED — so the judge has only ever been tested against drafts he
 *    tolerated, never against ones he tore up. Half this set is drafts he
 *    rewrote heavily, which are known-bad by revealed preference and should be
 *    caught at a much higher rate. If the judge cannot separate those two
 *    populations, it is not measuring quality.
 *
 * 3. WITH CONTEXT. The tolerance sheet showed the sent text alone. You cannot
 *    fairly judge "did it ask for something it already had" without the
 *    customer's message in front of you, and that is the single most common
 *    defect. Customer message, thread and order all go on the sheet.
 *
 * Recent drafts only: policy moves, and a draft that was right in June can
 * read as wrong today. Staleness would show up as founder-vs-judge
 * disagreement and be indistinguishable from a bad judge.
 *
 * Usage:
 *   node scripts/publishJudgeBlindCheck.js --dry-run
 *   node scripts/publishJudgeBlindCheck.js              # publish + judge (~$0.50)
 *   node scripts/publishJudgeBlindCheck.js --read       # compare after he marks it
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');

const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { judgeDraft } = require('../eval/judge');

const TAB = 'Judge Blind Check';
const HIDDEN = path.resolve(__dirname, '../eval/judge-blind-check.json');
const N = 20;

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
const words = t => norm(t).split(/\s+/).filter(Boolean).length;

// Same whitelist as the tolerance sheet: cs_ai_drafts holds every outbound
// message and only 'poller' rows are ones the advisor actually wrote. A
// blacklist leaked Jamie's own writing into a founder sheet once already.
const ELIGIBLE_SOURCE = 'poller';

// How much of the draft's distinctive vocabulary failed to survive into what
// he sent. High means he discarded it and wrote his own.
function rewriteScore(draft, sent) {
  const set = t => new Set(norm(t).toLowerCase().match(/[a-z']{4,}/g) || []);
  const d = set(draft), s = set(sent);
  if (!d.size) return 0;
  let keep = 0; for (const w of d) if (s.has(w)) keep++;
  return 1 - keep / d.size;
}

const US = /rubies customer care|care@rubyshines\.com|jamie@rubyshines\.com/i;
function conversationText(history, cap = 2500) {
  const msgs = (Array.isArray(history) ? history : [])
    .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(m => {
      const who = [m.sender?.name, m.sender?.email, m.sender].filter(x => typeof x === 'string').join(' ');
      return `[${m.is_bot ? 'BOT' : US.test(who) ? 'US' : 'CUSTOMER'}] ${norm(m.body).slice(0, 700)}`;
    });
  const j = msgs.join('\n\n');
  return j.length > cap ? `…earlier trimmed…\n\n${j.slice(-cap)}` : j;
}

function orderLine(ctx) {
  if (!ctx) return 'no order loaded';
  const items = (ctx.line_items || ctx.items || [])
    .map(li => `${li.quantity || 1}x ${li.title || li.name} ${li.sku_size || li.variant_title || ''}`.trim()).join(', ');
  return [ctx.name, ctx.fulfillment_status, ctx.days_since_order != null && `${ctx.days_since_order}d ago`, items]
    .filter(Boolean).join(' · ');
}

async function pickDrafts(sb) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('cs_ai_drafts')
      .select('id, message_type, draft_response, sent_response, conversation_history, order_context, audit_trail, created_at')
      .eq('source', ELIGIBLE_SOURCE).gte('created_at', since)
      .not('sent_response', 'is', null).not('draft_response', 'is', null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const scored = all
    .filter(d => words(d.draft_response) >= 20)
    .map(d => ({ ...d, rw: rewriteScore(d.draft_response, d.sent_response) }));

  // Two populations, deliberately balanced. Unedited = he tolerated it (the
  // calibration set's shape). Rewritten = known-bad by revealed preference,
  // and a population the judge has never been tested against.
  const untouched = scored.filter(d => d.rw < 0.15);
  const rewritten = scored.filter(d => d.rw > 0.6);

  // Spread across types, over-weighting the categories the calibration set was
  // thin on and the ones the 2x2 cares about.
  const WEIGHT = { shipping: 3, general_inquiry: 3, sizing_inquiry: 2, defect: 2, exchange: 1, refund: 1, closing: 1 };
  const spread = (pool, want) => {
    const byType = new Map();
    for (const d of pool) {
      const t = d.message_type || 'uncategorized';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(d);
    }
    const out = [];
    const types = [...byType.keys()].sort((a, b) => (WEIGHT[b] || 1) - (WEIGHT[a] || 1));
    let round = 0;
    while (out.length < want && round < 12) {
      for (const t of types) {
        const list = byType.get(t);
        const take = round < (WEIGHT[t] || 1) ? list.shift() : null;
        if (take) out.push(take);
        if (out.length >= want) break;
      }
      round++;
    }
    return out;
  };

  return { picked: [...spread(untouched, N / 2), ...spread(rewritten, N / 2)], untouched: untouched.length, rewritten: rewritten.length };
}

/** Deterministic shuffle — no Math.random, so a re-publish keeps the same order. */
function shuffle(rows) {
  return rows
    .map(r => ({ r, k: [...String(r.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 99991, 7) }))
    .sort((a, b) => a.k - b.k).map(x => x.r);
}

const DECISION_NOTE =
  'BLANK = you would have sent this as-is.\n' +
  'Write ANYTHING = you would have written it differently, and say briefly what is wrong ' +
  '("invented a sentence", "should have just done the exchange", "asked me something I already told it").\n\n' +
  'You are marking the DRAFT the advisor produced, not what actually went out. ' +
  'Some of these you sent untouched and some you rewrote — deliberately not labelled, ' +
  'so your read is not steered.';

async function publish(sheets, spreadsheetId, rows) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = meta.data.sheets.find(s => s.properties.title === TAB);
  let sheetId;
  if (existing) {
    sheetId = existing.properties.sheetId;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${TAB}'` });
  } else {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  }

  const header = ['#', 'Draft id', 'Type', 'Order', 'Conversation (oldest first)', 'THE DRAFT', 'Would you have sent this?'];
  const values = rows.map((d, i) => [
    i + 1, d.id, d.message_type || '', orderLine(d.order_context),
    conversationText(d.conversation_history), norm(d.draft_response).slice(0, 4000), '',
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW', requestBody: { values: [header, ...values] },
  });

  const widths = [35, 60, 110, 220, 460, 500, 280];
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(textFormat,wrapStrategy)' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 }, cell: { note: DECISION_NOTE }, fields: 'note' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: 6, endColumnIndex: 7 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
  ];
  widths.forEach((w, i) => requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } }));
  for (const c of [3, 4, 5]) requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function readBack() {
  const hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8'));
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.KB_REVIEW_SHEET_ID, range: `'${TAB}'` });
  const [, ...rows] = res.data.values || [];

  const scored = rows.filter(r => r[1]).map(r => {
    const h = hidden.rows.find(x => String(x.id) === String(r[1])) || {};
    return { id: Number(r[1]), type: r[2], note: norm(r[6]), jamie: !!norm(r[6]), judge: h.would_rewrite, population: h.population, findings: h.findings };
  });
  const marked = scored.filter(s => s.note || s.jamie === false);

  const tp = scored.filter(s => s.jamie && s.judge).length;
  const fn = scored.filter(s => s.jamie && !s.judge);
  const fp = scored.filter(s => !s.jamie && s.judge);
  const tn = scored.filter(s => !s.jamie && !s.judge).length;
  const agree = tp + tn;

  console.log(`\nBLIND CHECK — ${scored.length} drafts the judge had never seen`);
  console.log(`agreement: ${agree}/${scored.length} (${Math.round(100 * agree / scored.length)}%)`);
  console.log(`  you flagged ${tp + fn.length}, judge caught ${tp}`);
  console.log(`  you passed  ${fp.length + tn}, judge flagged ${fp.length} anyway`);

  for (const pop of ['untouched', 'rewritten']) {
    const p = scored.filter(s => s.population === pop);
    if (!p.length) continue;
    console.log(`  ${pop.padEnd(10)} you flagged ${p.filter(s => s.jamie).length}/${p.length} · judge flagged ${p.filter(s => s.judge).length}/${p.length}`);
  }

  if (fn.length) {
    console.log('\nMISSED — you flagged, judge did not:');
    for (const s of fn) console.log(`  #${s.id} [${s.type}] ${s.note.slice(0, 140)}`);
  }
  if (fp.length) {
    console.log('\nEXTRA — judge flagged, you passed:');
    for (const s of fp) {
      console.log(`  #${s.id} [${s.type}]`);
      for (const u of (s.findings?.unrequested || [])) console.log(`      ${u.tag}: "${u.sentence.slice(0, 110)}"`);
    }
  }
  console.log(`\nread: the judge scored 11/11 recall and 29% extra on the set it was TUNED on.`);
  console.log(`Numbers in that region here mean it generalises. Much worse means it learned those 39 drafts.`);
}

/** Re-judge the same 20 drafts after a rubric change and re-compare. Free of Jamie's time. */
async function rejudge() {
  const sb = getSupabaseClient();
  const prior = JSON.parse(fs.readFileSync(HIDDEN, 'utf8'));
  const ids = prior.rows.map(r => r.id);
  const { data } = await sb.from('cs_ai_drafts')
    .select('id, draft_response, conversation_history, order_context, audit_trail, message_type')
    .in('id', ids);
  const byId = new Map(data.map(d => [d.id, d]));
  const out = { at: new Date().toISOString(), rows: [] };
  for (const r of prior.rows) {
    const j = await judgeDraft(byId.get(r.id));
    out.rows.push({ id: r.id, would_rewrite: j.would_rewrite, reasons: j.reasons, findings: j.findings, population: r.population });
    process.stdout.write('.');
  }
  fs.writeFileSync(HIDDEN, JSON.stringify(out, null, 1));
  console.log('\nre-judged ' + out.rows.length + ' drafts');
  await readBack();
}

async function main() {
  if (hasFlag('read')) return readBack();
  if (hasFlag('rejudge')) return rejudge();

  const sb = getSupabaseClient();
  const { picked, untouched, rewritten } = await pickDrafts(sb);
  const rows = shuffle(picked);

  console.log(`pool: ${untouched} sent-as-is, ${rewritten} heavily rewritten (last 30 days)`);
  const byType = {};
  rows.forEach(d => { byType[d.message_type || '?'] = (byType[d.message_type || '?'] || 0) + 1; });
  console.log(`picked ${rows.length}:`, JSON.stringify(byType));

  if (hasFlag('dry-run')) {
    rows.forEach((d, i) => console.log(`  ${i + 1}. #${d.id} [${d.message_type}] ${d.rw < 0.15 ? 'sent as-is' : 'rewritten'} — ${norm(d.draft_response).slice(0, 90)}…`));
    return console.log('\n(dry run — nothing published, no judging)');
  }

  console.log(`\njudging ${rows.length} drafts (hidden from the sheet)…`);
  const hidden = { at: new Date().toISOString(), rows: [] };
  for (const d of rows) {
    const r = await judgeDraft(d);
    hidden.rows.push({ id: d.id, would_rewrite: r.would_rewrite, reasons: r.reasons, findings: r.findings, population: d.rw < 0.15 ? 'untouched' : 'rewritten' });
    process.stdout.write('.');
  }
  fs.writeFileSync(HIDDEN, JSON.stringify(hidden, null, 1));
  console.log(`\nverdicts saved to ${path.basename(HIDDEN)} — NOT on the sheet`);

  const sheets = await getSheetsClient();
  await publish(sheets, process.env.KB_REVIEW_SHEET_ID, rows);
  console.log(`\nPublished "${TAB}"`);
  console.log(`https://docs.google.com/spreadsheets/d/${process.env.KB_REVIEW_SHEET_ID}`);
  console.log(`\nWhen Jamie has marked it: node scripts/publishJudgeBlindCheck.js --read`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
