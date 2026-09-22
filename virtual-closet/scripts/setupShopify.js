#!/usr/bin/env node
'use strict';
/**
 * One-time store setup for the Virtual Closet (idempotent):
 *   1. A hidden product "Sponsor a closet" with one variant per sponsor tile
 *      and a $1 unit variant for "add to the box". No shipping, no tax, no inventory,
 *      not in any collection, so it never shows in the store's own pages.
 *   2. The "Virtual Closet 20%" discount (20% off, once per customer).
 * Ids are stored in vc_config so the service reads them at runtime.
 *
 *   node virtual-closet/scripts/setupShopify.js            # preview
 *   node virtual-closet/scripts/setupShopify.js --create   # create what is missing
 *   node virtual-closet/scripts/setupShopify.js --tiles    # preview the tile variants against SPONSOR_TILES, and each market's price for them
 *   node virtual-closet/scripts/setupShopify.js --tiles --create   # replace stale tile variants with the current tiles, and fix each market's prices to the round number (£25 is £25)
 *   node virtual-closet/scripts/setupShopify.js --discount          # show the live discount's class and combination rules
 *   node virtual-closet/scripts/setupShopify.js --discount --create # align it: product discount on the eligible collection, combines with all
 */
require('dotenv').config();
const shopify = require('../../customer-service/lib/shopify');
const config = require('../lib/config');
const { SPONSOR_TILES } = require('../lib/catalog');
const { PRODUCT_TITLE } = require('../lib/sponsorship');
const discounts = require('../lib/discounts');
const money = require('../lib/money');

// The tiles are round numbers in every currency a centre can be in (Jamie,
// 2026-09-22): a UK sponsor pays £25, not the store's converted £21. Shopify
// Markets does that through a fixed price on each market's price list. The
// country is where contextual pricing is read to check what the market shows.
const MARKET_PROBE_COUNTRY = { CAD: 'CA', GBP: 'GB', EUR: 'DE', AUD: 'AU' };

const VARIANTS = [
  ...SPONSOR_TILES.map(t => ({ key: t.key, label: t.sub ? `${t.label}: ${t.sub}` : t.label, cents: t.cents })),
  { key: 'unit', label: '$1 toward the box', cents: 100 },
];

/**
 * Bring the product's variants in line with SPONSOR_TILES: one variant per
 * tile titled exactly as the tile ("$25"), plus the $1 unit. Variants whose
 * title no longer matches a tile are deleted; missing ones are created.
 */
async function syncTiles(create) {
  const existing = await config.get('sponsorship');
  if (!existing?.productId) { console.log('Sponsorship product not configured; run --create first.'); return; }
  const want = SPONSOR_TILES.map(t => ({ key: t.key, label: t.label, cents: t.cents }));
  const keep = {}, stale = [], missing = [];
  for (const [key, v] of Object.entries(existing.variants || {})) {
    if (key === 'unit') { keep.unit = v; continue; }
    const tile = want.find(t => t.key === key && t.label === v.label && t.cents === v.cents);
    if (tile) keep[key] = v; else stale.push({ key, ...v });
  }
  for (const t of want) if (!keep[t.key]) missing.push(t);
  console.log('Keep:', Object.keys(keep).join(', ') || 'none');
  console.log('Delete:', stale.map(v => `${v.key} (${v.label})`).join(', ') || 'none');
  console.log('Create:', missing.map(t => t.label).join(', ') || 'none');
  if (!create) { await syncMarketPrices(false, keep); console.log('\nRun with --tiles --create to apply.'); return; }

  if (missing.length) {
    const created = await shopify.createProductVariants(existing.productId, missing.map(t => ({
      optionValues: [{ optionName: 'Amount', name: t.label }],
      price: (t.cents / 100).toFixed(2),
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: false, requiresShipping: false },
      taxable: false,
    })));
    for (const t of missing) {
      const v = created.find(x => x.title === t.label);
      if (!v) throw new Error(`variant ${t.label} was not created`);
      keep[t.key] = { id: v.id, cents: t.cents, label: t.label };
    }
    console.log('Created:', missing.map(t => t.label).join(', '));
  }
  if (stale.length) {
    const { shopifyGraphQL } = shopify;
    const data = await shopifyGraphQL(`
      mutation($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) { userErrors { field message } }
      }`, { productId: existing.productId, variantsIds: stale.map(v => v.id) });
    const errs = data.productVariantsBulkDelete.userErrors || [];
    if (errs.length) throw new Error(`delete failed: ${errs.map(e => e.message).join('; ')}`);
    console.log('Deleted:', stale.map(v => v.label).join(', '));
  }
  await config.set('sponsorship', { ...existing, variants: keep });
  console.log('Stored variants:', Object.keys(keep).join(', '));
  await syncMarketPrices(create, keep);
}

/** The market price lists whose currency a centre can be in: [{ id, currency, market, country }]. */
async function marketPriceLists() {
  const data = await shopify.shopifyGraphQL(`{ catalogs(first: 50, type: MARKET) { nodes {
    id title status priceList { id currency }
    ... on MarketCatalog { markets(first: 5) { nodes { name handle } } } } } }`);
  return (data.catalogs?.nodes || [])
    .filter(c => c.status === 'ACTIVE' && c.priceList && MARKET_PROBE_COUNTRY[c.priceList.currency])
    .map(c => ({ id: c.priceList.id, currency: c.priceList.currency, market: c.markets?.nodes?.[0]?.name || c.title, country: MARKET_PROBE_COUNTRY[c.priceList.currency] }));
}

/**
 * Every tile (and the $1 unit) priced at the same round number in each
 * market's currency: 10 is 10.00, whatever the currency. Prints what each
 * market shows now against what it should; with `create`, adds the fixed
 * prices and reads them back.
 */
async function syncMarketPrices(create, variants) {
  const lists = await marketPriceLists();
  if (!lists.length) { console.log('No market price lists found; nothing to fix.'); return; }
  const ids = Object.values(variants).map(v => v.id);
  for (const list of lists) {
    const shown = await contextualPrices(ids, list.country);
    const want = Object.values(variants).map(v => ({ variantId: v.id, label: v.label, price: { amount: (v.cents / 100).toFixed(2), currencyCode: list.currency } }));
    const off = want.filter(w => shown[w.variantId]?.amount !== w.price.amount || shown[w.variantId]?.currencyCode !== list.currency);
    console.log(`${list.market} (${list.currency}): ${off.length ? off.map(w => `${w.label} shows ${shown[w.variantId]?.amount ?? '?'}, should be ${w.price.amount}`).join('; ') : 'every tile is the round number'}`);
    if (!create || !off.length) continue;
    const data = await shopify.shopifyGraphQL(`
      mutation($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) { prices { variant { id } price { amount currencyCode } } userErrors { field message } }
      }`, { priceListId: list.id, prices: off.map(w => ({ variantId: w.variantId, price: w.price })) });
    const errs = data.priceListFixedPricesAdd?.userErrors || [];
    if (errs.length) throw new Error(`${list.market}: fixed prices failed: ${errs.map(e => e.message).join('; ')}`);
    const after = await contextualPrices(ids, list.country);
    const still = want.filter(w => after[w.variantId]?.amount !== w.price.amount);
    console.log(`  fixed ${off.length} price${off.length === 1 ? '' : 's'}; now ${still.length ? `STILL OFF: ${still.map(w => `${w.label} ${after[w.variantId]?.amount}`).join(', ')}` : 'every tile is the round number'}`);
  }
}

/** { variantId: { amount, currencyCode } } as the store shows them to that country. */
async function contextualPrices(ids, country) {
  const data = await shopify.shopifyGraphQL(`query($ids: [ID!]!, $country: CountryCode!) { nodes(ids: $ids) { ... on ProductVariant { id contextualPricing(context: { country: $country }) { price { amount currencyCode } } } } }`, { ids, country });
  const out = {};
  for (const n of data.nodes || []) if (n?.id) out[n.id] = n.contextualPricing?.price ? { amount: Number(n.contextualPricing.price.amount).toFixed(2), currencyCode: n.contextualPricing.price.currencyCode } : null;
  return out;
}

async function showDiscount(label) {
  const d = await config.get('discount');
  if (!d?.id) { console.log(label, 'discount not configured'); return; }
  const data = await shopify.shopifyGraphQL(`query($id: ID!) { codeDiscountNode(id: $id) { codeDiscount { ... on DiscountCodeBasic {
    title discountClass appliesOncePerCustomer combinesWith { orderDiscounts productDiscounts shippingDiscounts }
    customerGets { items { __typename ... on AllDiscountItems { allItems } ... on DiscountCollections { collections(first: 3) { nodes { handle productsCount { count } } } } } } } } } }`, { id: d.id });
  const x = data.codeDiscountNode?.codeDiscount || {};
  console.log(label, JSON.stringify({ title: x.title, class: x.discountClass, once: x.appliesOncePerCustomer, combines: x.combinesWith, items: x.customerGets?.items }));
}

async function main() {
  const create = process.argv.includes('--create');
  if (process.argv.includes('--tiles')) return syncTiles(create);
  if (process.argv.includes('--discount')) {
    await showDiscount('Now:');
    if (!create) { console.log('\nRun with --discount --create to align it (product discount on the "' + discounts.COLLECTION_HANDLE + '" collection, combines with order, product and shipping discounts).'); return; }
    const r = await discounts.alignDiscount();
    console.log('Collection:', r.collectionId);
    await showDiscount('After:');
    return;
  }
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
      taxable: false,
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
