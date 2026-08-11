#!/usr/bin/env node
/**
 * Seed product_cs_config table with CS-specific metadata for each product.
 *
 * Handles are resolved from the `products` table (synced from Shopify) — never
 * hardcoded — so they stay correct even if Shopify handles diverge from titles.
 *
 * Run: node customer-service/import/seedCsConfig.js
 *  or: npm run cs-seed-cs-config
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

/**
 * CS-specific product metadata, keyed by a title fragment that uniquely
 * identifies each Shopify product.  `product_handle` is intentionally
 * omitted — it will be resolved from the `products` table at seed time.
 */
const CS_PRODUCT_CONFIG = [
  // Underwear bottoms
  { title_match: 'THE AJ NO-TUCK', nickname: 'AJ', category: 'underwear_bottom', keywords: ['aj'], delta_wording: 'bottom' },
  { title_match: 'THE CHARLIE NO-TUCK', nickname: 'Charlie', category: 'underwear_bottom', keywords: ['charlie'], delta_wording: 'bottom' },
  { title_match: 'THE SASSY NO-TUCK', nickname: 'Sassy', category: 'underwear_bottom', keywords: ['sassy'], delta_wording: 'bottom',
    style_switch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening, recommend for tight legs' } },
  { title_match: 'THE FLO SHAPING', nickname: 'Flo', category: 'underwear_bottom', keywords: ['flo'], delta_wording: 'bottom',
    style_switch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening, recommend for tight legs (youth sizes only)' } },
  { title_match: 'THE NAOMI GAFF', nickname: 'Naomi', category: 'underwear_bottom', keywords: ['naomi', 'gaff'], delta_wording: 'bottom',
    sizes_override: ['XS', 'S', 'M', 'L', '1X', '2X'],
    style_switch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Higher-cut cheeky leg, recommend alongside Sassy for tight legs' } },

  // Underwear tops
  { title_match: 'THE BROOKE', nickname: 'Brooke', category: 'underwear_top', keywords: ['brooke'], delta_wording: 'bra' },
  { title_match: 'THE AVA SEAMLESS', nickname: 'Ava', category: 'underwear_top', keywords: ['ava'], delta_wording: 'bra' },

  // Swim bottoms
  { title_match: 'THE RUBY NO-TUCK', nickname: 'Ruby', category: 'swim_bottom', keywords: ['ruby'], delta_wording: 'bottom' },
  { title_match: 'THE STELLA HIGH', nickname: 'Stella', category: 'swim_bottom', keywords: ['stella'], delta_wording: 'bottom' },
  { title_match: 'THE CHEEKY NO-TUCK', nickname: 'Cheeky', category: 'swim_bottom', keywords: ['cheeky'], delta_wording: 'bottom',
    style_switch: { isTarget: true, forCategories: ['swim_bottom'], note: 'Larger leg opening, recommend for tight legs' } },
  { title_match: 'THE SERENA NO-TUCK', nickname: 'Serena', category: 'swim_bottom', keywords: ['serena'], delta_wording: 'bottom' },

  // Swim tops
  { title_match: 'THE MIA HALTER', nickname: 'Mia', category: 'swim_top', keywords: ['mia'], delta_wording: 'bikini_top' },
  { title_match: 'QUEENY TANKINI', nickname: 'Queeny', category: 'swim_top', keywords: ['queeny', 'sunny', 'tankini'], delta_wording: 'top' },

  // One-piece
  { title_match: 'THE SKY NO-TUCK', nickname: 'Sky', category: 'onepiece', keywords: ['sky', 'one-piece'], delta_wording: 'bottom' },

  // Chest pads
  { title_match: 'MAGICAL SHAPING', nickname: 'Magical Chest Pads', category: 'chest_pads', keywords: ['chest pad'], delta_wording: null },
  { title_match: 'RUBIES SHAPING CHEST', nickname: 'Chest Pads', category: 'chest_pads', keywords: ['pad'], delta_wording: null },

  // Accessories
  { title_match: 'NO-TUCK SHAPING UNDERWEAR', nickname: 'No-Tuck Underwear', category: 'underwear_bottom', keywords: ['no-tuck'], delta_wording: 'bottom', exact: true },
  { title_match: 'EVERY GIRL DESERVES', nickname: 'Adult Tee', category: 'accessory', keywords: ['tee'], delta_wording: null },
  { title_match: 'PRIDE EARRINGS', nickname: 'Pride Earrings', category: 'accessory', keywords: ['earring'], delta_wording: null },
  { title_match: 'PRIDE FLAG', nickname: 'Pride Flag', category: 'accessory', keywords: ['flag'], delta_wording: null },
  { title_match: 'PRIDE PINS', nickname: 'Pride Pins', category: 'accessory', keywords: ['pins'], delta_wording: null },

  // Bundles & sets
  { title_match: 'BIKINI SET', nickname: 'Bikini Set', category: 'accessory', keywords: ['bikini set'], delta_wording: null },
  { title_match: 'MATCHING SET', nickname: 'Matching Set', category: 'accessory', keywords: ['matching set'], delta_wording: null },
  { title_match: 'SHAPING BUNDLE', nickname: 'Shaping Bundle', category: 'accessory', keywords: ['bundle'], delta_wording: null },
];

async function seed() {
  const supabase = getSupabaseClient();

  // Load authoritative product handles from Shopify-synced products table
  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('title, handle')
    .eq('status', 'ACTIVE');

  if (prodErr) {
    console.error('Failed to load products table:', prodErr.message);
    process.exit(1);
  }
  if (!products?.length) {
    console.error('No active products in products table. Run product sync first (npm run cs-sync-products).');
    process.exit(1);
  }

  console.log(`Loaded ${products.length} active products from Shopify-synced table.`);

  // Resolve each CS config entry to a real Shopify handle via title matching
  const rows = [];
  const unmatched = [];

  for (const config of CS_PRODUCT_CONFIG) {
    const upper = config.title_match.toUpperCase();
    const match = config.exact
      ? products.find(p => p.title.toUpperCase() === upper)
      : products.find(p => p.title.toUpperCase() === upper)
        || products.find(p => p.title.toUpperCase().includes(upper));
    if (!match) {
      unmatched.push(config.title_match);
      continue;
    }

    const { title_match, exact, ...rest } = config;
    rows.push({
      ...rest,
      product_handle: match.handle,
      status: 'active',
      sizes_override: config.sizes_override || null,
      style_switch: config.style_switch || null,
    });
  }

  if (unmatched.length) {
    console.warn(`WARNING: ${unmatched.length} config entries had no matching product:`);
    for (const t of unmatched) console.warn(`  - "${t}"`);
  }

  if (!rows.length) {
    console.error('No rows to seed — all entries unmatched. Aborting.');
    process.exit(1);
  }

  // Clean out stale rows with handles that no longer match any product
  const validHandles = rows.map(r => r.product_handle);
  const { data: existing } = await supabase
    .from('product_cs_config')
    .select('product_handle');
  const staleHandles = (existing || [])
    .map(r => r.product_handle)
    .filter(h => !validHandles.includes(h));
  if (staleHandles.length) {
    const { error: delErr } = await supabase
      .from('product_cs_config')
      .delete()
      .in('product_handle', staleHandles);
    if (delErr) console.warn('Warning: failed to clean stale rows:', delErr.message);
    else console.log(`Removed ${staleHandles.length} stale rows: ${staleHandles.join(', ')}`);
  }

  const { error } = await supabase
    .from('product_cs_config')
    .upsert(rows, { onConflict: 'product_handle', ignoreDuplicates: false });

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }

  console.log(`Seeded ${rows.length} products into product_cs_config (resolved handles from products table).`);
  if (unmatched.length) {
    console.warn(`${unmatched.length} entries skipped — check warnings above.`);
  }
}

seed().catch(err => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
