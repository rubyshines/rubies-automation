/**
 * One-off backfill: loops syncCustomers() until every customer with a
 * shopify_customer_id has been enriched (default_address, totals, tags, etc.).
 *
 * Run: node --env-file=.env customer-service/sync/backfillCustomers.js
 *
 * Safe to interrupt — syncCustomers is idempotent and picks up the next batch
 * on the next run. Progress is logged every batch.
 */

const { runCustomers } = require('./syncAll');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const BATCH_SIZE = 200;
const MAX_ITERATIONS = 200; // safety cap ~40k customers max

async function remainingCount() {
  const supabase = getSupabaseClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('customers')
    .select('email', { count: 'exact', head: true })
    .not('shopify_customer_id', 'is', null)
    .or(`shopify_synced_at.is.null,shopify_synced_at.lt.${sevenDaysAgo}`);
  if (error) throw new Error(`Count query failed: ${error.message}`);
  return count;
}

async function main() {
  const startTotal = await remainingCount();
  console.log(`[Backfill] Starting — ${startTotal} customers need enrichment`);
  console.log(`[Backfill] Batch size: ${BATCH_SIZE}`);

  const startedAt = Date.now();
  let iter = 0;
  let prevCount = startTotal;
  let stallCount = 0;

  while (iter < MAX_ITERATIONS) {
    iter++;
    const before = await remainingCount();
    if (before === 0) {
      console.log(`[Backfill] Done — all customers enriched after ${iter - 1} iterations`);
      break;
    }

    console.log(`\n[Backfill] Iteration ${iter} — ${before} remaining`);
    await runCustomers({ batchSize: BATCH_SIZE });

    const after = await remainingCount();
    const processed = before - after;
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    const overallProcessed = startTotal - after;
    const pctDone = ((overallProcessed / startTotal) * 100).toFixed(1);
    console.log(`[Backfill] Iteration ${iter}: processed ${processed}, ${after} remaining (${pctDone}% done, ${elapsedMin}min elapsed)`);

    // Detect stall: if a full iteration didn't move the counter, something's wrong.
    // Two stalled iterations in a row = bail.
    if (processed === 0) {
      stallCount++;
      if (stallCount >= 2) {
        console.error(`[Backfill] Stalled — counter hasn't moved for 2 iterations. ${after} customers remain unenriched. Likely a data issue (missing profiles, deleted Shopify customers, etc.). Bailing.`);
        break;
      }
    } else {
      stallCount = 0;
    }
    prevCount = after;
  }

  const totalElapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
  const finalRemaining = await remainingCount();
  const enriched = startTotal - finalRemaining;
  console.log(`\n[Backfill] Complete. Enriched ${enriched}/${startTotal} customers in ${totalElapsed} minutes. ${finalRemaining} still unenriched.`);
}

main().catch(err => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
