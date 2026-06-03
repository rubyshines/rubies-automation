/**
 * Set custom.nickname metafield on Shopify products.
 *
 * Usage:
 *   node scripts/set-product-nicknames.js         # dry-run (print only)
 *   node scripts/set-product-nicknames.js --live  # actually write to Shopify
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { shopifyGraphQL } = require('../customer-service/lib/shopify');

const NICKNAMES = {
  'gid://shopify/Product/4831811928149': 'AJ Underwear',
  'gid://shopify/Product/10173125591318': 'Ava Bra',
  'gid://shopify/Product/6759281754197': 'Brooke Bra',
  'gid://shopify/Product/6796444303445': 'Charlie Underwear',
  'gid://shopify/Product/9747272532246': 'Cheeky Bikini Bottom',
  'gid://shopify/Product/9987603398934': 'Flo Dance Underwear',
  'gid://shopify/Product/6633871310933': 'Mia Bikini Top',
  'gid://shopify/Product/10426378354966': 'Naomi Gaff',
  'gid://shopify/Product/4377663995989': 'Ruby Bikini Bottom',
  'gid://shopify/Product/9987621454102': 'Sassy Underwear',
  'gid://shopify/Product/7978829316374': 'Serena Shorts',
  'gid://shopify/Product/4626260656213': 'Sky One-Piece',
  'gid://shopify/Product/6703815163989': 'Stella Bikini Bottom',
  'gid://shopify/Product/8164625907990': 'Sunny Tankini',
  'gid://shopify/Product/10239847170326': 'Bikini Set',
  'gid://shopify/Product/10239851987222': 'Matching Set',
  'gid://shopify/Product/10239816401174': 'Shaping Bundle',
  'gid://shopify/Product/6633871474773': 'Chest Pads',
  'gid://shopify/Product/8989194715414': 'Gel Pads',
  'gid://shopify/Product/4525607780437': 'Shine Tee',
  'gid://shopify/Product/10455131390230': 'Gift Card',
  // Skipped: PROGRESS PRIDE EARRINGS (8049548362006)
  // Skipped: PROGRESS PRIDE FLAG (6643402506325)
  // Skipped: PROGRESS PRIDE PINS (8049549115670)
  // Skipped: NO-TUCK SHAPING UNDERWEAR (8297143468310)
};

const LIVE = process.argv.includes('--live');

async function run() {
  const metafields = Object.entries(NICKNAMES).map(([ownerId, value]) => ({
    ownerId,
    namespace: 'custom',
    key: 'nickname',
    type: 'single_line_text_field',
    value,
  }));

  console.log(`\nProduct nickname metafield set — ${LIVE ? 'LIVE' : 'DRY RUN'}`);
  console.log(`${'─'.repeat(60)}`);
  for (const mf of metafields) {
    console.log(`  ${mf.ownerId.split('/').pop().padEnd(16)}  ${mf.value}`);
  }
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${metafields.length} products\n`);

  if (!LIVE) {
    console.log('Dry run — pass --live to write to Shopify.');
    return;
  }

  const data = await shopifyGraphQL(`
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `, { metafields });

  const result = data.metafieldsSet;
  if (result.userErrors?.length) {
    console.error('Shopify userErrors:');
    for (const e of result.userErrors) {
      console.error(`  [${e.code}] ${e.field}: ${e.message}`);
    }
    process.exit(1);
  }

  console.log(`Set ${result.metafields.length} metafields successfully.`);
  for (const mf of result.metafields) {
    console.log(`  ${mf.key}  ${mf.value}`);
  }
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
