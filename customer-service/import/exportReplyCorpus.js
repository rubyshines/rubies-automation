#!/usr/bin/env node

/**
 * Export the sent-reply corpus for the step-3 KB mine (project_corpus_harvest).
 *
 * Pulls all external agent messages from cs_messages (Gorgias/Tidio history,
 * 2020 → today), drops short/noise bodies, collapses exact+normalized
 * duplicates keeping the MOST RECENT exemplar (recency rule: newer statements
 * supersede older ones), and writes newest-first numbered batch files for the
 * zero-API mining subagents described in kb-mining-protocol.md.
 *
 * Deterministic given the same data: batches are ordered by created_at desc,
 * so "mined through batch N" is meaningful resume state while the corpus tail
 * (older messages) stays stable.
 *
 * Usage:
 *   node customer-service/import/exportReplyCorpus.js <outDir> [--batch-chars=250000] [--min-chars=200]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const fs = require('fs');
const crypto = require('crypto');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const argNum = (name, dflt) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : dflt;
};

// Collapse cosmetic variance so templated sends dedupe to one exemplar.
function normalizeBody(text) {
  return text.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' U ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' E ')
    .replace(/#?\d[\d,.-]*/g, ' N ')
    .replace(/^(hi|hey|hello|dear) [a-z]+[,!]?$/gm, 'GREET')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const OUT_DIR = process.argv[2];
  if (!OUT_DIR) { console.error('usage: node customer-service/import/exportReplyCorpus.js <outDir> [--batch-chars=N] [--min-chars=N]'); process.exit(1); }
  const BATCH_CHARS = argNum('batch-chars', 250000);
  const MIN_CHARS = argNum('min-chars', 200);

  const sb = getSupabaseClient();
  const PAGE = 1000;

  const convMeta = new Map();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('cs_conversations')
      .select('id, subject, category')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cs_conversations read failed: ${error.message}`);
    for (const c of data) convMeta.set(c.id, c);
    if (data.length < PAGE) break;
  }

  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('cs_messages')
      .select('id, conversation_id, body_text, created_at, is_internal')
      .eq('sender_type', 'agent')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cs_messages read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const substantial = rows.filter(r => !r.is_internal && (r.body_text || '').trim().length >= MIN_CHARS);

  // Dedupe on normalized body; most recent exemplar wins, occurrence span kept
  // so the miner can weigh how often (and until when) a statement was made.
  const byHash = new Map();
  for (const r of substantial.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    const h = crypto.createHash('sha256').update(normalizeBody(r.body_text)).digest('hex');
    const prev = byHash.get(h);
    if (prev) {
      prev.times_sent++;
      prev.last_sent = r.created_at;
      prev.exemplar = r; // later message replaces earlier — recency rule
    } else {
      byHash.set(h, { times_sent: 1, first_sent: r.created_at, last_sent: r.created_at, exemplar: r });
    }
  }

  const entries = [...byHash.values()]
    .map(e => {
      const conv = convMeta.get(e.exemplar.conversation_id) || {};
      return {
        message_id: e.exemplar.id,
        date: e.exemplar.created_at,
        times_sent: e.times_sent,
        first_sent: e.first_sent,
        subject: conv.subject || null,
        category: conv.category || null,
        body: e.exemplar.body_text.trim(),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let batch = [], batchChars = 0, batchNum = 0;
  const flush = () => {
    if (!batch.length) return;
    batchNum++;
    const name = `batch-${String(batchNum).padStart(3, '0')}.json`;
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(batch, null, 1));
    console.log(`${name}: ${batch.length} messages, ${batchChars} chars, ${batch[batch.length - 1].date.slice(0, 10)} .. ${batch[0].date.slice(0, 10)}`);
    batch = []; batchChars = 0;
  };
  for (const e of entries) {
    batch.push(e);
    batchChars += e.body.length;
    if (batchChars >= BATCH_CHARS) flush();
  }
  flush();

  console.log(`\n${entries.length} unique replies (${substantial.length} substantial, ${rows.length} total agent msgs) → ${batchNum} batches in ${OUT_DIR}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { normalizeBody };
