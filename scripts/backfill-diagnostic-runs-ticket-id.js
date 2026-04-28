#!/usr/bin/env node
/**
 * Backfill cs_diagnostic_runs.ticket_id and draft_id by fuzzy-joining on
 * customer_email + created_at proximity to cs_ai_drafts.
 *
 * Diagnostic runs fire moments after the advisor produces a draft, so the
 * matching draft is the one with the closest created_at within a small window
 * (default 60 seconds) for the same customer_email.
 *
 * Skips rows that already have ticket_id set. Reports unmatched rows for
 * manual review. Prerequisite: run diagnostic-runs-schema.sql first to add
 * the ticket_id / draft_id columns.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

const WINDOW_MS = 60 * 1000;

(async () => {
  const sb = getSupabaseClient();

  // Verify columns exist
  const probe = await sb.from('cs_diagnostic_runs').select('id, ticket_id, draft_id').limit(1);
  if (probe.error) {
    console.error('Schema not ready:', probe.error.message);
    console.error('Run customer-service/drafter/diagnostic-runs-schema.sql in Supabase SQL Editor first.');
    process.exit(1);
  }

  const PAGE = 200;
  let from = 0, total = 0, matched = 0, unmatched = 0, alreadySet = 0;

  for (;;) {
    const { data: rows, error } = await sb
      .from('cs_diagnostic_runs')
      .select('id, customer_email, created_at, ticket_id')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (row.ticket_id) { alreadySet++; continue; }
      if (!row.customer_email) { unmatched++; continue; }

      const t = new Date(row.created_at).getTime();
      const lower = new Date(t - WINDOW_MS).toISOString();
      const upper = new Date(t + WINDOW_MS).toISOString();

      const { data: candidates } = await sb
        .from('cs_ai_drafts')
        .select('id, gorgias_ticket_id, created_at')
        .eq('customer_email', row.customer_email)
        .gte('created_at', lower)
        .lte('created_at', upper)
        .order('created_at', { ascending: true });

      if (!candidates || candidates.length === 0) {
        unmatched++;
        continue;
      }

      // Closest by absolute time delta
      const best = candidates.reduce((a, b) =>
        Math.abs(new Date(b.created_at).getTime() - t) < Math.abs(new Date(a.created_at).getTime() - t) ? b : a
      );

      const { error: upErr } = await sb
        .from('cs_diagnostic_runs')
        .update({ ticket_id: best.gorgias_ticket_id, draft_id: best.id })
        .eq('id', row.id);
      if (upErr) {
        console.error('row', row.id, 'update failed:', upErr.message);
        unmatched++;
        continue;
      }
      matched++;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log('Total rows scanned:', total);
  console.log('Already had ticket_id:', alreadySet);
  console.log('Newly matched:', matched);
  console.log('Unmatched:', unmatched);
})().catch(e => { console.error(e); process.exit(1); });
