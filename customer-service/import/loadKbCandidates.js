#!/usr/bin/env node

/**
 * Load extracted KB candidates into kb_candidates (corpus harvest, step 2).
 *
 * Input: JSONL files produced per customer-service/import/kb-extraction-protocol.md
 * (one line per kb_sources row: decision extracted|dropped + candidates[]).
 *
 * - Validates shape, category enum, content length, and that source_hash still
 *   matches the live kb_sources row (stale extraction = loud warn, row skipped).
 * - Upserts candidates by id (<source_id>#<slug>); candidates that existed for
 *   a re-extracted source but are absent from the new output get status='dropped'.
 * - Stamps kb_sources.extracted_at for every source present in the input.
 *
 * Usage:
 *   node customer-service/import/loadKbCandidates.js out/*.jsonl
 *   node customer-service/import/loadKbCandidates.js out/*.jsonl --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const CATEGORIES = ['product', 'sizing', 'shipping', 'policy', 'program', 'community', 'wholesale', 'company', 'faq'];
const MIN_CHARS = 40;
const MAX_CHARS = 8000;

// Exported for tests: validate one JSONL record against the protocol.
// Returns { ok: true, record } or { ok: false, errors: [...] }.
function validateRecord(raw) {
  const errors = [];
  const rec = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!rec || typeof rec !== 'object') return { ok: false, errors: ['not valid JSON object'] };

  if (!rec.source_id || typeof rec.source_id !== 'string') errors.push('missing source_id');
  if (!rec.source_hash || typeof rec.source_hash !== 'string') errors.push('missing source_hash');
  if (!['extracted', 'dropped'].includes(rec.decision)) errors.push(`bad decision: ${rec.decision}`);

  if (rec.decision === 'dropped') {
    if (!rec.reason) errors.push('dropped without reason');
    if (rec.candidates?.length) errors.push('dropped record must not carry candidates');
  }
  if (rec.decision === 'extracted') {
    if (!Array.isArray(rec.candidates) || rec.candidates.length === 0) {
      errors.push('extracted record needs candidates[]');
    } else {
      const slugs = new Set();
      for (const c of rec.candidates) {
        if (!c.slug || !/^[a-z0-9][a-z0-9-]*$/.test(c.slug)) errors.push(`bad slug: ${c.slug}`);
        if (slugs.has(c.slug)) errors.push(`duplicate slug: ${c.slug}`);
        slugs.add(c.slug);
        if (!c.title) errors.push(`candidate ${c.slug}: missing title`);
        if (!CATEGORIES.includes(c.category)) errors.push(`candidate ${c.slug}: bad category ${c.category}`);
        const len = (c.content || '').trim().length;
        if (len < MIN_CHARS || len > MAX_CHARS) errors.push(`candidate ${c.slug}: content ${len} chars (need ${MIN_CHARS}-${MAX_CHARS})`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, record: rec };
}

async function loadSources(supabase) {
  const sources = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('kb_sources')
      .select('id, source_url, content_hash, status')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`kb_sources read failed: ${error.message}`);
    for (const row of data) sources.set(row.id, row);
    if (data.length < PAGE) break;
  }
  return sources;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node customer-service/import/loadKbCandidates.js <file.jsonl> [...] [--dry-run]');
    process.exit(1);
  }

  // Parse + validate all input before touching the DB
  const records = [];
  let invalid = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    for (const [i, line] of lines.entries()) {
      const res = validateRecord(line);
      if (!res.ok) {
        invalid++;
        console.error(`  [INVALID] ${path.basename(file)}:${i + 1} — ${res.errors.join('; ')}`);
        continue;
      }
      records.push(res.record);
    }
  }
  if (invalid) {
    console.error(`\n${invalid} invalid record(s) — fix the extraction output and re-run. Nothing written.`);
    process.exit(1);
  }

  const dupSources = records.map(r => r.source_id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupSources.length) {
    console.error(`Duplicate source_id(s) across input: ${[...new Set(dupSources)].join(', ')}. Nothing written.`);
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const sources = await loadSources(supabase);

  const now = new Date().toISOString();
  const upserts = [];
  const extractedSourceIds = [];
  let stale = 0, unknown = 0, dropped = 0;

  for (const rec of records) {
    const src = sources.get(rec.source_id);
    if (!src) {
      unknown++;
      console.warn(`  [WARN] ${rec.source_id}: not in kb_sources — skipped`);
      continue;
    }
    if (src.content_hash !== rec.source_hash) {
      stale++;
      console.warn(`  [WARN] ${rec.source_id}: source changed since extraction (stale hash) — skipped, re-extract it`);
      continue;
    }
    extractedSourceIds.push(rec.source_id);
    if (rec.decision === 'dropped') { dropped++; continue; }
    for (const c of rec.candidates) {
      upserts.push({
        id: `${rec.source_id}#${c.slug}`,
        source_id: rec.source_id,
        source_url: src.source_url,
        title: c.title,
        category: c.category,
        content: c.content.trim(),
        trust: 'published',
        status: 'candidate',
        source_hash: rec.source_hash,
        updated_at: now,
      });
    }
  }

  console.log(`\nParsed ${records.length} sources: ${upserts.length} candidates from ${extractedSourceIds.length - dropped} extracted, ${dropped} dropped, ${stale} stale, ${unknown} unknown`);

  if (dryRun) { console.log('Dry run — nothing written.'); return; }

  for (let i = 0; i < upserts.length; i += 100) {
    const chunk = upserts.slice(i, i + 100);
    const { error } = await supabase.from('kb_candidates').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`kb_candidates upsert failed: ${error.message}`);
  }

  // A re-extracted source may have shed a topic: mark its candidates that are
  // no longer produced as dropped (narrow per-source cleanup, concurrency-safe).
  const newIds = new Set(upserts.map(u => u.id));
  let shed = 0;
  for (let i = 0; i < extractedSourceIds.length; i += 100) {
    const chunk = extractedSourceIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from('kb_candidates')
      .select('id')
      .in('source_id', chunk)
      .neq('status', 'dropped');
    if (error) throw new Error(`kb_candidates read failed: ${error.message}`);
    const toDrop = data.map(r => r.id).filter(id => !newIds.has(id));
    if (toDrop.length) {
      const { error: dropErr } = await supabase
        .from('kb_candidates')
        .update({ status: 'dropped', updated_at: now })
        .in('id', toDrop);
      if (dropErr) throw new Error(`kb_candidates drop failed: ${dropErr.message}`);
      shed += toDrop.length;
    }
  }

  for (let i = 0; i < extractedSourceIds.length; i += 200) {
    const chunk = extractedSourceIds.slice(i, i + 200);
    const { error } = await supabase
      .from('kb_sources')
      .update({ extracted_at: now })
      .in('id', chunk);
    if (error) throw new Error(`kb_sources extracted_at stamp failed: ${error.message}`);
  }

  console.log(`kb_candidates: ${upserts.length} upserted, ${shed} superseded candidates marked dropped, ${extractedSourceIds.length} sources stamped extracted_at`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { validateRecord, CATEGORIES };
