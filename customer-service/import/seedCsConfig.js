#!/usr/bin/env node
/**
 * Seed product_cs_config table with all existing RUBIES products.
 * Idempotent — uses ON CONFLICT DO NOTHING.
 *
 * Run: node customer-service/import/seedCsConfig.js
 *  or: npm run cs-seed-cs-config
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

const PRODUCTS = [
  // Underwear bottoms
  { product_handle: 'the-aj-no-tuck-shaping-underwear', nickname: 'AJ', category: 'underwear_bottom', keywords: ['aj'], delta_wording: 'bottom' },
  { product_handle: 'the-charlie-no-tuck-extra-cute-shaping-underwear', nickname: 'Charlie', category: 'underwear_bottom', keywords: ['charlie'], delta_wording: 'bottom' },
  { product_handle: 'the-sassy-no-tuck-shaping-underwear', nickname: 'Sassy', category: 'underwear_bottom', keywords: ['sassy'], delta_wording: 'bottom',
    style_switch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Larger leg opening, recommend for tight legs' } },
  { product_handle: 'the-flo-shaping-dance-underwear', nickname: 'Flo', category: 'underwear_bottom', keywords: ['flo'], delta_wording: 'bottom' },
  { product_handle: 'the-naomi-gaff-extra-strength-shaping-underwear', nickname: 'Naomi', category: 'underwear_bottom', keywords: ['naomi', 'gaff'], delta_wording: 'bottom',
    sizes_override: ['XS', 'S', 'M', 'L', '1X', '2X'],
    style_switch: { isTarget: true, forCategories: ['underwear_bottom'], note: 'Higher-cut cheeky leg, recommend alongside Sassy for tight legs' } },

  // Underwear tops
  { product_handle: 'the-brooke-shaping-bra', nickname: 'Brooke', category: 'underwear_top', keywords: ['brooke'], delta_wording: 'bra' },
  { product_handle: 'the-ava-seamless-shaping-bra', nickname: 'Ava', category: 'underwear_top', keywords: ['ava'], delta_wording: 'bra' },

  // Swim bottoms
  { product_handle: 'the-ruby-no-tuck-shaping-bikini-bottom', nickname: 'Ruby', category: 'swim_bottom', keywords: ['ruby'], delta_wording: 'bottom' },
  { product_handle: 'the-stella-high-waisted-shaping-bikini-bottom', nickname: 'Stella', category: 'swim_bottom', keywords: ['stella'], delta_wording: 'bottom' },
  { product_handle: 'the-cheeky-no-tuck-shaping-bikini-bottom', nickname: 'Cheeky', category: 'swim_bottom', keywords: ['cheeky'], delta_wording: 'bottom' },
  { product_handle: 'the-serena-no-tuck-shaping-shorty-short', nickname: 'Serena', category: 'swim_bottom', keywords: ['serena'], delta_wording: 'bottom' },

  // Swim tops
  { product_handle: 'the-mia-halter-bikini-top', nickname: 'Mia', category: 'swim_top', keywords: ['mia'], delta_wording: 'bikini_top' },
  { product_handle: 'the-sunny-queeny-tankini', nickname: 'Queeny', category: 'swim_top', keywords: ['queeny', 'sunny', 'tankini'], delta_wording: 'top' },

  // One-piece
  { product_handle: 'the-sky-no-tuck-shaping-one-piece', nickname: 'Sky', category: 'onepiece', keywords: ['sky', 'one-piece'], delta_wording: 'bottom' },

  // Chest pads
  { product_handle: 'magical-shaping-gel-chest-pads', nickname: 'Magical Chest Pads', category: 'chest_pads', keywords: ['chest pad'], delta_wording: null },
  { product_handle: 'rubies-shaping-chest-pads', nickname: 'Chest Pads', category: 'chest_pads', keywords: ['pad'], delta_wording: null },

  // Accessories
  { product_handle: 'no-tuck-shaping-underwear', nickname: 'No-Tuck Underwear', category: 'underwear_bottom', keywords: ['no-tuck'], delta_wording: 'bottom' },
  { product_handle: 'every-girl-deserves-to-shine-adult-tee', nickname: 'Adult Tee', category: 'accessory', keywords: ['tee'], delta_wording: null },
  { product_handle: 'rubies-gift-card', nickname: 'Gift Card', category: 'accessory', keywords: ['gift card'], delta_wording: null },
  { product_handle: 'progress-pride-earrings', nickname: 'Pride Earrings', category: 'accessory', keywords: ['earring'], delta_wording: null },
  { product_handle: 'progress-pride-flag', nickname: 'Pride Flag', category: 'accessory', keywords: ['flag'], delta_wording: null },
  { product_handle: 'progress-pride-pins', nickname: 'Pride Pins', category: 'accessory', keywords: ['pins'], delta_wording: null },

  // Bundles & sets
  { product_handle: 'the-rubies-bikini-set-bikini-bottom-bikini-top', nickname: 'Bikini Set', category: 'accessory', keywords: ['bikini set'], delta_wording: null },
  { product_handle: 'the-rubies-matching-set-underwear-bra', nickname: 'Matching Set', category: 'accessory', keywords: ['matching set'], delta_wording: null },
  { product_handle: 'the-rubies-shaping-bundle-3-aj-underwear-1-bikini-bottom', nickname: 'Shaping Bundle', category: 'accessory', keywords: ['bundle'], delta_wording: null },
];

async function seed() {
  const supabase = getSupabaseClient();

  // Add status + defaults
  const rows = PRODUCTS.map(p => ({
    ...p,
    status: 'active',
    sizes_override: p.sizes_override || null,
    style_switch: p.style_switch || null,
  }));

  const { data, error } = await supabase
    .from('product_cs_config')
    .upsert(rows, { onConflict: 'product_handle', ignoreDuplicates: false });

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }

  console.log(`Seeded ${rows.length} products into product_cs_config.`);
}

seed().catch(err => {
  console.error('Seed error:', err.message);
  process.exit(1);
});
