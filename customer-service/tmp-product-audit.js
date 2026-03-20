#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { shopifyGraphQL } = require('./lib/shopify');

async function run() {
  let allProducts = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphQL(`
      query fetchProducts($after: String) {
        products(first: 50, after: $after) {
          edges {
            node {
              id
              title
              handle
              productType
              tags
              status
              metafields(first: 30) {
                edges {
                  node {
                    namespace
                    key
                    value
                    type
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    title
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after: cursor });

    allProducts.push(...data.products.edges.map(e => e.node));
    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  // Filter active only
  const active = allProducts.filter(p => p.status === 'ACTIVE');
  console.log(`Total active products: ${active.length}\n`);

  for (const p of active) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${p.title}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  productType: ${p.productType}`);
    console.log(`  tags: ${p.tags.join(', ')}`);

    // Metafields
    const mf = p.metafields.edges.map(m => m.node);
    const interesting = mf.filter(m =>
      m.key.toLowerCase().includes('collection') ||
      m.key.toLowerCase().includes('category') ||
      m.key.toLowerCase().includes('age') ||
      m.key.toLowerCase().includes('size') ||
      m.key.toLowerCase().includes('color') ||
      m.key.toLowerCase().includes('measure') ||
      m.key.toLowerCase().includes('guide') ||
      m.key.toLowerCase().includes('work') ||
      m.key.toLowerCase().includes('bundle')
    );

    if (interesting.length) {
      console.log('  --- Metafields ---');
      for (const m of interesting) {
        const val = m.value.length > 200 ? m.value.slice(0, 200) + '...' : m.value;
        console.log(`  ${m.key}: ${val}`);
      }
    }

    // All metafield keys (for discovery)
    if (mf.length) {
      const allKeys = mf.map(m => `${m.namespace}.${m.key}`);
      console.log(`  all metafield keys: ${allKeys.join(', ')}`);
    }

    // Size options
    const sizeOptions = new Map();
    for (const v of p.variants.edges) {
      for (const o of v.node.selectedOptions) {
        if (o.name === 'Size' || o.name === 'Youth Size') {
          if (!sizeOptions.has(o.name)) sizeOptions.set(o.name, new Set());
          sizeOptions.get(o.name).add(o.value);
        }
      }
    }
    for (const [name, values] of sizeOptions) {
      console.log(`  ${name}: ${[...values].join(', ')}`);
    }

    // Color options
    const colors = new Set();
    for (const v of p.variants.edges) {
      for (const o of v.node.selectedOptions) {
        if (o.name === 'Color') colors.add(o.value);
      }
    }
    if (colors.size) console.log(`  Colors: ${[...colors].join(', ')}`);
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
