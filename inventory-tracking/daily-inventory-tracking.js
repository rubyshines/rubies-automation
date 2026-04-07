/**
 * RUBIES Inventory — Daily Variant-Level Snapshot
 *
 * Snapshots inventory_quantity for every active variant (~500) into Supabase.
 * Reads from Supabase product_variants table (kept fresh by webhooks + daily sync).
 * Sends a SendGrid notification on failure only.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Inventory Pipeline — starting');

  const date = todayDate();
  console.log(`  Date: ${date}`);

  const supabase = getSupabaseClient();

  // Read from Supabase instead of calling Shopify API
  const { data: variants, error: vErr } = await supabase
    .from('product_variants')
    .select('shopify_variant_id, sku, price, inventory_quantity, shopify_product_id');
  if (vErr) throw new Error(`Failed to fetch variants: ${vErr.message}`);

  // Get product handles for the variants
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('shopify_product_id, handle')
    .eq('status', 'ACTIVE');
  if (pErr) throw new Error(`Failed to fetch products: ${pErr.message}`);

  const handleMap = new Map((products || []).map(p => [p.shopify_product_id, p.handle]));

  // Only include variants from active products
  const activeVariants = (variants || []).filter(v => handleMap.has(v.shopify_product_id));
  console.log(`  Active variants: ${activeVariants.length}`);

  const rows = activeVariants.map(v => ({
    date,
    variant_id: v.shopify_variant_id,
    sku: v.sku || '',
    product_handle: handleMap.get(v.shopify_product_id) || '',
    inventory_quantity: v.inventory_quantity ?? 0,
    price: parseFloat(v.price) || 0,
  }));

  const totalUnits = rows.reduce((sum, r) => sum + r.inventory_quantity, 0);
  console.log(`  Total units in stock: ${totalUnits}`);

  const written = await upsert('inventory_snapshots', rows, ['date', 'variant_id']);
  console.log(`  Upserted: ${written} rows`);
  console.log('RUBIES Inventory Pipeline — done');

  return {
    sources: {
      snapshots: { success: true, rowsWritten: written, error: null },
    },
    status: 'success',
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  run().catch(async (err) => {
    console.error('RUBIES Inventory Pipeline — FAILED:', err.message);

    try {
      const sgMail = getSendgridClient();
      if (sgMail) {
        await sgMail.send({
          to: 'jamie@rubyshines.com',
          from: 'pipeline@rubyshines.com',
          subject: `❌ RUBIES Inventory Pipeline — ${todayDate()} FAILED`,
          text: `Inventory snapshot failed:\n\n${err.message}\n\n${err.stack || ''}`,
        });
      }
    } catch (notifyErr) {
      console.error('  SendGrid notification failed:', notifyErr.message);
    }

    process.exit(1);
  });
}
