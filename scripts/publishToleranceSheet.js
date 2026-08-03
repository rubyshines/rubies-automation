#!/usr/bin/env node

/**
 * Tolerance-check review sheet.
 *
 * Why this exists (2026-08-03): the advisor's headline quality metric is the
 * share of drafts Jamie sends WITHOUT editing (~50% on the plateau since late
 * May). Jamie flagged that this over-reads: he often can't be bothered to
 * rewrite, so he ships drafts he wouldn't have written. An unedited send is
 * therefore an UNLABELED sample, not a positive one — which means every
 * quality number downstream (closeness judge, advisorEditRate tripwire, the
 * auto-send / steer-send shadow gates) sits on an unmeasured optimistic bias.
 *
 * This publishes a stratified sample of UNEDITED sends for a one-time founder
 * pass. Output is a single number per turn bucket: what fraction of the drafts
 * he let through would he actually have written that way. That calibrates
 * everything else.
 *
 * Stratification is by TURN ORDINAL, because the unedited rate climbs steeply
 * with it (40% at turn 1 → 78% at turn 4+) and the two readings of that
 * gradient — "the advisor gets better with context" vs "Jamie stops caring" —
 * are indistinguishable from the data alone. A proportional random sample
 * would blend them into one meaningless number. Secondary spread is across
 * message_type so a bucket isn't accidentally all sizing questions.
 *
 * Review convention follows the existing founder review sheets: BLANK means
 * "I'd have sent this". Write anything at all to mean "I'd have written this
 * differently" — a word is enough, a reason is better.
 *
 * Usage:
 *   node scripts/publishToleranceSheet.js                 # publish the tab
 *   node scripts/publishToleranceSheet.js --dry-run       # print, don't write
 *   node scripts/publishToleranceSheet.js --read          # read decisions back
 *   node scripts/publishToleranceSheet.js --since=2026-06-01 --per-bucket=10
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { getSupabaseClient } = require('../shared/supabaseClient');
const { getSheetsClient } = require('../shared/googleSheetsClient');

const TAB = 'Tolerance Check';
const DEFAULT_SINCE = '2026-06-01';   // the plateau period — the rate we need to calibrate
const HISTORY_FROM = '2026-03-01';    // far enough back to compute turn ordinals correctly
const DEFAULT_PER_BUCKET = 10;
const BUCKETS = ['1', '2', '3', '4+'];

// Drafts that were never an inbound advisor reply — outbound composers seed
// operator_steer too, so they'd otherwise pollute both the sample and any
// steer analysis run off the same table.
const EXCLUDED_TYPES = new Set(['proactive_outreach']);
const EXCLUDED_SOURCES = new Set(['operator_outreach']);

const DECISION_NOTE =
  'BLANK = you would have sent this as-is.\n' +
  'Write ANYTHING = you would have written it differently. One word is fine; ' +
  'a short reason is better ("too long", "should have just done the exchange", ' +
  '"wrong tone").\n\n' +
  'Do not rewrite the draft. We only need the yes/no plus a hint at why.';

function arg(name, dflt) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
}
const hasFlag = name => process.argv.includes(`--${name}`);

const norm = t => (t || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Sampling (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Assign each draft its 1-indexed position within its own ticket, ordered by
 * created_at. cs_ai_drafts.turn_number is NOT usable for this — it stays 1
 * across a multi-round ticket (verified on ticket 2949, which has two rounds
 * both stamped turn_number 1).
 */
function withTurnOrdinals(drafts) {
  const byTicket = new Map();
  for (const d of drafts) {
    if (!byTicket.has(d.ticket_id)) byTicket.set(d.ticket_id, []);
    byTicket.get(d.ticket_id).push(d);
  }
  const out = [];
  for (const arr of byTicket.values()) {
    arr.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    arr.forEach((d, i) => out.push({ ...d, turn_ordinal: i + 1 }));
  }
  return out;
}

const bucketOf = ordinal => (ordinal >= 4 ? '4+' : String(ordinal));

function isEligible(d, sinceIso) {
  if (d.created_at < sinceIso) return false;
  if (EXCLUDED_TYPES.has(d.message_type)) return false;
  if (EXCLUDED_SOURCES.has(d.source)) return false;
  if (d.draft_kind && d.draft_kind !== 'advisor_draft') return false;
  const draft = norm(d.draft_response);
  if (!draft) return false;
  // Unedited only: the whole question is what he let through untouched.
  return draft === norm(d.sent_response);
}

/**
 * Round-robin across message_type inside each turn bucket so a bucket can't
 * come back all-exchange. Deterministic (sorted by id, no RNG) so a re-publish
 * before review reproduces the same sample rather than silently reshuffling.
 */
function sampleBucket(drafts, perBucket) {
  const byType = new Map();
  for (const d of drafts.slice().sort((a, b) => a.id - b.id)) {
    const k = d.message_type || 'uncategorized';
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(d);
  }
  const types = [...byType.keys()].sort();
  const picked = [];
  let round = 0;
  while (picked.length < perBucket) {
    let addedThisRound = false;
    for (const t of types) {
      if (picked.length >= perBucket) break;
      const list = byType.get(t);
      if (round < list.length) { picked.push(list[round]); addedThisRound = true; }
    }
    if (!addedThisRound) break;   // exhausted every type
    round++;
  }
  return picked;
}

function buildSample(allSentDrafts, { since, perBucket }) {
  const eligible = withTurnOrdinals(allSentDrafts).filter(d => isEligible(d, since));
  const out = [];
  const stats = {};
  for (const b of BUCKETS) {
    const pool = eligible.filter(d => bucketOf(d.turn_ordinal) === b);
    const picked = sampleBucket(pool, perBucket);
    stats[b] = { pool: pool.length, picked: picked.length };
    out.push(...picked);
  }
  return { rows: out, stats };
}

/** Last thing the customer actually said before this draft was written. */
function lastCustomerMessage(draft) {
  const h = draft.conversation_history;
  if (!Array.isArray(h)) return '';
  const msgs = h.filter(m => m && m.sender === 'customer' && !m.is_bot && norm(m.body));
  if (!msgs.length) return '';
  return norm(msgs[msgs.length - 1].body);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function fetchSentDrafts(sb) {
  const cols = 'id,ticket_id,gorgias_ticket_id,message_type,source,draft_kind,' +
               'draft_response,sent_response,conversation_history,created_at';
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('cs_ai_drafts')
      .select(cols)
      .eq('status', 'sent')
      .gte('created_at', HISTORY_FROM)
      .order('created_at')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

const HEADER = ['#', 'Turn', 'Type', 'Customer said', 'What we sent (unedited)', 'Would you have written it differently?'];
const DECISION_COL = 5;

async function ensureTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${title}'` });
    return existing.properties.sheetId;
  }
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function publish(sheets, spreadsheetId, rows) {
  const sheetId = await ensureTab(sheets, spreadsheetId, TAB);
  const values = rows.map((d, i) => ([
    i + 1,
    d.turn_ordinal >= 4 ? '4+' : d.turn_ordinal,
    d.message_type || 'uncategorized',
    clip(lastCustomerMessage(d), 900),
    clip(norm(d.draft_response), 4000),
    '',
  ]));

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER, ...values] },
  });

  const widths = [40, 55, 130, 380, 560, 300];
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(textFormat,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 },
        cell: { note: DECISION_NOTE },
        fields: 'note',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: DECISION_COL, endColumnIndex: DECISION_COL + 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.97, blue: 0.87 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)',
      },
    },
  ];
  widths.forEach((w, i) => requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: w },
      fields: 'pixelSize',
    },
  }));
  for (const c of [3, 4]) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: values.length + 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return values.length;
}

async function readBack(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${TAB}'` });
  const [header, ...rows] = res.data.values || [];
  if (!header) throw new Error(`Tab "${TAB}" not found — publish it first`);
  const totals = {};
  const flagged = [];
  for (const r of rows) {
    const turn = r[1];
    if (!turn) continue;
    const t = totals[turn] = totals[turn] || { n: 0, differently: 0 };
    t.n++;
    const decision = norm(r[DECISION_COL]);
    if (decision) { t.differently++; flagged.push({ n: r[0], turn, type: r[2], decision }); }
  }
  return { totals, flagged };
}

// ---------------------------------------------------------------------------

async function main() {
  const spreadsheetId = arg('sheet-id', process.env.KB_REVIEW_SHEET_ID);
  if (!spreadsheetId) throw new Error('KB_REVIEW_SHEET_ID not set and no --sheet-id given');

  if (hasFlag('read')) {
    const sheets = await getSheetsClient();
    const { totals, flagged } = await readBack(sheets, spreadsheetId);
    console.log('Turn   reviewed   "would write differently"');
    for (const b of BUCKETS) {
      const t = totals[b];
      if (!t) continue;
      const pct = t.n ? (100 * t.differently / t.n).toFixed(0) : '0';
      console.log(`${b.padEnd(7)}${String(t.n).padEnd(11)}${t.differently} (${pct}%)`);
    }
    const n = Object.values(totals).reduce((a, t) => a + t.n, 0);
    const d = Object.values(totals).reduce((a, t) => a + t.differently, 0);
    console.log(`\nOverall tolerance gap: ${d}/${n} (${n ? (100 * d / n).toFixed(0) : 0}%)`);
    console.log('\nFlagged:');
    for (const f of flagged) console.log(JSON.stringify(f));
    return;
  }

  const since = arg('since', DEFAULT_SINCE);
  const perBucket = parseInt(arg('per-bucket', String(DEFAULT_PER_BUCKET)), 10);

  const sb = getSupabaseClient();
  const drafts = await fetchSentDrafts(sb);
  const { rows, stats } = buildSample(drafts, { since, perBucket });

  console.log(`Fetched ${drafts.length} sent drafts (from ${HISTORY_FROM})`);
  console.log(`Sampling unedited inbound advisor drafts since ${since}, ${perBucket} per turn bucket:`);
  for (const b of BUCKETS) console.log(`  turn ${b.padEnd(3)} pool ${String(stats[b].pool).padStart(4)}  picked ${stats[b].picked}`);
  console.log(`Total sample: ${rows.length}`);

  if (hasFlag('dry-run')) {
    for (const d of rows.slice(0, 3)) {
      console.log(`\n--- #${d.id} turn ${d.turn_ordinal} (${d.message_type})`);
      console.log('CUSTOMER: ' + clip(lastCustomerMessage(d), 200));
      console.log('SENT:     ' + clip(norm(d.draft_response), 300));
    }
    console.log('\n(dry run — nothing written)');
    return;
  }

  const sheets = await getSheetsClient();
  const n = await publish(sheets, spreadsheetId, rows);
  console.log(`\nPublished ${n} rows to "${TAB}"`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { withTurnOrdinals, bucketOf, isEligible, sampleBucket, buildSample, lastCustomerMessage };
