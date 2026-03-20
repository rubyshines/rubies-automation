/**
 * RUBIES Inventory — Daily Variant-Level Snapshot
 *
 * Snapshots inventory_quantity for every active variant (~500) into Supabase.
 * Reuses fetchAllProducts() from customer-service/lib/shopify.js.
 * Sends a SendGrid notification on failure only.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { fetchAllProducts } = require('../customer-service/lib/shopify');
const { upsert } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchAllActiveProducts() {
  const allProducts = [];
  let cursor = null;

  while (true) {
    const { products, pageInfo } = await fetchAllProducts(cursor);
    for (const p of products) {
      if (p.status === 'ACTIVE') {
        allProducts.push(p);
      }
    }
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return allProducts;
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Inventory Pipeline — starting');

  const date = todayDate();
  console.log(`  Date: ${date}`);

  const products = await fetchAllActiveProducts();
  console.log(`  Active products: ${products.length}`);

  const rows = [];
  for (const product of products) {
    for (const variant of product.variants) {
      rows.push({
        date,
        variant_id: variant.id,
        sku: variant.sku || '',
        product_handle: product.handle || '',
        inventory_quantity: variant.inventoryQuantity ?? 0,
        price: parseFloat(variant.price) || 0,
      });
    }
  }

  console.log(`  Total variants: ${rows.length}`);

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
