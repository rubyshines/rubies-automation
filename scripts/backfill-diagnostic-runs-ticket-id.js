#!/usr/bin/env node
/**
 * Backfill cs_diagnostic_runs.ticket_id and draft_id by fuzzy-joining on
 * customer_email and created_at to cs_ai_drafts.
 *
 * Two run types need different strategies:
 *  - 'advisor' rows fire moments after the advisor produces a draft, so the
 *    nearest draft within ~60s is the right match (always sets draft_id +
 *    ticket_id).
 *  - 'operator' rows fire when the operator runs action-chat against an
 *    existing draft, which can be hours after the draft was created. Match
 *    to the most-recent draft for that customer at or before the diagnostic
 *    timestamp (always sets ticket_id; sets draft_id when a draft is found).
 *
 * Skips rows that already have ticket_id set. Reports unmatched rows for
 * manual review. Prerequisite: run diagnostic-runs-schema.sql first to add
 * the ticket_id / draft_id columns.
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

const ADVISOR_WINDOW_MS = 60 * 1000;
const OPERATOR_LOOKBACK_DAYS = 30;

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
      .select('id, source, customer_email, created_at, ticket_id')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (row.ticket_id) { alreadySet++; continue; }
      if (!row.customer_email) { unmatched++; continue; }

      const t = new Date(row.created_at).getTime();
      let best = null;

      if (row.source === 'advisor') {
        // Advisor: try tight window first (intake path — shadow fires seconds
        // after a fresh draft is created).
        const lower = new Date(t - ADVISOR_WINDOW_MS).toISOString();
        const upper = new Date(t + ADVISOR_WINDOW_MS).toISOString();
        const { data: candidates } = await sb
          .from('cs_ai_drafts')
          .select('id, gorgias_ticket_id, created_at')
          .eq('customer_email', row.customer_email)
          .gte('created_at', lower)
          .lte('created_at', upper);
        if (candidates && candidates.length > 0) {
          best = candidates.reduce((a, b) =>
            Math.abs(new Date(b.created_at).getTime() - t) < Math.abs(new Date(a.created_at).getTime() - t) ? b : a
          );
        }
      }

      if (!best) {
        // Fall back to wide lookback: dashboard refresh path can fire a shadow
        // run hours after the draft was created. Operator rows always use this
        // path. Match to most-recent draft for this customer at or before the
        // diagnostic timestamp.
        const lookbackLower = new Date(t - OPERATOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const upper = new Date(t).toISOString();
        const { data: candidates } = await sb
          .from('cs_ai_drafts')
          .select('id, gorgias_ticket_id, created_at')
          .eq('customer_email', row.customer_email)
          .gte('created_at', lookbackLower)
          .lte('created_at', upper)
          .order('created_at', { ascending: false })
          .limit(1);
        if (candidates && candidates.length > 0) best = candidates[0];
      }

      if (!best) { unmatched++; continue; }

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
