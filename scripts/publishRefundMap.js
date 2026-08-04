#!/usr/bin/env node

/**
 * Publish the refund decision map for founder review.
 *
 * Refund rules are spread across 24 sections of the advisor prompt, which is
 * how contradictions survive: two rules in two sections disagree for months
 * and each reads fine on its own. This puts the whole path in one place.
 *
 * Review artifact only — it never runs. Encoding it back as a branching tree
 * in the prompt is what produced the sprawl.
 *
 * Convention: BLANK = the rule is right as described. Write anything to
 * change it. Conflict rows are pre-marked and are the ones worth the time.
 *
 * Usage: node scripts/publishRefundMap.js [--read]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { PATHS } = require('../eval/refund-map');

const TAB = 'Refund Map';
const DECISION_COL = 6;
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

const NOTE =
  'BLANK = this is right as described.\n' +
  'Write ANYTHING to change it.\n\n' +
  'The rows with something in "Conflict?" are where two rules disagree, or ' +
  'where a rule disagrees with what you actually send. Those are the ones ' +
  'worth your time — the rest are here so the map is complete.';

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

async function main() {
  const spreadsheetId = process.env.KB_REVIEW_SHEET_ID;
  if (!spreadsheetId) throw new Error('KB_REVIEW_SHEET_ID not set');
  const sheets = await getSheetsClient();

  if (hasFlag('read')) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    const [, ...rows] = res.data.values || [];
    const ruled = rows.filter(r => norm(r[DECISION_COL]));
    console.log(`${ruled.length} of ${rows.length} steps ruled on`);
    for (const r of ruled) console.log(JSON.stringify({ step: r[0], ruling: r[DECISION_COL] }));
    return;
  }

  // Carry forward any prior rulings.
  const prior = new Map();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    for (const r of (res.data.values || []).slice(1)) {
      if (norm(r[DECISION_COL])) prior.set(norm(r[0]), norm(r[DECISION_COL]));
    }
  } catch { /* first publish */ }

  const sheetId = await ensureTab(sheets, spreadsheetId, TAB);
  const header = ['Step', 'Type', 'Trigger', 'What we do', 'Where the rule lives', 'Conflict?', 'Change it?'];
  const values = PATHS.map(p => ([
    p.step,
    p.kind === 'gate' ? 'policy gate' : p.kind === 'judgment' ? 'judgment' : 'reply content',
    p.trigger, p.decision, p.lives, p.conflict || '',
    prior.get(norm(p.step)) || '',
  ]));

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [header, ...values] },
  });

  const widths = [230, 105, 300, 420, 250, 420, 240];
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(textFormat,wrapStrategy)' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { note: NOTE }, fields: 'note' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
    // Conflict column tinted so the rows that need him are obvious at a glance.
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: 5, endColumnIndex: 6 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.92, blue: 0.92 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
  ];
  widths.forEach((w, i) => requests.push({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' },
  }));
  for (const c of [0, 2, 3, 4]) requests.push({
    repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  const conflicts = PATHS.filter(p => p.conflict).length;
  console.log(`Published ${values.length} steps to "${TAB}" — ${conflicts} flagged as conflicts`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
