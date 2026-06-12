/**
 * freeOffer.js — manage a "free gift with purchase" offer end to end.
 *
 * The offer works WITHOUT the discount engine (discount combination classes
 * made BXGY free gifts conflict with non-combinable codes). Instead we keep a
 * hidden $0 "twin" of the gift product; the theme auto-adds it to qualifying
 * carts and renders it as FREE. See rubies-ecom-v4 snippets/free-gift-section.liquid.
 *
 * Lifecycle:
 *
 *   node promotions/freeOffer.js create --source <handle>     # make $0 twin of a product, add to gift collection
 *   node promotions/freeOffer.js remove --source <handle>     # take a twin out of the gift collection (product stays, draft)
 *   node promotions/freeOffer.js enable --minimum 0 --start 2026-06-15 --end 2026-06-30
 *   node promotions/freeOffer.js disable                      # twins -> draft, offer metafields cleared
 *   node promotions/freeOffer.js delete --source <handle>     # permanently delete one twin product
 *   node promotions/freeOffer.js delete --all                 # full teardown: delete all twins + collection + metafields
 *   node promotions/freeOffer.js status
 *
 * After a campaign: run `disable` when the promo ends, then `delete --all`
 * once fulfillments have settled. Deleting is permanent — Shopify keeps the
 * line-item snapshot on past orders, but product-level reporting links break
 * and next campaign needs a fresh `create` (and Warehance mapping).
 *
 * Theme contract (shop metafields, namespace "custom"):
 *   free_gift_offer_collection (collection_reference) — gift options shown in cart
 *   free_gift_offer_minimum    (number_integer, USD)  — 0 = every order
 *   free_gift_offer_start      (date)                 — inclusive, store timezone
 *   free_gift_offer_end        (date)                 — inclusive, store timezone
 *
 * NOTE: these keys are intentionally different from the legacy
 * free_gift_minimum_amount / free_gift_collection keys, which older theme
 * code (pre June 2026) reads without date gating.
 */

require('dotenv').config();
const { shopifyGraphQL } = require('../customer-service/lib/shopify');

const GIFT_COLLECTION_HANDLE = 'free-gift-offer';
const GIFT_COLLECTION_TITLE = 'Free Gift Offer';
const GIFT_TAG = 'free-gift-offer';
const METAFIELD_KEYS = [
  'free_gift_offer_collection',
  'free_gift_offer_minimum',
  'free_gift_offer_start',
  'free_gift_offer_end',
];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    }
  }
  return { command, flags };
}

async function getShopId() {
  const data = await shopifyGraphQL(`{ shop { id } }`);
  return data.shop.id;
}

async function getProductByHandle(handle) {
  const data = await shopifyGraphQL(`
    query productByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id title handle status tags
        featuredMedia { ... on MediaImage { image { url } } }
        variants(first: 5) {
          nodes { id title sku price compareAtPrice }
        }
      }
    }
  `, { handle });
  return data.productByHandle;
}

async function getOnlineStorePublicationId() {
  const data = await shopifyGraphQL(`{ publications(first: 20) { nodes { id name } } }`);
  const pub = data.publications.nodes.find((p) => p.name === 'Online Store');
  if (!pub) throw new Error('Online Store publication not found');
  return pub.id;
}

async function ensureGiftCollection(log = () => {}) {
  const existing = await shopifyGraphQL(`
    query collectionByHandle($handle: String!) {
      collectionByHandle(handle: $handle) { id title }
    }
  `, { handle: GIFT_COLLECTION_HANDLE });
  if (existing.collectionByHandle) return existing.collectionByHandle.id;

  const created = await shopifyGraphQL(`
    mutation collectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }
  `, { input: { title: GIFT_COLLECTION_TITLE, handle: GIFT_COLLECTION_HANDLE } });
  const collectionId = created.collectionCreate.collection.id;

  const publicationId = await getOnlineStorePublicationId();
  await shopifyGraphQL(`
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
  `, { id: collectionId, input: [{ publicationId }] });

  log(`✓ Created gift collection "${GIFT_COLLECTION_TITLE}" (${GIFT_COLLECTION_HANDLE})`);
  return collectionId;
}

async function getGiftCollectionProducts() {
  const data = await shopifyGraphQL(`
    query giftCollection($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        products(first: 20) {
          nodes { id title handle status variants(first: 1) { nodes { id sku price compareAtPrice } } }
        }
      }
    }
  `, { handle: GIFT_COLLECTION_HANDLE });
  return data.collectionByHandle;
}

function giftHandleFor(sourceHandle) {
  return `${sourceHandle}-free-gift`;
}

// --- create ---

async function createTwin(sourceHandle, log = () => {}) {
  const source = await getProductByHandle(sourceHandle);
  if (!source) throw new Error(`Source product not found: ${sourceHandle}`);
  const sourceVariant = source.variants.nodes[0];
  if (source.variants.nodes.length > 1) {
    throw new Error(`Source product has ${source.variants.nodes.length} variants — free gift twins only support single-variant products for now`);
  }

  const giftHandle = giftHandleFor(sourceHandle);
  const collectionId = await ensureGiftCollection(log);

  let gift = await getProductByHandle(giftHandle);
  if (gift) {
    log(`✓ Gift twin already exists: ${gift.title} (${gift.status}) — reusing`);
  } else {
    const created = await shopifyGraphQL(`
      mutation productCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product { id title handle variants(first: 1) { nodes { id } } }
          userErrors { field message }
        }
      }
    `, {
      input: {
        title: `${source.title} (FREE GIFT)`,
        handle: giftHandle,
        status: 'DRAFT',
        tags: [GIFT_TAG],
        descriptionHtml: `<p>A free gift from RUBIES. Yours with a qualifying order.</p>`,
      },
    });
    gift = created.productCreate.product;
    log(`✓ Created gift twin: ${gift.title} (${giftHandle}, DRAFT)`);

    // $0 price, source price as compare-at, same SKU so the warehouse picks
    // the same physical item. Inventory untracked: stock truth stays on the
    // source product; tracking a second inventory item would start at 0 and
    // block the cart add.
    const variantId = gift.variants.nodes[0].id;
    await shopifyGraphQL(`
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price compareAtPrice sku }
          userErrors { field message }
        }
      }
    `, {
      productId: gift.id,
      variants: [{
        id: variantId,
        price: '0.00',
        compareAtPrice: sourceVariant.price,
        inventoryItem: { sku: sourceVariant.sku, tracked: false },
      }],
    });
    log(`✓ Variant set: $0.00 (compare at $${sourceVariant.price}), SKU ${sourceVariant.sku || '(none — source has no SKU!)'}, untracked`);

    if (source.featuredMedia?.image?.url) {
      await shopifyGraphQL(`
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id } }
            mediaUserErrors { field message }
          }
        }
      `, {
        productId: gift.id,
        media: [{ originalSource: source.featuredMedia.image.url, mediaContentType: 'IMAGE' }],
      });
      log('✓ Copied product image from source');
    }

    // Hide from storefront search / sitemap
    const shopAwareGiftId = gift.id;
    await shopifyGraphQL(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `, {
      metafields: [{ ownerId: shopAwareGiftId, namespace: 'seo', key: 'hidden', type: 'number_integer', value: '1' }],
    });
    log('✓ Hidden from storefront search (seo.hidden)');

    const publicationId = await getOnlineStorePublicationId();
    await shopifyGraphQL(`
      mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }
    `, { id: gift.id, input: [{ publicationId }] });
    log('✓ Published to Online Store sales channel (required for cart add)');
  }

  await shopifyGraphQL(`
    mutation collectionAddProductsV2($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }
  `, { id: collectionId, productIds: [gift.id] }).catch((err) => {
    if (!String(err.message).includes('already')) throw err;
  });
  log(`✓ In gift collection. Twin stays DRAFT until "enable".`);
  log(`\nNext: node promotions/freeOffer.js enable --minimum 0 --start YYYY-MM-DD --end YYYY-MM-DD`);
}

// --- remove (from offer; product kept for reuse) ---

async function removeTwin(sourceHandle, log = () => {}) {
  const giftHandle = giftHandleFor(sourceHandle);
  const gift = await getProductByHandle(giftHandle);
  if (!gift) throw new Error(`No gift twin found for ${sourceHandle} (looked for handle ${giftHandle})`);
  const collection = await getGiftCollectionProducts();
  if (collection) {
    await shopifyGraphQL(`
      mutation collectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
        collectionRemoveProducts(id: $id, productIds: $productIds) {
          userErrors { field message }
        }
      }
    `, { id: collection.id, productIds: [gift.id] });
  }
  await shopifyGraphQL(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `, { input: { id: gift.id, status: 'DRAFT' } });
  log(`✓ ${gift.title} removed from the offer and set to DRAFT (kept for future reuse)`);
}

// --- enable / disable ---

async function ensureMetafieldDefinitions(log = () => {}) {
  const defs = [
    { key: 'free_gift_offer_collection', type: 'collection_reference', name: 'Free gift offer collection' },
    { key: 'free_gift_offer_minimum', type: 'number_integer', name: 'Free gift offer minimum (USD)' },
    { key: 'free_gift_offer_start', type: 'date', name: 'Free gift offer start date' },
    { key: 'free_gift_offer_end', type: 'date', name: 'Free gift offer end date' },
  ];
  for (const def of defs) {
    try {
      await shopifyGraphQL(`
        mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { field message code }
          }
        }
      `, {
        definition: {
          name: def.name,
          namespace: 'custom',
          key: def.key,
          type: def.type,
          ownerType: 'SHOP',
        },
      });
      log(`✓ Created metafield definition custom.${def.key}`);
    } catch (err) {
      if (String(err.message).includes('TAKEN') || String(err.message).includes('in use')) continue;
      throw err;
    }
  }
}

async function enableOffer(flags, log = () => {}) {
  const minimum = flags.minimum != null ? String(flags.minimum) : '0';
  const start = flags.start;
  const end = flags.end;
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('enable requires --start YYYY-MM-DD and --end YYYY-MM-DD (inclusive, store timezone)');
  }

  const collection = await getGiftCollectionProducts();
  if (!collection || collection.products.nodes.length === 0) {
    throw new Error('Gift collection is empty — run "create --source <handle>" first');
  }

  await ensureMetafieldDefinitions(log);

  for (const product of collection.products.nodes) {
    if (product.status !== 'ACTIVE') {
      await shopifyGraphQL(`
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id status }
            userErrors { field message }
          }
        }
      `, { input: { id: product.id, status: 'ACTIVE' } });
      log(`✓ ${product.title} → ACTIVE`);
    }
  }

  const shopId = await getShopId();
  await shopifyGraphQL(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [
      { ownerId: shopId, namespace: 'custom', key: 'free_gift_offer_collection', type: 'collection_reference', value: collection.id },
      { ownerId: shopId, namespace: 'custom', key: 'free_gift_offer_minimum', type: 'number_integer', value: minimum },
      { ownerId: shopId, namespace: 'custom', key: 'free_gift_offer_start', type: 'date', value: start },
      { ownerId: shopId, namespace: 'custom', key: 'free_gift_offer_end', type: 'date', value: end },
    ],
  });

  log(`\n✓ Offer ENABLED: ${collection.products.nodes.length} gift(s), minimum $${minimum}, ${start} → ${end} (inclusive)`);
  log('  The theme widget activates inside the date window automatically.');
}

async function disableOffer(log = () => {}) {
  const collection = await getGiftCollectionProducts();
  if (collection) {
    for (const product of collection.products.nodes) {
      if (product.status === 'ACTIVE') {
        await shopifyGraphQL(`
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id status }
              userErrors { field message }
            }
          }
        `, { input: { id: product.id, status: 'DRAFT' } });
        log(`✓ ${product.title} → DRAFT`);
      }
    }
  }

  await clearOfferMetafields(log);
  log('\n✓ Offer DISABLED (gift products kept as DRAFT — run "delete --all" for full teardown)');
}

// --- delete (permanent) ---

async function deleteProductById(id, title, log = () => {}) {
  await shopifyGraphQL(`
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `, { input: { id } });
  log(`✓ Deleted ${title}`);
}

async function deleteTwin(flags, log = () => {}) {
  if (flags.all) {
    const collection = await getGiftCollectionProducts();
    if (!collection) {
      log('Gift collection does not exist — nothing to delete.');
      return;
    }
    for (const product of collection.products.nodes) {
      await deleteProductById(product.id, product.title, log);
    }
    await shopifyGraphQL(`
      mutation collectionDelete($input: CollectionDeleteInput!) {
        collectionDelete(input: $input) {
          deletedCollectionId
          userErrors { field message }
        }
      }
    `, { input: { id: collection.id } });
    log(`✓ Deleted collection "${GIFT_COLLECTION_TITLE}"`);
    await clearOfferMetafields(log);
    log('\n✓ Full teardown complete. Next campaign starts fresh with "create".');
    return;
  }

  if (!flags.source) throw new Error('delete requires --source <product-handle> or --all');
  const giftHandle = giftHandleFor(flags.source);
  const gift = await getProductByHandle(giftHandle);
  if (!gift) throw new Error(`No gift twin found for ${flags.source} (looked for handle ${giftHandle})`);
  await deleteProductById(gift.id, gift.title, log);
}

async function clearOfferMetafields(log = () => {}) {
  const shopId = await getShopId();
  const existing = await shopifyGraphQL(`
    { shop { metafields(first: 30, namespace: "custom") { nodes { id key } } } }
  `);
  const toDelete = existing.shop.metafields.nodes
    .filter((m) => METAFIELD_KEYS.includes(m.key))
    .map((m) => ({ ownerId: shopId, namespace: 'custom', key: m.key }));
  if (toDelete.length > 0) {
    await shopifyGraphQL(`
      mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { key }
          userErrors { field message }
        }
      }
    `, { metafields: toDelete });
    log(`✓ Cleared ${toDelete.length} offer metafield(s)`);
  }
}

// --- status ---

async function getStatus() {
  const data = await shopifyGraphQL(`
    { shop { metafields(first: 30, namespace: "custom") { nodes { key value } } } }
  `);
  const mfs = Object.fromEntries(
    data.shop.metafields.nodes.filter((m) => METAFIELD_KEYS.includes(m.key)).map((m) => [m.key, m.value]),
  );
  const collection = await getGiftCollectionProducts();
  return { metafields: mfs, collection };
}

async function printStatus(log = console.log) {
  const { metafields: mfs, collection } = await getStatus();
  log('Free gift offer status');
  log('──────────────────────');
  if (Object.keys(mfs).length === 0) {
    log('Offer metafields: not set (offer disabled)');
  } else {
    log(`Minimum:    $${mfs.free_gift_offer_minimum ?? '(unset)'}`);
    log(`Window:     ${mfs.free_gift_offer_start ?? '?'} → ${mfs.free_gift_offer_end ?? '?'} (inclusive, store TZ)`);
    log(`Collection: ${mfs.free_gift_offer_collection ?? '(unset)'}`);
  }
  if (!collection) {
    log('Gift collection: does not exist yet');
    return;
  }
  log(`Gift collection (${GIFT_COLLECTION_HANDLE}): ${collection.products.nodes.length} product(s)`);
  for (const p of collection.products.nodes) {
    const v = p.variants.nodes[0] || {};
    log(`  - ${p.title} [${p.status}] $${v.price} (compare at $${v.compareAtPrice ?? '—'}) SKU=${v.sku || '(none)'}`);
  }
}

// --- main ---

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'create':
      if (!flags.source) throw new Error('create requires --source <product-handle>');
      await createTwin(flags.source, console.log);
      break;
    case 'remove':
      if (!flags.source) throw new Error('remove requires --source <product-handle>');
      await removeTwin(flags.source, console.log);
      break;
    case 'enable':
      await enableOffer(flags, console.log);
      break;
    case 'disable':
      await disableOffer(console.log);
      break;
    case 'delete':
      await deleteTwin(flags, console.log);
      break;
    case 'status':
      await printStatus();
      break;
    default:
      console.log('Usage: node promotions/freeOffer.js <create|remove|enable|disable|status> [flags]');
      console.log('  create  --source <handle>                        make a $0 gift twin of a product');
      console.log('  remove  --source <handle>                        take a twin out of the offer (kept for reuse)');
      console.log('  enable  --minimum <usd> --start <date> --end <date>   turn the offer on');
      console.log('  disable                                          turn the offer off');
      console.log('  delete  --source <handle> | --all                permanently delete twin(s) (+collection/metafields with --all)');
      console.log('  status                                           show current offer state');
      process.exitCode = command ? 1 : 0;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  createTwin,
  removeTwin,
  enableOffer,
  disableOffer,
  deleteTwin,
  getStatus,
  GIFT_COLLECTION_HANDLE,
};
