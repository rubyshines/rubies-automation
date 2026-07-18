#!/usr/bin/env node

/**
 * One-time backfill: reclassify machine-generated cs_messages rows stored as
 * sender_type='agent' to 'system' (2026-07 contamination finding: rule
 * auto-acks and AI-bot sends polluted agent-voice analyses and the reply mine).
 *
 * Conservative, body-anchored rules only (the same two signals
 * classifyGorgiasSender uses body-side):
 *   - body STARTS with the auto-ack template ("Thanks for reaching out, our
 *     team will get back to you soon...")
 *   - the AI-bot marker appears in the pre-quote head of the body
 * Historical help-center/flow ambiguity is left alone — those need the raw
 * Gorgias meta (origin==='flow'), which the forward sync fix now applies.
 *
 * Usage:
 *   node customer-service/sync/backfillMessageHygiene.js            # report only
 *   node customer-service/sync/backfillMessageHygiene.js --execute  # write
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { classifyGorgiasSender } = require('../import/normalizer');

async function main() {
  const execute = process.argv.includes('--execute');
  const sb = getSupabaseClient();

  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('cs_messages')
      .select('id, body_text')
      .eq('sender_type', 'agent')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  // Body-only classification: pass a minimal message object (no meta, not a
  // note, from_agent true) so only the template rules can fire.
  const toSystem = rows.filter(r => classifyGorgiasSender({ from_agent: true }, r.body_text || '', false) === 'system');
  console.log(`agent rows scanned: ${rows.length}; machine-generated (auto-ack/bot): ${toSystem.length}`);

  if (!execute) { console.log('Report only — pass --execute to reclassify.'); return; }

  for (let i = 0; i < toSystem.length; i += 200) {
    const chunk = toSystem.slice(i, i + 200).map(r => r.id);
    const { error } = await sb.from('cs_messages').update({ sender_type: 'system' }).in('id', chunk);
    if (error) throw new Error(error.message);
  }
  console.log(`reclassified ${toSystem.length} rows to sender_type='system'`);
}

main().catch(e => { console.error(e); process.exit(1); });
