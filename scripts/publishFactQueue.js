#!/usr/bin/env node

/**
 * Publish the pending advisor_facts queue for founder approval.
 *
 * Why it matters: operator-only knowledge is the largest divergence cluster
 * (~37% in the 2026-07 sweep) and `advisor_facts` is the mechanism built to
 * close it — approved facts render verbatim in the advisor's static prompt.
 * The queue has 45 pending and nothing has been approved since 2026-07-10,
 * because the judge's substring dedupe let the same fact through once per
 * rephrasing and the queue filled with noise. A fact queue nobody reviews is
 * the same as not having one.
 *
 * Near-duplicates are collapsed to one row here so the same statement is not
 * read five times. The `variants` column shows how many were folded in.
 *
 * Flagged, not auto-rejected: facts that are LOOK-UP-ABLE (a size for a
 * measurement, a price, a stock level). Jamie's own knowledge-precedence rule
 * says those live in their system of record and are fetched by tool, never
 * frozen into prompt text where they go stale silently.
 *
 * Convention: BLANK = approve. Write anything = reject, or the corrected
 * wording, which wins.
 *
 * Usage:
 *   node scripts/publishFactQueue.js [--dry-run]
 *   node scripts/publishFactQueue.js --read
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getSheetsClient } = require('../shared/googleSheetsClient');
const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');
const { factSimilarity, FACT_DUPE_THRESHOLD } = require('../lib/judgeDaily');

const TAB = 'Advisor Facts';
const DECISION_COL = 4;
const hasFlag = n => process.argv.includes(`--${n}`);
const norm = t => (t || '').replace(/\s+/g, ' ').trim();

// Facts whose value depends on data that changes, or that a tool already
// answers. Freezing these into the prompt is how a stale number goes out with
// full confidence months later.
const LOOKUPABLE = [
  /\b\d+\s*(inch|in\b|")/i,          // a measurement -> a size
  /\bsize (16|14|12|medium|small|large|XS|XXS)\b/i,
  /\$\s?\d/,                          // a price
  /\bin stock\b|\bout of stock\b|\brestock/i,
  /\bby (january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
];
const isLookupable = t => LOOKUPABLE.some(re => re.test(t));

/** Collapse near-duplicates, keeping the longest phrasing as representative. */
function cluster(facts) {
  const used = new Set();
  const out = [];
  facts.forEach((f, i) => {
    if (used.has(i)) return;
    const group = [f];
    used.add(i);
    facts.forEach((g, j) => {
      if (j <= i || used.has(j)) return;
      if (factSimilarity(f.fact, g.fact) >= FACT_DUPE_THRESHOLD) { group.push(g); used.add(j); }
    });
    group.sort((a, b) => (b.fact || '').length - (a.fact || '').length);
    out.push({ rep: group[0], variants: group.length, ids: group.map(x => x.id) });
  });
  return out;
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

async function main() {
  const spreadsheetId = process.env.KB_REVIEW_SHEET_ID;
  const sb = getSupabaseClient();

  if (hasFlag('read')) {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    const [, ...rows] = res.data.values || [];
    const rejected = rows.filter(r => norm(r[DECISION_COL]));
    console.log(`approve ${rows.length - rejected.length}/${rows.length}, ${rejected.length} rejected or corrected`);
    for (const r of rejected) console.log(JSON.stringify({ ids: r[0], fact: (r[2] || '').slice(0, 90), ruling: r[DECISION_COL] }));
    return;
  }

  const pending = await fetchAllPaginated(() => sb.from('advisor_facts')
    .select('id,fact,created_at,source_rationale').eq('status', 'pending').order('id'));
  const clusters = cluster(pending);
  clusters.sort((a, b) => Number(isLookupable(a.rep.fact)) - Number(isLookupable(b.rep.fact)) || b.variants - a.variants);

  console.log(`${pending.length} pending -> ${clusters.length} distinct topics`);
  console.log(`  ${clusters.filter(c => isLookupable(c.rep.fact)).length} flagged as look-up-able (should probably not be facts)`);

  if (hasFlag('dry-run')) {
    clusters.forEach(c => console.log(`  ${isLookupable(c.rep.fact) ? '[lookup] ' : '         '}x${c.variants} ${norm(c.rep.fact).slice(0, 120)}`));
    return;
  }

  const sheets = await getSheetsClient();
  const prior = new Map();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
    for (const r of (res.data.values || []).slice(1)) if (norm(r[DECISION_COL])) prior.set(norm(r[2]), norm(r[DECISION_COL]));
  } catch { /* first publish */ }

  const sheetId = await ensureTab(sheets, spreadsheetId, TAB);
  const header = ['ids', 'variants', 'Fact (goes verbatim into the advisor prompt)', 'Watch out', 'Reject or reword?'];
  const values = clusters.map(c => ([
    c.ids.join(','),
    c.variants > 1 ? `${c.variants} phrasings` : '',
    norm(c.rep.fact),
    isLookupable(c.rep.fact) ? 'Looks look-up-able — a tool should fetch this, not the prompt' : '',
    prior.get(norm(c.rep.fact)) || '',
  ]));

  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [header, ...values] },
  });

  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(textFormat,wrapStrategy)' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { note: 'BLANK = approve, it goes into the advisor prompt verbatim.\nWrite anything = reject, or write the corrected wording and yours wins.' }, fields: 'note' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)' } },
  ];
  [90, 90, 640, 300, 260].forEach((w, i) => requests.push({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' },
  }));
  for (const c of [2, 3]) requests.push({
    repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log(`\nPublished ${values.length} rows to "${TAB}"`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { cluster, isLookupable };
