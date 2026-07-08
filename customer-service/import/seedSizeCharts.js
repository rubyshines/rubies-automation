#!/usr/bin/env node

/**
 * Seed Size Charts & Grading Rules
 *
 * Populates size_charts (measurement → size lookup) and size_grading_rules
 * (relative sizing: fabric delta per size step) from the 8 RUBIES size guide pages.
 *
 * Data source: rubyshines.com/pages/size-guide-* (scraped March 2026)
 *
 * Usage:
 *   node customer-service/import/seedSizeCharts.js
 *   node customer-service/import/seedSizeCharts.js --refresh   # clear + re-seed
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Size chart data (from rubyshines.com size guide pages)
// ---------------------------------------------------------------------------

const SIZE_CHARTS = [
  // --- Kids Underwear Bottoms (even sizes only, waist) ---
  { category: 'kids_underwear_bottoms', size: '4',  type: 'waist', min_in: 18,   max_in: 19.5, min_cm: 45.5, max_cm: 49.5 },
  { category: 'kids_underwear_bottoms', size: '6',  type: 'waist', min_in: 19.5, max_in: 21.5, min_cm: 49.5, max_cm: 54.5 },
  { category: 'kids_underwear_bottoms', size: '8',  type: 'waist', min_in: 21.5, max_in: 23.5, min_cm: 54.5, max_cm: 59.5 },
  { category: 'kids_underwear_bottoms', size: '10', type: 'waist', min_in: 23.5, max_in: 25.5, min_cm: 59.5, max_cm: 65 },
  { category: 'kids_underwear_bottoms', size: '12', type: 'waist', min_in: 25.5, max_in: 27.5, min_cm: 65,   max_cm: 70 },
  { category: 'kids_underwear_bottoms', size: '14', type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'kids_underwear_bottoms', size: '16', type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },

  // --- Kids Swimwear Bottoms (even + odd sizes, waist) ---
  { category: 'kids_swimwear_bottoms', size: '4',  type: 'waist', min_in: 18,   max_in: 19.5, min_cm: 45.5, max_cm: 49.5 },
  { category: 'kids_swimwear_bottoms', size: '6',  type: 'waist', min_in: 19.5, max_in: 20.5, min_cm: 49.5, max_cm: 52 },
  { category: 'kids_swimwear_bottoms', size: '7',  type: 'waist', min_in: 20.5, max_in: 21.5, min_cm: 52,   max_cm: 54.5 },
  { category: 'kids_swimwear_bottoms', size: '8',  type: 'waist', min_in: 21.5, max_in: 22.5, min_cm: 54.5, max_cm: 57 },
  { category: 'kids_swimwear_bottoms', size: '9',  type: 'waist', min_in: 22.5, max_in: 23.5, min_cm: 57,   max_cm: 59.5 },
  { category: 'kids_swimwear_bottoms', size: '10', type: 'waist', min_in: 23.5, max_in: 24.5, min_cm: 59.5, max_cm: 62 },
  { category: 'kids_swimwear_bottoms', size: '11', type: 'waist', min_in: 24.5, max_in: 25.5, min_cm: 62,   max_cm: 65 },
  { category: 'kids_swimwear_bottoms', size: '12', type: 'waist', min_in: 25.5, max_in: 26.5, min_cm: 65,   max_cm: 67.5 },
  { category: 'kids_swimwear_bottoms', size: '13', type: 'waist', min_in: 26.5, max_in: 27.5, min_cm: 67.5, max_cm: 70 },
  { category: 'kids_swimwear_bottoms', size: '14', type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'kids_swimwear_bottoms', size: '16', type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },

  // --- Kids Tops (even sizes, chest) ---
  { category: 'kids_tops', size: '4',  type: 'chest', min_in: 20, max_in: 22, min_cm: 51,   max_cm: 56 },
  { category: 'kids_tops', size: '6',  type: 'chest', min_in: 22, max_in: 24, min_cm: 56,   max_cm: 61 },
  { category: 'kids_tops', size: '8',  type: 'chest', min_in: 24, max_in: 26, min_cm: 61,   max_cm: 66 },
  { category: 'kids_tops', size: '10', type: 'chest', min_in: 26, max_in: 28, min_cm: 66,   max_cm: 71 },
  { category: 'kids_tops', size: '12', type: 'chest', min_in: 28, max_in: 30, min_cm: 71,   max_cm: 76 },
  { category: 'kids_tops', size: '14', type: 'chest', min_in: 30, max_in: 32, min_cm: 76,   max_cm: 81.5 },
  { category: 'kids_tops', size: '16', type: 'chest', min_in: 32, max_in: 34, min_cm: 81.5, max_cm: 86.5 },

  // --- Kids One-Piece (odd + even sizes, waist) — same as swimwear ---
  { category: 'kids_onepiece', size: '4',  type: 'waist', min_in: 18,   max_in: 19.5, min_cm: 45.5, max_cm: 49.5 },
  { category: 'kids_onepiece', size: '6',  type: 'waist', min_in: 19.5, max_in: 20.5, min_cm: 49.5, max_cm: 52 },
  { category: 'kids_onepiece', size: '7',  type: 'waist', min_in: 20.5, max_in: 21.5, min_cm: 52,   max_cm: 54.5 },
  { category: 'kids_onepiece', size: '8',  type: 'waist', min_in: 21.5, max_in: 22.5, min_cm: 54.5, max_cm: 57 },
  { category: 'kids_onepiece', size: '9',  type: 'waist', min_in: 22.5, max_in: 23.5, min_cm: 57,   max_cm: 59.5 },
  { category: 'kids_onepiece', size: '10', type: 'waist', min_in: 23.5, max_in: 24.5, min_cm: 59.5, max_cm: 62 },
  { category: 'kids_onepiece', size: '11', type: 'waist', min_in: 24.5, max_in: 25.5, min_cm: 62,   max_cm: 65 },
  { category: 'kids_onepiece', size: '12', type: 'waist', min_in: 25.5, max_in: 26.5, min_cm: 65,   max_cm: 67.5 },
  { category: 'kids_onepiece', size: '13', type: 'waist', min_in: 26.5, max_in: 27.5, min_cm: 67.5, max_cm: 70 },
  { category: 'kids_onepiece', size: '14', type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'kids_onepiece', size: '16', type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },
  // Kids one-piece height (Regular/Tall for 14 and 16 only)
  { category: 'kids_onepiece', size: '14', type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'kids_onepiece', size: '14', type: 'height', min_in: 66, max_in: 70, min_cm: 168, max_cm: 178, notes: 'Tall' },
  { category: 'kids_onepiece', size: '16', type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'kids_onepiece', size: '16', type: 'height', min_in: 66, max_in: 70, min_cm: 168, max_cm: 178, notes: 'Tall' },

  // --- Adult Swimwear Bottoms (with + sizes, waist) ---
  { category: 'adult_swimwear_bottoms', size: 'XXS',  type: 'waist', min_in: 23.5, max_in: 24.5, min_cm: 59.5, max_cm: 62 },
  { category: 'adult_swimwear_bottoms', size: 'XXS+', type: 'waist', min_in: 24.5, max_in: 25.5, min_cm: 62,   max_cm: 65 },
  { category: 'adult_swimwear_bottoms', size: 'XS',   type: 'waist', min_in: 25.5, max_in: 26.5, min_cm: 65,   max_cm: 67.5 },
  { category: 'adult_swimwear_bottoms', size: 'XS+',  type: 'waist', min_in: 26.5, max_in: 27.5, min_cm: 67.5, max_cm: 70 },
  { category: 'adult_swimwear_bottoms', size: 'S',    type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'adult_swimwear_bottoms', size: 'M',    type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },
  { category: 'adult_swimwear_bottoms', size: 'L',    type: 'waist', min_in: 32,   max_in: 34.5, min_cm: 81.5, max_cm: 87.5 },
  { category: 'adult_swimwear_bottoms', size: '1X',   type: 'waist', min_in: 34.5, max_in: 37,   min_cm: 87.5, max_cm: 94 },
  { category: 'adult_swimwear_bottoms', size: '2X',   type: 'waist', min_in: 37,   max_in: 39.5, min_cm: 94,   max_cm: 100.5 },
  { category: 'adult_swimwear_bottoms', size: '3X',   type: 'waist', min_in: 39.5, max_in: 42,   min_cm: 100.5, max_cm: 106.5 },
  { category: 'adult_swimwear_bottoms', size: '4X',   type: 'waist', min_in: 42,   max_in: 45,   min_cm: 106.5, max_cm: 114 },

  // --- Adult Underwear Bottoms (NO + sizes, waist) ---
  { category: 'adult_underwear_bottoms', size: 'XXS', type: 'waist', min_in: 23.5, max_in: 25.5, min_cm: 59.5, max_cm: 65 },
  { category: 'adult_underwear_bottoms', size: 'XS',  type: 'waist', min_in: 25.5, max_in: 27.5, min_cm: 65,   max_cm: 70 },
  { category: 'adult_underwear_bottoms', size: 'S',   type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'adult_underwear_bottoms', size: 'M',   type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },
  { category: 'adult_underwear_bottoms', size: 'L',   type: 'waist', min_in: 32,   max_in: 34.5, min_cm: 81.5, max_cm: 87.5 },
  { category: 'adult_underwear_bottoms', size: '1X',  type: 'waist', min_in: 34.5, max_in: 37,   min_cm: 87.5, max_cm: 94 },
  { category: 'adult_underwear_bottoms', size: '2X',  type: 'waist', min_in: 37,   max_in: 39.5, min_cm: 94,   max_cm: 100.5 },
  { category: 'adult_underwear_bottoms', size: '3X',  type: 'waist', min_in: 39.5, max_in: 42,   min_cm: 100.5, max_cm: 106.5 },
  { category: 'adult_underwear_bottoms', size: '4X',  type: 'waist', min_in: 42,   max_in: 45,   min_cm: 106.5, max_cm: 114 },

  // --- Adult Tops (no + sizes, chest) ---
  { category: 'adult_tops', size: 'XXS', type: 'chest', min_in: 26, max_in: 28, min_cm: 66,   max_cm: 71 },
  { category: 'adult_tops', size: 'XS',  type: 'chest', min_in: 28, max_in: 30, min_cm: 71,   max_cm: 76 },
  { category: 'adult_tops', size: 'S',   type: 'chest', min_in: 30, max_in: 32, min_cm: 76,   max_cm: 81.5 },
  { category: 'adult_tops', size: 'M',   type: 'chest', min_in: 32, max_in: 34, min_cm: 81.5, max_cm: 86.5 },
  { category: 'adult_tops', size: 'L',   type: 'chest', min_in: 34, max_in: 36, min_cm: 86.5, max_cm: 91.5 },
  { category: 'adult_tops', size: '1X',  type: 'chest', min_in: 36, max_in: 38, min_cm: 91.5, max_cm: 96.5 },
  { category: 'adult_tops', size: '2X',  type: 'chest', min_in: 38, max_in: 40, min_cm: 96.5, max_cm: 101.5 },
  // 3X max_cm 106.5 (not 106): every other 42-inch boundary converts to 106.5
  // on both sides — 106 left a 0.5cm hole where e.g. a 106.2cm chest matched
  // no size at all.
  { category: 'adult_tops', size: '3X',  type: 'chest', min_in: 40, max_in: 42, min_cm: 101.5, max_cm: 106.5 },
  { category: 'adult_tops', size: '4X',  type: 'chest', min_in: 42, max_in: 45, min_cm: 106.5, max_cm: 114 },

  // --- Adult One-Piece (with + sizes for XS, waist + height) ---
  { category: 'adult_onepiece', size: 'XS',  type: 'waist', min_in: 25.5, max_in: 26.5, min_cm: 65,   max_cm: 67.5 },
  { category: 'adult_onepiece', size: 'XS+', type: 'waist', min_in: 26.5, max_in: 27.5, min_cm: 67.5, max_cm: 70 },
  { category: 'adult_onepiece', size: 'S',   type: 'waist', min_in: 27.5, max_in: 29.5, min_cm: 70,   max_cm: 75 },
  { category: 'adult_onepiece', size: 'M',   type: 'waist', min_in: 29.5, max_in: 32,   min_cm: 75,   max_cm: 81.5 },
  { category: 'adult_onepiece', size: 'L',   type: 'waist', min_in: 32,   max_in: 34.5, min_cm: 81.5, max_cm: 87.5 },
  { category: 'adult_onepiece', size: '1X',  type: 'waist', min_in: 34.5, max_in: 37,   min_cm: 87.5, max_cm: 94 },
  { category: 'adult_onepiece', size: '2X',  type: 'waist', min_in: 37,   max_in: 39.5, min_cm: 94,   max_cm: 100.5 },
  { category: 'adult_onepiece', size: '3X',  type: 'waist', min_in: 39.5, max_in: 42,   min_cm: 100.5, max_cm: 106.5 },
  // Adult one-piece height
  { category: 'adult_onepiece', size: 'XS',  type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'adult_onepiece', size: 'XS+', type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'adult_onepiece', size: 'S',   type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'adult_onepiece', size: 'S',   type: 'height', min_in: 66, max_in: 70, min_cm: 168, max_cm: 178, notes: 'Tall' },
  { category: 'adult_onepiece', size: 'M',   type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'adult_onepiece', size: 'M',   type: 'height', min_in: 66, max_in: 70, min_cm: 168, max_cm: 178, notes: 'Tall' },
  { category: 'adult_onepiece', size: 'L',   type: 'height', min_in: 62, max_in: 66, min_cm: 157, max_cm: 168, notes: 'Regular' },
  { category: 'adult_onepiece', size: 'L',   type: 'height', min_in: 66, max_in: 70, min_cm: 168, max_cm: 178, notes: 'Tall' },
  { category: 'adult_onepiece', size: '1X',  type: 'height', min_in: 66, max_in: 69, min_cm: 168, max_cm: 175, notes: 'Regular' },
  { category: 'adult_onepiece', size: '1X',  type: 'height', min_in: 69, max_in: 73, min_cm: 175, max_cm: 186, notes: 'Tall' },
  { category: 'adult_onepiece', size: '2X',  type: 'height', min_in: 66, max_in: 69, min_cm: 168, max_cm: 175, notes: 'Regular' },
  { category: 'adult_onepiece', size: '2X',  type: 'height', min_in: 69, max_in: 73, min_cm: 175, max_cm: 186, notes: 'Tall' },
  { category: 'adult_onepiece', size: '3X',  type: 'height', min_in: 66, max_in: 69, min_cm: 168, max_cm: 175, notes: 'Regular' },
  { category: 'adult_onepiece', size: '3X',  type: 'height', min_in: 69, max_in: 73, min_cm: 175, max_cm: 186, notes: 'Tall' },

  // --- Chest Pads (simplified — maps to size ranges) ---
  { category: 'chest_pads', size: 'S', type: 'chest', min_in: 22, max_in: 28, min_cm: 56, max_cm: 71, notes: 'Youth 6-10 / Adult XXS' },
  { category: 'chest_pads', size: 'M', type: 'chest', min_in: 28, max_in: 36, min_cm: 71, max_cm: 91.5, notes: 'Youth 12-16 / Adult XS-L' },
  { category: 'chest_pads', size: 'L', type: 'chest', min_in: 36, max_in: 45, min_cm: 91.5, max_cm: 114, notes: 'Adult 1X-4X' },
];

// ---------------------------------------------------------------------------
// Grading rules — fabric delta per size step
// Even sizes: +2" (5cm). Odd/half sizes: +1" (2.5cm)
// ---------------------------------------------------------------------------

function generateGradingRules() {
  const rules = [];

  // Helper: generate pairs for a size list
  function addPairs(category, sizes, isOddHalf) {
    for (let i = 0; i < sizes.length - 1; i++) {
      const delta = isOddHalf(sizes[i], sizes[i + 1]) ? 1 : 2;
      const deltaCm = isOddHalf(sizes[i], sizes[i + 1]) ? 2.5 : 5;
      rules.push({
        category,
        from: sizes[i],
        to: sizes[i + 1],
        delta_in: delta,
        delta_cm: deltaCm,
      });
    }
  }

  const ODD = new Set(['7', '9', '11', '13', 'XXS+', 'XS+']);
  const isOdd = (from, to) => ODD.has(from) || ODD.has(to);
  const neverOdd = () => false;

  // Kids underwear bottoms (even only)
  addPairs('kids_underwear_bottoms', ['4', '6', '8', '10', '12', '14', '16'], neverOdd);

  // Kids swimwear bottoms (even + odd)
  addPairs('kids_swimwear_bottoms', ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16'], isOdd);

  // Kids tops (even only)
  addPairs('kids_tops', ['4', '6', '8', '10', '12', '14', '16'], neverOdd);

  // Kids one-piece (even + odd, same as swimwear)
  addPairs('kids_onepiece', ['4', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16'], isOdd);

  // Adult swimwear bottoms (with + sizes)
  addPairs('adult_swimwear_bottoms', ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], isOdd);

  // Adult underwear bottoms (no + sizes)
  addPairs('adult_underwear_bottoms', ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], neverOdd);

  // Adult tops (no + sizes)
  addPairs('adult_tops', ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], neverOdd);

  // Adult one-piece (with XS+)
  addPairs('adult_onepiece', ['XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X'], isOdd);

  return rules;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const supabase = getSupabaseClient();

  if (refresh) {
    console.log('Clearing existing size data...');
    await supabase.from('size_charts').delete().neq('id', 0);
    await supabase.from('size_grading_rules').delete().neq('id', 0);
  }

  // --- Seed size charts ---
  console.log(`\nSeeding ${SIZE_CHARTS.length} size chart entries...\n`);

  let chartSeeded = 0;
  for (const entry of SIZE_CHARTS) {
    const { error } = await supabase
      .from('size_charts')
      .upsert({
        chart_category: entry.category,
        size_label: entry.size,
        measurement_type: entry.type,
        min_inches: entry.min_in,
        max_inches: entry.max_in,
        min_cm: entry.min_cm,
        max_cm: entry.max_cm,
        notes: entry.notes || null,
      }, { onConflict: 'chart_category,size_label,measurement_type,notes' });

    if (error) {
      console.error(`  [Error] ${entry.category} ${entry.size} ${entry.type}: ${error.message}`);
    } else {
      chartSeeded++;
    }
  }
  console.log(`Size charts: ${chartSeeded}/${SIZE_CHARTS.length} seeded`);

  // --- Seed grading rules ---
  const gradingRules = generateGradingRules();
  console.log(`\nSeeding ${gradingRules.length} grading rules...\n`);

  let gradingSeeded = 0;
  for (const rule of gradingRules) {
    const { error } = await supabase
      .from('size_grading_rules')
      .upsert({
        chart_category: rule.category,
        size_from: rule.from,
        size_to: rule.to,
        delta_inches: rule.delta_in,
        delta_cm: rule.delta_cm,
        direction: 'up',
      }, { onConflict: 'chart_category,size_from,size_to,direction' });

    if (error) {
      console.error(`  [Error] ${rule.category} ${rule.from}→${rule.to}: ${error.message}`);
    } else {
      gradingSeeded++;
    }
  }
  console.log(`Grading rules: ${gradingSeeded}/${gradingRules.length} seeded`);

  // --- Summary ---
  console.log(`\n========================================`);
  console.log(`Size charts: ${chartSeeded} entries across ${new Set(SIZE_CHARTS.map(e => e.category)).size} categories`);
  console.log(`Grading rules: ${gradingSeeded} entries`);
  console.log(`========================================`);

  // Show category breakdown
  const categories = {};
  for (const entry of SIZE_CHARTS) {
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }
  console.log('\nBy category:');
  for (const [cat, count] of Object.entries(categories)) {
    console.log(`  ${cat}: ${count} sizes`);
  }
}

main().catch(err => {
  console.error('[seedSizeCharts] Fatal error:', err);
  process.exit(1);
});
