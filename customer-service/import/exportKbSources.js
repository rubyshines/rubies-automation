#!/usr/bin/env node

// Export active kb_sources rows to per-type JSON files for the zero-API
// extraction pass (corpus harvest step 2 — Claude Code subagents read these).
// See customer-service/import/kb-extraction-protocol.md for the full workflow.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
const fs = require('fs');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const OUT_DIR = process.argv[2];
if (!OUT_DIR) { console.error('usage: node customer-service/import/exportKbSources.js <outDir>'); process.exit(1); }

(async () => {
  const sb = getSupabaseClient();
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('kb_sources')
      .select('id, source_type, source_url, title, content, content_hash, meta')
      .eq('status', 'active')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const byType = {};
  for (const r of rows) (byType[r.source_type] ||= []).push(r);
  for (const [type, list] of Object.entries(byType)) {
    fs.writeFileSync(path.join(OUT_DIR, `${type}.json`), JSON.stringify(list, null, 1));
    console.log(`${type}: ${list.length} rows`);
  }
  console.log(`total: ${rows.length}`);
})().catch(e => { console.error(e); process.exit(1); });
