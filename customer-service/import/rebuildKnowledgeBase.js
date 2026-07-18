#!/usr/bin/env node

/**
 * Corpus harvest step 4+5: rebuild cs_knowledge_base from kb_candidates.
 *
 * Pushes every kb_candidates row (status candidate|promoted) into
 * cs_knowledge_base as a source-linked, trust-tagged article with a Voyage
 * embedding, then marks the candidate 'promoted'. Idempotent: unchanged rows
 * (same content, embedding present) are skipped, so re-runs are cheap and the
 * weekly refresh can call run() to propagate candidate amendments + re-embed.
 *
 * Legacy retirement: rows whose id is NOT a candidate id (the stale 63-article
 * set) are left alone by default. Pass --retire-legacy to back them up to
 * temp-analysis-data/kb-legacy-backup-<date>.json and delete them (run once,
 * after the rebuilt rows are verified).
 *
 * cs_get_knowledge / cs_search_knowledge consumers keep working throughout:
 * same table, same RPC, rows just improve.
 *
 * Usage:
 *   node customer-service/import/rebuildKnowledgeBase.js [--dry-run] [--retire-legacy]
 * Requires kb-rebuild-migration.sql applied (source_url, trust columns).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { embed } = require('../lib/embeddings');

// Priority: operator-reviewed reply facts rank just under published-site facts;
// both sit above whatever legacy rows remain during transition.
const TRUST_PRIORITY = { published: 5, reply_corpus: 4 };

// Map a kb_candidates row to a cs_knowledge_base row (no embedding yet).
// Exported for tests.
function candidateToArticle(c) {
  return {
    id: c.id,
    title: (c.title || c.content.slice(0, 120)).trim(),
    category: c.category,
    content: c.content,
    source: c.trust === 'published' ? 'website' : 'reply_corpus',
    source_url: c.source_url,
    trust: c.trust,
    tags: [],
    priority: TRUST_PRIORITY[c.trust] ?? 3,
  };
}

async function fetchAll(sb, table, columns, filter) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function run({ dryRun = false, retireLegacy = false, log = console.log } = {}) {
  const sb = getSupabaseClient();

  const candidates = await fetchAll(sb, 'kb_candidates', 'id, source_id, source_url, title, category, content, trust, status',
    q => q.in('status', ['candidate', 'promoted']));
  const existing = await fetchAll(sb, 'cs_knowledge_base', 'id, content, trust, embedding');
  const existingById = new Map(existing.map(r => [r.id, r]));

  const stats = { upserted: 0, unchanged: 0, embedded: 0, promoted: 0, legacy: 0, retired: 0 };
  const now = new Date().toISOString();

  for (const c of candidates) {
    const article = candidateToArticle(c);
    const prev = existingById.get(article.id);
    const contentChanged = !prev || prev.content !== article.content;
    const needsEmbedding = contentChanged || !prev?.embedding;
    if (!contentChanged && !needsEmbedding) { stats.unchanged++; continue; }

    if (dryRun) { stats.upserted++; if (needsEmbedding) stats.embedded++; continue; }

    let embedding = null;
    if (needsEmbedding) {
      try {
        embedding = await embed(`${article.title}\n\n${article.content.slice(0, 2000)}`);
        stats.embedded++;
        await new Promise(r => setTimeout(r, 120)); // Voyage rate-limit politeness
      } catch (e) {
        // Fail-soft + loud: an article without an embedding still serves
        // category/id lookups; semantic search just won't rank it until the
        // next refresh re-embeds. Never block the rebuild on one embed call.
        console.error(`  [WARN] embedding failed for ${article.id}: ${e.message} — row upserted without embedding`);
      }
    }

    const { error } = await sb.from('cs_knowledge_base').upsert([{
      ...article,
      ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
      updated_at: now,
    }], { onConflict: 'id' });
    if (error) throw new Error(`cs_knowledge_base upsert failed for ${article.id}: ${error.message}`);
    stats.upserted++;
  }

  // Promote loaded candidates (single-writer batch; idempotent).
  if (!dryRun) {
    const toPromote = candidates.filter(c => c.status === 'candidate').map(c => c.id);
    for (let i = 0; i < toPromote.length; i += 200) {
      const chunk = toPromote.slice(i, i + 200);
      const { error } = await sb.from('kb_candidates').update({ status: 'promoted', updated_at: now }).in('id', chunk);
      if (error) throw new Error(`kb_candidates promote failed: ${error.message}`);
      stats.promoted += chunk.length;
    }
  }

  const candidateIds = new Set(candidates.map(c => c.id));
  const legacy = existing.filter(r => !candidateIds.has(r.id));
  stats.legacy = legacy.length;

  if (retireLegacy && legacy.length) {
    if (dryRun) {
      log(`[dry-run] would retire ${legacy.length} legacy articles`);
    } else {
      const full = await fetchAll(sb, 'cs_knowledge_base', '*', q => q.in('id', legacy.map(r => r.id).slice(0, 1000)));
      const backupPath = path.resolve(__dirname, '../..', `temp-analysis-data/kb-legacy-backup-${now.slice(0, 10)}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(full, null, 1));
      log(`backed up ${full.length} legacy articles to ${backupPath}`);
      for (let i = 0; i < legacy.length; i += 200) {
        const chunk = legacy.slice(i, i + 200).map(r => r.id);
        const { error } = await sb.from('cs_knowledge_base').delete().in('id', chunk);
        if (error) throw new Error(`legacy delete failed: ${error.message}`);
        stats.retired += chunk.length;
      }
    }
  }

  log(`cs_knowledge_base rebuild: ${stats.upserted} upserted (${stats.embedded} embedded), ${stats.unchanged} unchanged, ${stats.promoted} candidates promoted, ${stats.legacy} legacy rows${retireLegacy ? `, ${stats.retired} retired` : ' (left in place; --retire-legacy to remove)'}`);
  return { sources: { kb_rebuild: { success: true, ...stats } }, status: 'ok' };
}

if (require.main === module) {
  run({
    dryRun: process.argv.includes('--dry-run'),
    retireLegacy: process.argv.includes('--retire-legacy'),
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, candidateToArticle };
