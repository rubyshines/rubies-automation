#!/usr/bin/env node
/**
 * reparseTransferLines.js — repair Transfer rows written before the parser fix.
 *
 * A QBO Transfer carries neither TotalAmt nor Line: the amount is `Amount` and
 * the two sides are To/FromAccountRef. The sync read only TotalAmt/Line, so
 * every Transfer landed with total_amount = null and line_items = null and was
 * invisible to any query that walks line items.
 *
 * The parser is fixed, but the incremental sync keys off LastUpdatedTime, so
 * historical rows never re-sync on their own. This rewrites them in place from
 * the `raw_json` already stored — no QBO API calls, nothing refetched.
 *
 * Idempotent: recomputes from raw_json and writes only rows that actually
 * differ, so re-running is a no-op. Safe to re-run after any future backfill.
 *
 *   node finance/sync/reparseTransferLines.js            # dry run (default)
 *   node finance/sync/reparseTransferLines.js --live     # apply
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { normalizeLines, extractTotalAmount, extractAccountId } = require('./syncFinance');

const PAGE = 1000;

/**
 * Postgres `jsonb` does not preserve key order — it stores keys sorted by length
 * then bytewise. So a round-tripped line reads back with its keys rearranged and
 * a plain JSON.stringify comparison reports a difference that does not exist,
 * which would make this script rewrite every row on every run and report clean
 * rows as needing repair. Compare on a canonical key ordering instead.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function fetchAllTransfers(supabase) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('qbo_transactions')
      .select('id, txn_type, txn_date, total_amount, line_items, account_id, raw_json')
      .eq('txn_type', 'Transfer')
      .order('txn_date')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch failed: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function run({ live = false } = {}) {
  const supabase = getSupabaseClient();
  const rows = await fetchAllTransfers(supabase);
  console.log(`Transfer rows found: ${rows.length}`);

  const repairs = [];
  const skipped = [];

  for (const row of rows) {
    const raw = row.raw_json;
    if (!raw) { skipped.push({ id: row.id, why: 'no raw_json' }); continue; }

    // raw_json stores the QBO payload; _txnType is set by the sync, but pass the
    // type explicitly so a row written by backfillHistory (which never set it)
    // repairs identically.
    const lines = normalizeLines(raw, 'Transfer');
    const amount = extractTotalAmount(raw);
    const accountId = extractAccountId({ ...raw, _txnType: 'Transfer' });

    if (lines == null || amount == null) {
      skipped.push({ id: row.id, why: 'incomplete raw_json (missing Amount or an account ref)' });
      continue;
    }

    const changed =
      row.total_amount == null ||
      row.line_items == null ||
      Number(row.total_amount) !== Number(amount) ||
      stableStringify(row.line_items) !== stableStringify(lines) ||
      row.account_id !== accountId;

    if (!changed) continue;

    repairs.push({
      id: row.id,
      txn_date: row.txn_date,
      amount,
      accounts: lines.map(l => `${l.JournalEntryLineDetail.PostingType} ${l.JournalEntryLineDetail.AccountRef.name}`),
      patch: { total_amount: amount, line_items: lines, account_id: accountId },
    });
  }

  console.log(`rows needing repair : ${repairs.length}`);
  console.log(`rows already correct: ${rows.length - repairs.length - skipped.length}`);
  if (skipped.length) {
    console.log(`rows skipped        : ${skipped.length}`);
    for (const s of skipped.slice(0, 10)) console.log(`   ${s.id}: ${s.why}`);
  }

  if (repairs.length) {
    console.log('\nsample of what will be written:');
    for (const r of repairs.slice(0, 8)) {
      console.log(`   ${r.txn_date}  ${String(r.amount).padStart(11)}   ${r.accounts.join('  |  ')}`);
    }
  }

  if (!live) {
    console.log('\nDRY RUN — nothing written. Re-run with --live to apply.');
    return { repaired: 0, candidates: repairs.length, skipped: skipped.length };
  }

  let repaired = 0;
  for (const r of repairs) {
    // Update by (id, txn_type): `id` alone is not unique across types in QBO.
    const { error } = await supabase
      .from('qbo_transactions')
      .update(r.patch)
      .eq('id', r.id)
      .eq('txn_type', 'Transfer');
    if (error) throw new Error(`update ${r.id} failed: ${error.message}`);
    repaired++;
    if (repaired % 50 === 0) console.log(`   ...${repaired}/${repairs.length}`);
  }

  console.log(`\nRepaired ${repaired} Transfer rows.`);
  return { repaired, candidates: repairs.length, skipped: skipped.length };
}

if (require.main === module) {
  const live = process.argv.includes('--live');
  run({ live })
    .then(() => process.exit(0))
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { run, stableStringify };
