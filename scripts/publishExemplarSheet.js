#!/usr/bin/env node

/**
 * Exemplar review sheet — Jamie's own pre-March replies, for the rebuilt
 * advisor prompt.
 *
 * The advisor's dominant defect (measured 2026-08-04) is unrequested
 * elaboration: it bolts invented warmth, redundant procedure and restated
 * facts onto an otherwise correct action. Ten of eleven flagged drafts were
 * that. Rules have been tried against it twice (17 voice rules PR #95, the
 * 07-20 one-move-per-message fix) and the aggregate hasn't moved in ten weeks.
 *
 * The alternative mechanism is exemplars: show what Jamie actually wrote, and
 * stop describing it. His own findings support this — positive templates beat
 * negative rules, and an active tone sample beat a rule outright.
 *
 * Source is PRE-MARCH replies only, because that is the writing Jamie trusts:
 * he composed every word before the advisor existed, so there is no
 * tolerated-but-not-ideal contamination in it.
 *
 * Selection covers the situations the advisor gets wrong rather than a
 * representative sample, and skews to reply 2+ where accuracy is worst
 * (~25% right at turn 2). Donation-boilerplate replies are excluded — that
 * copy comes from the tool verbatim and is not Jamie's voice to learn.
 *
 * Review convention matches the other founder tabs: BLANK = yes, this is me,
 * use it. Write anything = don't use it (not my voice, or the policy has
 * since changed).
 *
 * Usage:
 *   node scripts/publishExemplarSheet.js [--per-situation=3] [--dry-run]
 *   node scripts/publishExemplarSheet.js --read
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { getSheetsClient } = require('../shared/googleSheetsClient');

const TAB = 'Exemplars';
const CANDIDATES = path.resolve(__dirname, '../eval/exemplar-candidates.json');
const DECISION_COL = 5;

// Situations the advisor demonstrably fails, in rough priority order. Matched
// against Jamie's reply so the tag names what he DID, not what was asked.
const SITUATIONS = [
  ['acted immediately', /\b(i (went ahead and )?(created|made|set up|placed|sent)|i've (created|set up|sent|placed)|new order (is|has been)? ?(created|placed))/i],
  ['confirmed scope', /just to confirm|would you like me to exchange all|are you looking to/i],
  ['asked for measurement', /measurement|measure|waist around/i],
  ['size advice', /size (up|down)|fabric|size chart|fits|rise/i],
  ['placed or lifted a hold', /\bhold\b/i],
  ['refund', /refund/i],
  ['defect', /defect|faulty|failed their inspection|supplier/i],
  ['shipping', /ship|tracking|delivery|usps|arriv/i],
  ['short acknowledgement', /^(thanks|thank you|glad|ok great|no problem)/i],
];

const DECISION_NOTE =
  'BLANK = yes, this is me, use it as an exemplar.\n' +
  'Write ANYTHING = do not use it. Worth saying which:\n' +
  '  "not me" (voice is off), or "stale" (policy has changed since).\n\n' +
  'These are your own replies from before March, so voice should be right — ' +
  'the thing to watch for is policy that has moved on.';

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

function situationOf(reply) {
  for (const [name, re] of SITUATIONS) if (re.test(reply)) return name;
  return 'other';
}

// Anything whose correctness depends on facts that move. These replies were
// written up to a year ago; the voice is still Jamie's but the content may no
// longer be true, and an exemplar teaches content as well as shape. Jamie read
// all 30 of the first batch and rejected none, which says the corpus is clean
// on VOICE — this filter is what lets the set grow past what he can read,
// because staleness is the failure mode his eyes were actually catching.
const STALE = [
  /\$\s?\d/,                                  // prices and refund amounts
  /\b\d{1,2}\s?% ?(off|discount)/i,           // discount levels
  /\b(60|30|90)[- ]day/i,                     // policy windows
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Way|Court|Square)\b/, // addresses
  /\b(20\d\d)\b/,                             // hard dates
  /\bcoupon|promo code|welcome code\b/i,
  /\b(covid|black friday|cyber monday|holiday cut ?off)\b/i,
];
const isStale = t => STALE.some(re => re.test(t));

/**
 * Cover every situation rather than sampling proportionally: the point is to
 * show the advisor one good example of each thing it gets wrong, not to
 * reproduce the distribution of Jamie's inbox.
 */
function select(candidates, perSituation) {
  const pool = candidates.filter(x =>
    !/donat/i.test(x.jamie) &&        // tool-provided copy, not his voice
    !isStale(x.jamie) &&
    x.words >= 8 && x.words <= 130 &&
    x.customer.length > 25);

  const buckets = new Map();
  for (const x of pool) {
    const s = situationOf(x.jamie);
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(x);
  }

  const picked = [];
  for (const [name] of [...SITUATIONS, ['other']]) {
    const list = (buckets.get(name) || [])
      // Reply 2+ first (accuracy is worst there), then shortest — a tight
      // reply teaches the "answer and stop" shape better than a long one.
      .sort((a, b) => (b.reply_index >= 2) - (a.reply_index >= 2) || a.words - b.words);
    picked.push(...list.slice(0, perSituation).map(x => ({ ...x, situation: name })));
  }
  return picked;
}

async function ensureTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${title}'` });
    return existing.properties.sheetId;
  }
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function readExisting(sheets, spreadsheetId) {
  const map = new Map();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    const [header, ...rows] = res.data.values || [];
    if (!header) return map;
    for (const r of rows) {
      const d = norm(r[DECISION_COL]);
      if (d && r[4]) map.set(norm(r[4]).slice(0, 200), d);
    }
  } catch { /* tab does not exist yet */ }
  return map;
}

async function publish(sheets, spreadsheetId, rows) {
  const prior = await readExisting(sheets, spreadsheetId);
  const sheetId = await ensureTab(sheets, spreadsheetId, TAB);
  const header = ['#', 'Situation', 'Reply', 'Customer said', 'What you wrote', 'Use it?'];
  const values = rows.map((x, i) => ([
    i + 1,
    x.situation,
    x.reply_index >= 3 ? '3+' : x.reply_index,
    x.customer.slice(0, 700),
    x.jamie.slice(0, 1500),
    prior.get(norm(x.jamie).slice(0, 200)) || '',
  ]));

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [header, ...values] },
  });

  const widths = [40, 150, 55, 420, 520, 240];
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(textFormat,wrapStrategy)' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { note: DECISION_NOTE }, fields: 'note' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
  ];
  widths.forEach((w, i) => requests.push({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' },
  }));
  for (const c of [3, 4]) requests.push({
    repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return values.length;
}

async function main() {
  const spreadsheetId = process.env.KB_REVIEW_SHEET_ID;
  if (!spreadsheetId) throw new Error('KB_REVIEW_SHEET_ID not set');

  if (hasFlag('read')) {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    const [, ...rows] = res.data.values || [];
    const rejected = rows.filter(r => norm(r[DECISION_COL]));
    console.log(`kept ${rows.length - rejected.length}/${rows.length}`);
    for (const r of rejected) console.log(JSON.stringify({ n: r[0], situation: r[1], why: r[DECISION_COL] }));
    return;
  }

  const candidates = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  const rows = select(candidates, parseInt(arg('per-situation', '8'), 10));

  // Everything not taught to the model is held out to test it. Same customer
  // messages, same situations, with Jamie's real reply as the reference — so
  // V2 can be scored against writing it has never seen, which is the only way
  // to tell learning from memorisation.
  const taught = new Set(rows.map(r => r.jamie));
  const holdout = candidates.filter(x => !taught.has(x.jamie) && x.customer.length > 25);
  const holdoutPath = path.resolve(__dirname, '../eval/exemplar-holdout.json');
  fs.writeFileSync(holdoutPath, JSON.stringify(holdout, null, 1));

  const counts = {};
  for (const r of rows) counts[r.situation] = (counts[r.situation] || 0) + 1;
  console.log(`${candidates.length} candidates -> ${rows.length} taught, ${holdout.length} held out for eval`);
  console.log(JSON.stringify(counts, null, 1));

  if (hasFlag('dry-run')) {
    for (const r of rows) console.log(`\n[${r.situation} | reply ${r.reply_index} | ${r.words}w]\n  C: ${r.customer.slice(0, 150)}\n  J: ${r.jamie.slice(0, 250)}`);
    return;
  }

  const sheets = await getSheetsClient();
  const n = await publish(sheets, spreadsheetId, rows);
  console.log(`\nPublished ${n} rows to "${TAB}"`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { select, situationOf, SITUATIONS };
