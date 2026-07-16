#!/usr/bin/env node

/**
 * Publish the corpus-harvest review sheets to Google Sheets, and read the
 * founder's checkbox approvals back (project_corpus_harvest, step 3).
 *
 * Markdown review sheets aren't editable in a readable view, so review happens
 * in a Google Sheet (native checkboxes + Notes column), matching the
 * inventory-projection / production-order review pattern.
 *
 * Tabs:
 *   "Reply Corpus Review" — from consolidation verdict JSONL (conflicts +
 *     unpublished facts, bucketed high-signal vs long-tail)
 *   "Voice Rules Review"  — parsed from drafter/voice-rules-2026-07-proposed.md
 *
 * Modes:
 *   --publish (default): (re)write both tabs. OVERWRITES checkbox state — only
 *     re-publish deliberately.
 *   --read: print checked rows (facts as JSON lines, voice rules as a list)
 *   --read --apply: additionally write approved FACTS into Supabase — a
 *     kb_sources provenance row (source_type 'sent_reply') + a kb_candidates
 *     row (trust 'reply_corpus') per approved fact. Approved VOICE RULES are
 *     printed only; folding them into the advisor prompt is its own change.
 *
 * Usage:
 *   node customer-service/import/publishReviewSheets.js --sheet-id=<id>            # publish
 *   node customer-service/import/publishReviewSheets.js --sheet-id=<id> --read
 *   node customer-service/import/publishReviewSheets.js --sheet-id=<id> --read --apply
 *   (--sheet-id falls back to env KB_REVIEW_SHEET_ID)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const crypto = require('crypto');
const { getSheetsClient } = require('../../shared/googleSheetsClient');

// temp-analysis-data is untracked and lives in the main checkout — override
// with --verdicts-dir when running from a worktree.
const dirArg = process.argv.find(a => a.startsWith('--verdicts-dir='));
const VERDICTS_DIR = dirArg
  ? path.resolve(dirArg.split('=')[1])
  : path.resolve(__dirname, '../..', 'temp-analysis-data/kb-mine/verdicts');
const VOICE_MD = path.resolve(__dirname, '../drafter/voice-rules-2026-07-proposed.md');
const FACTS_TAB = 'Reply Corpus Review';
const VOICE_TAB = 'Voice Rules Review';
const HIGH_SIGNAL_SEEN = 3;

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

// Parse the voice-rules markdown into structured rules.
// Structure: "## <group>" headings, "### [ ] Rule N: <title>" entries with
// "- **Rule:**", "- **Evidence:**", "- **Advisor today:**", "- **Proposed action:**" bullets.
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

function loadVerdicts(dir) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l.trim())) {
      try { rows.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  }
  const conflicts = rows.filter(r => r.verdict === 'conflict');
  const unpublished = rows.filter(r => r.verdict === 'unpublished').sort((a, b) => (b.seen || 1) - (a.seen || 1));
  const bucketed = [
    ...conflicts.map(r => ({ ...r, bucket: 'CONFLICT' })),
    ...unpublished.filter(r => (r.seen || 1) >= HIGH_SIGNAL_SEEN).map(r => ({ ...r, bucket: 'high-signal' })),
    ...unpublished.filter(r => (r.seen || 1) < HIGH_SIGNAL_SEEN).map(r => ({ ...r, bucket: 'long-tail' })),
  ];
  return bucketed;
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

async function writeTab(sheets, spreadsheetId, title, header, rows, { checkboxCol = 0, widths = [], wrapCols = [] } = {}) {
  const sheetId = await ensureTab(sheets, spreadsheetId, title);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  const requests = [
    // checkboxes on the approve column for all data rows
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: checkboxCol, endColumnIndex: checkboxCol + 1 },
        rule: { condition: { type: 'BOOLEAN' }, strict: true },
      },
    },
    // bold frozen header
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
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

async function publish(sheets, spreadsheetId) {
  const facts = loadVerdicts(VERDICTS_DIR);
  const factHeader = ['Approve', '#', 'Bucket', 'Category', 'Fact', 'Conflicts with', 'Last stated', 'Seen', 'Quote', 'Notes'];
  const factRows = facts.map((r, i) => [
    false, i + 1, r.bucket, r.category || '', r.fact || '',
    typeof r.conflict_with === 'string' ? r.conflict_with : (r.conflict_with ? JSON.stringify(r.conflict_with) : ''),
    (r.date || '').slice(0, 10), r.seen || 1, (r.quote || '').slice(0, 400), '',
  ]);
  const nFacts = await writeTab(sheets, spreadsheetId, FACTS_TAB, factHeader, factRows,
    { checkboxCol: 0, widths: [70, 40, 90, 90, 420, 380, 95, 50, 340, 220], wrapCols: [4, 5, 8, 9] });

  const rules = parseVoiceRules(fs.readFileSync(VOICE_MD, 'utf8'));
  const voiceHeader = ['Adopt', '#', 'Group', 'Rule', 'Detail', 'Advisor today', 'Proposed action', 'Notes'];
  const voiceRows = rules.map(r => [false, r.num, r.group, r.title, r.rule, r.advisor_today, r.action, '']);
  const nRules = await writeTab(sheets, spreadsheetId, VOICE_TAB, voiceHeader, voiceRows,
    { checkboxCol: 0, widths: [70, 40, 130, 300, 420, 320, 150, 220], wrapCols: [3, 4, 5, 9] });

  console.log(`Published: "${FACTS_TAB}" ${nFacts} rows, "${VOICE_TAB}" ${nRules} rows`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

async function readTab(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'` });
  const [header, ...rows] = res.data.values || [];
  if (!header) return [];
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const truthy = v => v === true || v === 'TRUE' || v === 'true';

async function readBack(sheets, spreadsheetId, { apply }) {
  const facts = (await readTab(sheets, spreadsheetId, FACTS_TAB)).filter(r => truthy(r.Approve));
  const rules = (await readTab(sheets, spreadsheetId, VOICE_TAB)).filter(r => truthy(r.Adopt));

  console.log(`Approved facts: ${facts.length}`);
  for (const f of facts) console.log('  ' + JSON.stringify({ fact: f.Notes ? `${f.Fact} [note: ${f.Notes}]` : f.Fact, category: f.Category, bucket: f.Bucket }));
  console.log(`Adopted voice rules: ${rules.length}`);
  for (const r of rules) console.log(`  Rule ${r['#']} (${r.Group}): ${r.Rule}${r.Notes ? ` [note: ${r.Notes}]` : ''}`);

  if (!apply) { console.log('\nRead-only (pass --apply to write approved facts to Supabase).'); return; }

  const { getSupabaseClient } = require('../../shared/supabaseClient');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();
  let written = 0;
  for (const f of facts) {
    // Approved reply-corpus facts get a kb_sources provenance row (there is no
    // public URL — the "source" is what we told customers) plus a kb_candidates
    // row at trust 'reply_corpus'. The founder's approval on the sheet is the
    // review gate, so the candidate is born status 'candidate' like the rest.
    const slug = crypto.createHash('sha256').update(f.Fact).digest('hex').slice(0, 12);
    const sourceId = `reply:${slug}`;
    const content = f.Notes ? `${f.Fact}\n\nFounder note: ${f.Notes}` : f.Fact;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const { error: e1 } = await sb.from('kb_sources').upsert([{
      id: sourceId,
      source_type: 'sent_reply',
      source_url: `internal://reply-corpus/2026-07/${slug}`,
      title: f.Fact.slice(0, 120),
      content,
      content_hash: hash,
      meta: { bucket: f.Bucket, seen: parseInt(f.Seen, 10) || 1, last_stated: f['Last stated'] || null, quote: (f.Quote || '').slice(0, 400) },
      status: 'active',
      extracted_at: now,
      last_fetched_at: now,
      last_changed_at: now,
    }], { onConflict: 'id' });
    if (e1) throw new Error(`kb_sources write failed: ${e1.message}`);
    const { error: e2 } = await sb.from('kb_candidates').upsert([{
      id: `${sourceId}#main`,
      source_id: sourceId,
      source_url: `internal://reply-corpus/2026-07/${slug}`,
      title: f.Fact.slice(0, 120),
      category: f.Category || 'faq',
      content,
      trust: 'reply_corpus',
      status: 'candidate',
      source_hash: hash,
      updated_at: now,
    }], { onConflict: 'id' });
    if (e2) throw new Error(`kb_candidates write failed: ${e2.message}`);
    written++;
  }
  console.log(`\nApplied: ${written} approved facts → kb_sources (sent_reply) + kb_candidates (reply_corpus)`);
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const idArg = args.find(a => a.startsWith('--sheet-id='));
  const spreadsheetId = idArg ? idArg.split('=')[1] : process.env.KB_REVIEW_SHEET_ID;
  if (!spreadsheetId) { console.error('usage: node customer-service/import/publishReviewSheets.js --sheet-id=<id> [--read [--apply]]  (or set KB_REVIEW_SHEET_ID)'); process.exit(1); }
  const sheets = await getSheetsClient();
  if (args.includes('--read')) return readBack(sheets, spreadsheetId, { apply: args.includes('--apply') });
  return publish(sheets, spreadsheetId);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseVoiceRules, loadVerdicts };
