#!/usr/bin/env node

/**
 * Publish the corpus-harvest review sheets to Google Sheets, and read the
 * founder's decisions back (project_corpus_harvest, step 3).
 *
 * v2 (2026-07-16, after Jamie's review feedback):
 * - Conflicts are merged ONE ROW PER TOPIC (a paired conflict is one decision,
 *   not N independent rows). Topics live in <dataDir>/conflict-topics.json,
 *   authored per mining phase; underlying verdicts in conflicts-full.json.
 * - No checkboxes. Every tab has a free-text decision column ("Your ruling" /
 *   "Your call"): blank = not reviewed, "yes"/"ok" = approve as written,
 *   "no" = reject, anything longer = the founder's correction/explanation and
 *   it WINS over the proposed text. Interpretation of free text is Claude's
 *   job at read-back — the script never parses meaning.
 *
 * Tabs: "Conflicts" (topics), "New Facts" (unpublished, high-signal first),
 * "Voice Rules" (parsed from drafter/voice-rules-2026-07-proposed.md).
 *
 * Modes:
 *   --publish (default): (re)write all tabs. OVERWRITES decisions — only
 *     re-publish deliberately. Removes the v1 checkbox tabs if present.
 *   --read: print every row with a non-empty decision, as JSON lines, for
 *     Claude to interpret in-session.
 *   --apply-file=<curated.jsonl>: write curated approved facts to Supabase —
 *     one kb_sources provenance row (source_type 'sent_reply') + one
 *     kb_candidates row (trust 'reply_corpus') each. Records:
 *     {fact, category, meta?} per line. Produced by Claude after --read.
 *
 * Usage:
 *   node customer-service/import/publishReviewSheets.js [--sheet-id=<id>] [--data-dir=<dir>]
 *   node customer-service/import/publishReviewSheets.js --read
 *   node customer-service/import/publishReviewSheets.js --apply-file=approved.jsonl
 *   (--sheet-id falls back to env KB_REVIEW_SHEET_ID)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const crypto = require('crypto');
const { getSheetsClient } = require('../../shared/googleSheetsClient');

const VOICE_MD = path.resolve(__dirname, '../drafter/voice-rules-2026-07-proposed.md');
const CONFLICTS_TAB = 'Conflicts';
const FACTS_TAB = 'New Facts';
const VOICE_TAB = 'Voice Rules';
const V1_TABS = ['Reply Corpus Review', 'Voice Rules Review'];
const HIGH_SIGNAL_SEEN = 3;

const DECISION_NOTE = 'Blank = not reviewed yet. "yes" or "ok" = approve as written. "no" = reject/dead. Write anything longer and YOUR text wins (corrections, the real answer, an explanation). Claude reads this column back with judgment, so plain English is fine.';

function arg(name, dflt) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
}

// ---------------------------------------------------------------------------
// Parsers / loaders (exported for tests)
// ---------------------------------------------------------------------------

function parseVoiceRules(md) {
  const rules = [];
  let group = '';
  let current = null;
  const flush = () => { if (current) rules.push(current); current = null; };
  for (const line of md.split('\n')) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) { flush(); group = h2[1].trim(); continue; }
    const h3 = line.match(/^### \[[ xX]?\] Rule (\d+)[^:]*: (.+)$/);
    if (h3) { flush(); current = { num: parseInt(h3[1], 10), group, title: h3[2].trim(), rule: '', evidence: '', advisor_today: '', action: '' }; continue; }
    if (!current) continue;
    const bullet = line.match(/^- \*\*(Rule|Evidence|Advisor today|Proposed action)[^:]*:\*\*\s*(.*)$/);
    if (bullet) {
      const key = { 'Rule': 'rule', 'Evidence': 'evidence', 'Advisor today': 'advisor_today', 'Proposed action': 'action' }[bullet[1]];
      current[key] = bullet[2].trim();
    }
  }
  flush();
  return rules;
}

function loadUnpublished(dataDir) {
  const rows = [];
  const dir = path.join(dataDir, 'verdicts');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l.trim())) {
      try { const r = JSON.parse(line); if (r.verdict === 'unpublished') rows.push(r); } catch { /* skip */ }
    }
  }
  rows.sort((a, b) => (b.seen || 1) - (a.seen || 1));
  return rows.map(r => ({ ...r, bucket: (r.seen || 1) >= HIGH_SIGNAL_SEEN ? 'high-signal' : 'long-tail' }));
}

function loadConflictTopics(dataDir) {
  const topics = JSON.parse(fs.readFileSync(path.join(dataDir, 'conflict-topics.json'), 'utf8')).topics;
  const full = JSON.parse(fs.readFileSync(path.join(dataDir, 'conflicts-full.json'), 'utf8'));
  const covered = new Set(topics.flatMap(t => t.idx));
  // Safety: any conflict not covered by an authored topic gets its own row.
  full.forEach((r, i) => {
    if (!covered.has(i)) topics.push({ title: r.fact.slice(0, 80), idx: [i], question: r.fact, my_read: r.conflict_with || '' });
  });
  return topics.map(t => ({
    ...t,
    evidence: t.idx.map(i => {
      const r = full[i];
      return `[${(r.date || '').slice(0, 10)}${r.seen > 1 ? `, ${r.seen}x` : ''}] ${r.fact}${r.conflict_with ? `\n   vs: ${r.conflict_with}` : ''}`;
    }).join('\n\n'),
  }));
}

// ---------------------------------------------------------------------------
// Sheet writing
// ---------------------------------------------------------------------------

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

async function removeV1Tabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const requests = meta.data.sheets
    .filter(s => V1_TABS.includes(s.properties.title))
    .map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } }));
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return requests.length;
}

async function writeTab(sheets, spreadsheetId, title, header, rows, { decisionCol, widths = [], wrapCols = [] }) {
  const sheetId = await ensureTab(sheets, spreadsheetId, title);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    // decision column: note explaining the free-text convention + light tint
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: decisionCol, endColumnIndex: decisionCol + 1 },
        cell: { note: DECISION_NOTE },
        fields: 'note',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: decisionCol, endColumnIndex: decisionCol + 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.98, blue: 0.9 }, wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)',
      },
    },
  ];
  widths.forEach((w, i) => {
    if (!w) return;
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });
  for (const c of wrapCols) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return rows.length;
}

async function publish(sheets, spreadsheetId, dataDir) {
  const removed = await removeV1Tabs(sheets, spreadsheetId);
  if (removed) console.log(`Removed ${removed} v1 checkbox tab(s)`);

  const topics = loadConflictTopics(dataDir);
  const conflictHeader = ['#', 'Topic', 'The question', 'What we\'ve said (dated)', 'My read', 'Your ruling'];
  const conflictRows = topics.map((t, i) => [i + 1, t.title, t.question, t.evidence, t.my_read || '', t.ruling_prefill || '']);
  const nConf = await writeTab(sheets, spreadsheetId, CONFLICTS_TAB, conflictHeader, conflictRows,
    { decisionCol: 5, widths: [35, 210, 340, 430, 300, 260], wrapCols: [1, 2, 3, 4] });

  const facts = loadUnpublished(dataDir);
  const factHeader = ['#', 'Priority', 'Category', 'Fact (as we\'ve told customers)', 'Last stated', 'Seen', 'Quote', 'Your call'];
  const factRows = facts.map((r, i) => [
    i + 1, r.bucket, r.category || '', r.fact || '', (r.date || '').slice(0, 10), r.seen || 1, (r.quote || '').slice(0, 300), '',
  ]);
  const nFacts = await writeTab(sheets, spreadsheetId, FACTS_TAB, factHeader, factRows,
    { decisionCol: 7, widths: [35, 90, 90, 430, 95, 45, 320, 260], wrapCols: [3, 6] });

  const rules = parseVoiceRules(fs.readFileSync(VOICE_MD, 'utf8'));
  const voiceHeader = ['#', 'Group', 'Rule', 'Detail', 'Advisor today', 'Proposed action', 'Your call'];
  const voiceRows = rules.map(r => [r.num, r.group, r.title, r.rule, r.advisor_today, r.action, '']);
  const nRules = await writeTab(sheets, spreadsheetId, VOICE_TAB, voiceHeader, voiceRows,
    { decisionCol: 6, widths: [35, 125, 280, 400, 300, 140, 260], wrapCols: [2, 3, 4] });

  console.log(`Published: "${CONFLICTS_TAB}" ${nConf} topics, "${FACTS_TAB}" ${nFacts} facts, "${VOICE_TAB}" ${nRules} rules`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

// ---------------------------------------------------------------------------
// Read-back — dump decided rows verbatim; Claude interprets, not code
// ---------------------------------------------------------------------------

async function readTab(sheets, spreadsheetId, title, decisionHeader) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'` });
  const [header, ...rows] = res.data.values || [];
  if (!header) return [];
  return rows
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])))
    .filter(r => (r[decisionHeader] || '').trim());
}

async function readBack(sheets, spreadsheetId) {
  const conflicts = await readTab(sheets, spreadsheetId, CONFLICTS_TAB, 'Your ruling');
  const facts = await readTab(sheets, spreadsheetId, FACTS_TAB, 'Your call');
  const rules = await readTab(sheets, spreadsheetId, VOICE_TAB, 'Your call');
  console.log(`# Conflicts with rulings: ${conflicts.length}`);
  for (const r of conflicts) console.log(JSON.stringify({ tab: 'conflicts', topic: r.Topic, question: r['The question'], ruling: r['Your ruling'] }));
  console.log(`# Facts with calls: ${facts.length}`);
  for (const r of facts) console.log(JSON.stringify({ tab: 'facts', fact: r['Fact (as we\'ve told customers)'], category: r.Category, priority: r.Priority, seen: r.Seen, call: r['Your call'] }));
  console.log(`# Voice rules with calls: ${rules.length}`);
  for (const r of rules) console.log(JSON.stringify({ tab: 'voice', num: r['#'], rule: r.Rule, call: r['Your call'] }));
}

// ---------------------------------------------------------------------------
// Apply — curated file only (Claude interprets decisions, then feeds this)
// ---------------------------------------------------------------------------

async function applyFile(file) {
  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();
  let written = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())) {
    const rec = JSON.parse(line);
    if (!rec.fact || !rec.category) throw new Error(`apply-file record needs fact + category: ${line.slice(0, 120)}`);
    const slug = crypto.createHash('sha256').update(rec.fact).digest('hex').slice(0, 12);
    const sourceId = `reply:${slug}`;
    const hash = crypto.createHash('sha256').update(rec.fact).digest('hex');
    const { error: e1 } = await sb.from('kb_sources').upsert([{
      id: sourceId,
      source_type: 'sent_reply',
      source_url: `internal://reply-corpus/${slug}`,
      title: rec.fact.slice(0, 120),
      content: rec.fact,
      content_hash: hash,
      meta: rec.meta || {},
      status: 'active',
      extracted_at: now,
      last_fetched_at: now,
      last_changed_at: now,
    }], { onConflict: 'id' });
    if (e1) throw new Error(`kb_sources write failed: ${e1.message}`);
    const { error: e2 } = await sb.from('kb_candidates').upsert([{
      id: `${sourceId}#main`,
      source_id: sourceId,
      source_url: `internal://reply-corpus/${slug}`,
      title: rec.fact.slice(0, 120),
      category: rec.category,
      content: rec.fact,
      trust: 'reply_corpus',
      status: 'candidate',
      source_hash: hash,
      updated_at: now,
    }], { onConflict: 'id' });
    if (e2) throw new Error(`kb_candidates write failed: ${e2.message}`);
    written++;
  }
  console.log(`Applied ${written} facts → kb_sources (sent_reply) + kb_candidates (reply_corpus)`);
}

// ---------------------------------------------------------------------------

async function main() {
  const applyPath = arg('apply-file', null);
  if (applyPath) return applyFile(applyPath);

  const spreadsheetId = arg('sheet-id', process.env.KB_REVIEW_SHEET_ID);
  if (!spreadsheetId) { console.error('usage: node customer-service/import/publishReviewSheets.js [--sheet-id=<id>] [--data-dir=<dir>] [--read | --apply-file=<f>]'); process.exit(1); }
  const dataDir = path.resolve(arg('data-dir', path.resolve(__dirname, '../..', 'temp-analysis-data/kb-mine')));
  const sheets = await getSheetsClient();
  if (process.argv.includes('--read')) return readBack(sheets, spreadsheetId);
  return publish(sheets, spreadsheetId, dataDir);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseVoiceRules, loadUnpublished, loadConflictTopics };
