/**
 * Seed the managed_discounts registry from the volume discounts ALREADY live in
 * Shopify — adopt-in-place, so we never delete/recreate the working discounts.
 *
 * Groups per-tier nodes ("10% AJ Volume Discount", "15% AJ Volume Discount") under
 * one base name ("AJ Volume Discount"), derives the SKU prefix from the targeted
 * products, and upserts one registry row per group.
 *
 *   node scripts/seedManagedDiscounts.js          # dry run (prints what it would seed)
 *   node scripts/seedManagedDiscounts.js --write   # write rows to Supabase
 */
require('dotenv').config();
const { shopifyGraphQL } = require('../customer-service/lib/shopify');
const { getSupabaseClient } = require('../shared/supabaseClient');

const WRITE = process.argv.includes('--write');

function longestCommonPrefix(strings) {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (s.indexOf(prefix) !== 0) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

(async () => {
  const data = await shopifyGraphQL(`
    query {
      automaticDiscountNodes(first: 100) {
        nodes {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title status startsAt endsAt
              minimumRequirement { ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
              customerGets {
                value { ... on DiscountPercentage { percentage } }
                items {
                  __typename
                  ... on DiscountProducts {
                    products(first: 50) { nodes { id variants(first: 50) { nodes { sku } } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const groups = {};
  for (const n of data.automaticDiscountNodes.nodes) {
    const d = n.automaticDiscount;
    if (d.__typename !== 'DiscountAutomaticBasic') continue;
    if (d.status !== 'ACTIVE') continue;
    if (d.customerGets?.items?.__typename !== 'DiscountProducts') continue; // volume = product-level only
    const pct = Math.round((d.customerGets.value.percentage || 0) * 100);
    const qty = parseInt(d.minimumRequirement?.greaterThanOrEqualToQuantity || '0', 10);
    const baseName = (d.title || '').replace(/^\d+%\s*/, '').trim();
    if (!baseName) continue;

    const skus = [];
    for (const p of d.customerGets.items.products.nodes) {
      for (const v of p.variants.nodes) if (v.sku) skus.push(v.sku);
    }
    const g = groups[baseName] || (groups[baseName] = { tiers: [], nodeIds: [], skus: new Set(), startsAt: d.startsAt, endsAt: d.endsAt });
    g.tiers.push({ threshold: qty, percentage: pct });
    g.nodeIds.push(n.id.replace('gid://shopify/DiscountAutomaticNode/', ''));
    skus.forEach((s) => g.skus.add(s));
  }

  const rows = Object.entries(groups).map(([name, g]) => {
    const tiers = g.tiers.sort((a, b) => a.threshold - b.threshold);
    const prefix = longestCommonPrefix([...g.skus]).replace(/[-_].*$/, '').replace(/\d+$/, '') || longestCommonPrefix([...g.skus]);
    return {
      kind: 'volume', name, sku_prefixes: [prefix], collection_handle: null,
      tiers, shopify_node_ids: g.nodeIds, status: 'active',
      starts_at: g.startsAt || null, ends_at: g.endsAt || null,
    };
  });

  console.log(`\nFound ${rows.length} volume discount group(s) to adopt:\n`);
  for (const r of rows) {
    console.log(`  ${r.name}`);
    console.log(`    tiers:   ${r.tiers.map((t) => `${t.threshold}+@${t.percentage}%`).join(', ')}`);
    console.log(`    skuPfx:  ${r.sku_prefixes.join(', ')}  (derived — verify!)`);
    console.log(`    nodes:   ${r.shopify_node_ids.join(', ')}`);
  }

  if (!WRITE) {
    console.log('\n(dry run — re-run with --write to seed the registry)');
    return;
  }
  const { error } = await getSupabaseClient().from('managed_discounts').upsert(rows, { onConflict: 'name' });
  if (error) throw error;
  console.log(`\n✓ Seeded ${rows.length} row(s) into managed_discounts.`);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
