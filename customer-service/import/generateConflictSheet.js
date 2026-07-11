#!/usr/bin/env node

/**
 * Assemble the founder-review conflict sheet from consolidated mining verdicts
 * (corpus harvest step 3 — see kb-mining-protocol.md).
 *
 * Input: verdict JSONL files produced by the consolidation subagents
 * (fields: fact, category, verdict, date, seen, quote, message_id, match_id,
 * conflict_with, drop_reason).
 *
 * Output: a checkbox-style markdown sheet. Conflicts first (all of them),
 * then unpublished facts split into high-signal (seen >= HIGH_SIGNAL_SEEN)
 * and long-tail sections. Published/drop buckets are summarized as counts.
 *
 * Usage:
 *   node customer-service/import/generateConflictSheet.js <verdictDir> <out.md> [--high-seen=3]
 */

const path = require('path');
const fs = require('fs');

const [dir, outPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!dir || !outPath) {
  console.error('usage: node customer-service/import/generateConflictSheet.js <verdictDir> <out.md> [--high-seen=3]');
  process.exit(1);
}
const highArg = process.argv.find(a => a.startsWith('--high-seen='));
const HIGH_SIGNAL_SEEN = highArg ? parseInt(highArg.split('=')[1], 10) : 3;

const rows = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l.trim())) {
    try { rows.push(JSON.parse(line)); } catch { console.error(`skipping bad line in ${f}`); }
  }
}

const by = v => rows.filter(r => r.verdict === v);
const conflicts = by('conflict');
const unpublished = by('unpublished').sort((a, b) => (b.seen || 1) - (a.seen || 1));
const highSignal = unpublished.filter(r => (r.seen || 1) >= HIGH_SIGNAL_SEEN);
const longTail = unpublished.filter(r => (r.seen || 1) < HIGH_SIGNAL_SEEN);
const published = by('published');
const dropped = by('drop');

const CATS = ['policy', 'sizing', 'shipping', 'product', 'program', 'community', 'company', 'wholesale', 'faq'];
const catSort = (a, b) => CATS.indexOf(a.category) - CATS.indexOf(b.category) || (b.seen || 1) - (a.seen || 1);

function entry(r, i, { withConflict } = {}) {
  const date = (r.date || '').slice(0, 10);
  const seen = r.seen && r.seen > 1 ? `, seen ${r.seen}x` : '';
  let md = `### [ ] ${i}. ${r.fact}\n`;
  md += `- Category: ${r.category} | Last stated: ${date}${seen}\n`;
  if (withConflict && r.conflict_with) md += `- **Conflicts with:** ${typeof r.conflict_with === 'string' ? r.conflict_with : JSON.stringify(r.conflict_with)}\n`;
  if (r.quote) md += `- Quote: "${String(r.quote).slice(0, 220)}"\n`;
  return md + '\n';
}

let md = `# Reply-Corpus Mine — Review Sheet (2026-07, phase 1)

Mined from ${rows.length} consolidated verdicts over 6 years of sent replies
(batches 1-15 = 2026 era, batches 63-65 = hand-written era 2020-2025; batches
16-62 = 2025 advisor era, parked for a later phase). Recency rule applied:
newer statements supersede older; conflicts show both sides with dates.

**How to review:** check the box to APPROVE an item (conflicts: check = the
mined fact is right and the other side is wrong/stale; leave unchecked = the
published/newer side stands). Add a note under any item to correct wording.
Approved unpublished facts become KB candidates (trust: reply_corpus).

Buckets: ${conflicts.length} conflicts (review all) · ${highSignal.length} high-signal unpublished (seen ${HIGH_SIGNAL_SEEN}+ times) · ${longTail.length} long-tail unpublished (optional) · ${published.length} already published (dropped silently) · ${dropped.length} dropped (superseded/perishable/order-specific).

---

## Part 1 — CONFLICTS (${conflicts.length}) — please review all

`;

let n = 0;
for (const cat of CATS) {
  const items = conflicts.filter(r => r.category === cat).sort(catSort);
  if (!items.length) continue;
  md += `## ${cat.toUpperCase()}\n\n`;
  for (const r of items) md += entry(r, ++n, { withConflict: true });
}

md += `---\n\n## Part 2 — UNPUBLISHED KNOWLEDGE, high-signal (${highSignal.length}) — stated ${HIGH_SIGNAL_SEEN}+ times, nowhere on the site\n\n`;
for (const cat of CATS) {
  const items = highSignal.filter(r => r.category === cat).sort(catSort);
  if (!items.length) continue;
  md += `## ${cat.toUpperCase()}\n\n`;
  for (const r of items) md += entry(r, ++n);
}

md += `---\n\n## Part 3 — UNPUBLISHED KNOWLEDGE, long tail (${longTail.length}) — stated once or twice; review when you have time\n\n`;
for (const cat of CATS) {
  const items = longTail.filter(r => r.category === cat).sort(catSort);
  if (!items.length) continue;
  md += `## ${cat.toUpperCase()}\n\n`;
  for (const r of items) md += entry(r, ++n);
}

fs.writeFileSync(outPath, md);
console.log(`${outPath}: ${n} reviewable items (${conflicts.length} conflicts, ${highSignal.length} high-signal, ${longTail.length} long-tail); ${published.length} published + ${dropped.length} dropped summarized.`);
