#!/usr/bin/env node

/**
 * Publish the wording-mandate audit for founder ruling.
 *
 * Origin: tolerance item #8. Jamie called "I'll get you into a size that works"
 * superfluous — but the prompt instructs that exact opener verbatim, so the
 * advisor was obeying. The prompt accreted over five months in response to
 * individual incidents and nobody has ever asked him whether he agrees with
 * all of it. A mandate he disagrees with is invisible to every metric we have,
 * because the draft is "correct" by the prompt's own standard, and it reliably
 * produces text he then deletes.
 *
 * Convention matches the other founder tabs: BLANK = keep it. Write anything
 * = change or drop it.
 *
 * Usage: node scripts/publishSayRulesSheet.js [--dry-run] [--read]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { getSheetsClient } = require('../shared/googleSheetsClient');

const TAB = 'Say-Rules Audit';
const SRC = path.resolve(__dirname, '../eval/say-rules.json');
const DECISION_COL = 4;

// Internal strings that never reach a customer — operator flags and the like.
const INTERNAL = /^Refund-pattern/;

const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

const NOTE =
  'BLANK = keep this, it sounds like me.\n' +
  'Write ANYTHING = change or drop it.\n\n' +
  'These are phrases the PROMPT tells the advisor to use word-for-word. If a ' +
  'draft has ever annoyed you with one of these, it was following orders. ' +
  'A short note on what is wrong is enough ("too chirpy", "never say this", ' +
  '"only on defects").';

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
      if (d && r[2]) map.set(norm(r[2]), d);
    }
  } catch { /* first publish */ }
  return map;
}

function buildRows(data) {
  const seen = new Set();
  return data.prescribe
    .flatMap(r => r.phrases.map(p => ({ ...r, phrase: p })))
    .filter(r => !INTERNAL.test(r.phrase))
    .filter(r => { const k = norm(r.phrase); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function main() {
  const spreadsheetId = process.env.KB_REVIEW_SHEET_ID;
  if (!spreadsheetId) throw new Error('KB_REVIEW_SHEET_ID not set');
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const rows = buildRows(data);

  if (hasFlag('read')) {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    const [, ...r] = res.data.values || [];
    const changed = r.filter(x => norm(x[DECISION_COL]));
    console.log(`kept ${r.length - changed.length}/${r.length}, ${changed.length} to change`);
    for (const x of changed) console.log(JSON.stringify({ n: x[0], section: x[1], phrase: x[2], ruling: x[DECISION_COL] }));
    return;
  }

  console.log(`${rows.length} wording mandates for ruling`);
  if (hasFlag('dry-run')) {
    rows.forEach((r, i) => console.log(`${i + 1}. [${r.section}] "${r.phrase.slice(0, 100)}"`));
    return;
  }

  const sheets = await getSheetsClient();
  const prior = await readExisting(sheets, spreadsheetId);
  const sheetId = await ensureTab(sheets, spreadsheetId, TAB);
  const header = ['#', 'Where in the prompt', 'What it tells the advisor to say', 'The full instruction', 'Keep it?'];
  const values = rows.map((r, i) => ([
    i + 1, r.section, r.phrase.slice(0, 500), r.instruction.slice(0, 900),
    prior.get(norm(r.phrase)) || '',
  ]));

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [header, ...values] },
  });

  const widths = [40, 210, 470, 470, 260];
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(textFormat,wrapStrategy)' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { note: NOTE }, fields: 'note' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
  ];
  widths.forEach((w, i) => requests.push({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' },
  }));
  for (const c of [2, 3]) requests.push({
    repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log(`Published ${values.length} rows to "${TAB}"`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { buildRows };
