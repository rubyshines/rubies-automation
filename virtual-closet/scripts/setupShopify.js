#!/usr/bin/env node
'use strict';
/**
 * One-time store setup for the Virtual Closet (idempotent):
 *   1. A hidden product "Sponsor a closet" with one variant per sponsor tile
 *      and a $1 unit variant for "add to the box". No shipping, no inventory,
 *      not in any collection, so it never shows in the store's own pages.
 *   2. The "Virtual Closet 20%" discount (20% off, once per customer).
 * Ids are stored in vc_config so the service reads them at runtime.
 *
 *   node virtual-closet/scripts/setupShopify.js            # preview
 *   node virtual-closet/scripts/setupShopify.js --create   # create what is missing
 */
require('dotenv').config();
const shopify = require('../../customer-service/lib/shopify');
const config = require('../lib/config');
const { SPONSOR_TILES } = require('../lib/catalog');
const { PRODUCT_TITLE } = require('../lib/sponsorship');
const discounts = require('../lib/discounts');

const VARIANTS = [
  ...SPONSOR_TILES.map(t => ({ key: t.key, label: `${t.label}: ${t.sub}`, cents: t.cents })),
  { key: 'unit', label: '$1 toward the box', cents: 100 },
];

async function main() {
  const create = process.argv.includes('--create');
  const existing = await config.get('sponsorship');
  console.log('Sponsorship product:', existing ? `configured (${existing.productId})` : 'not configured');
  const discount = await config.get('discount');
  console.log('Discount:', discount ? `configured (${discount.title}, ${discount.numericId})` : 'not configured');
  if (!create) { console.log('\nRun with --create to create what is missing.'); return; }

  if (!existing) {
    const product = await shopify.createShopifyProduct({
      title: PRODUCT_TITLE,
      productType: 'Virtual Closet',
      vendor: 'RUBIES',
      status: 'ACTIVE',
      tags: ['virtual-closet', 'hidden'],
      descriptionHtml: '<p>A sponsorship of an LGBTQ+ centre\'s Virtual Closet. RUBIES matches every dollar. Nothing ships to you; the closet receives the product.</p>',
      productOptions: [{ name: 'Amount', values: VARIANTS.map(v => ({ name: v.label })) }],
    });
    console.log('Created product', product.id, product.handle);
    const variants = await shopify.createProductVariants(product.id, VARIANTS.map(v => ({
      optionValues: [{ optionName: 'Amount', name: v.label }],
      price: (v.cents / 100).toFixed(2),
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: false, requiresShipping: false },
      taxable: true,
    })));
    const map = {};
    for (const v of VARIANTS) {
      const created = variants.find(x => x.title === v.label);
      if (!created) throw new Error(`variant ${v.label} was not created`);
      map[v.key] = { id: created.id, cents: v.cents, label: v.label };
    }
    await config.set('sponsorship', { productId: product.id, handle: product.handle, variants: map });
    console.log('Stored variants:', Object.keys(map).join(', '));
    console.log('NOTE: keep this product out of the storefront: check it is in no collection and not in the sitemap (Shopify Admin → product → sales channels / search visibility).');
  }
  if (!discount) {
    const d = await discounts.ensureDiscount();
    console.log('Discount ready:', d.title, d.numericId);
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
