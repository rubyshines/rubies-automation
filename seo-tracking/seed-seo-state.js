#!/usr/bin/env node

/**
 * One-time migration: seed seo_strategy_items + seo_tracked_urls.
 * Idempotent — safe to run multiple times.
 *
 * Run: node seo-tracking/seed-seo-state.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getSupabaseClient } = require('../shared/supabaseClient');

async function main() {
  const supabase = getSupabaseClient();

  // --- Strategy items ---
  const taskRows = [
    { id: 'phase1_task1', type: 'task', name: 'Fix title tags & meta descriptions', status: 'completed', completed_date: '2026-02-20', sort_order: 0 },
    { id: 'phase1_task2', type: 'task', name: 'Product URL redirect', status: 'completed', completed_date: '2026-02-20', sort_order: 1 },
    { id: 'phase2_task3', type: 'task', name: 'Enrich landing pages', status: 'completed', completed_date: '2026-03-08', sort_order: 2 },
    { id: 'phase2_task4', type: 'task', name: 'Launch blog (5 posts)', status: 'not_started', notes: '', sort_order: 3 },
    { id: 'phase2_task5', type: 'task', name: 'Add schema markup', status: 'completed', completed_date: '2026-03-10', sort_order: 4 },
    { id: 'phase3_task6', type: 'task', name: 'Scale content production', status: 'not_started', sort_order: 5 },
    { id: 'phase3_task7', type: 'task', name: 'Build new backlinks', status: 'not_started', sort_order: 6 },
    { id: 'phase3_task8', type: 'task', name: 'Dominate both audiences', status: 'not_started', sort_order: 7 },
    { id: 'phase3_task9', type: 'task', name: 'Internal linking architecture', status: 'not_started', sort_order: 8 },
  ];

  const blogRows = [
    { id: 'no_tuck_vs_tucking', type: 'blog_post', name: 'no tuck vs tucking', status: 'not_started', target_keywords: ['no tuck swimwear', 'non tucking gaff', 'gaff alternative'], sort_order: 100 },
    { id: 'parents_guide_swimwear', type: 'blog_post', name: 'parents guide swimwear', status: 'not_started', target_keywords: ['swimwear trans daughter', 'trans youth swimwear'], sort_order: 101 },
    { id: 'comfortable_underwear_trans_woman', type: 'blog_post', name: 'comfortable underwear trans woman', status: 'not_started', target_keywords: ['trans women underwear', 'mtf underwear'], sort_order: 102 },
    { id: 'shaping_technology', type: 'blog_post', name: 'shaping technology', status: 'not_started', target_keywords: ['no tuck underwear', 'how does shaping work'], sort_order: 103 },
    { id: 'swimming_confidence', type: 'blog_post', name: 'swimming confidence', status: 'not_started', target_keywords: ['comfortable trans swimwear', 'swimming trans'], sort_order: 104 },
  ];

  const allItems = [...taskRows, ...blogRows];
  const { error: e1 } = await supabase
    .from('seo_strategy_items')
    .upsert(allItems, { onConflict: 'id' });

  if (e1) {
    console.error('Failed to seed strategy items:', e1.message);
    process.exit(1);
  }
  console.log(`Seeded ${allItems.length} strategy items (${taskRows.length} tasks, ${blogRows.length} blog posts)`);

  // --- Tracked URLs ---
  const urlRows = [
    // Priority products
    ...[
      '/products/the-aj-shaping-underwear',
      '/products/the-ruby-no-tuck-shaping-bikini-bottom',
      '/products/the-sky-shaping-one-piece',
      '/products/the-brooke-bra',
      '/products/the-extra-cute-shaping-underwear',
      '/products/the-shaping-shorty-shorts',
      '/products/shaping_chest-pads',
      '/products/magical-shaping-chest-pads',
    ].map(u => ({ url: u, category: 'priority_product' })),
    // Priority pages
    ...[
      '/pages/how-it-works',
      '/pages/shop-adults',
      '/pages/shop-kids',
      '/pages/about-us',
      '/pages/size-guide',
      '/pages/exchanges-and-returns',
      '/pages/stock-rubies-in-your-store',
      '/pages/customer-care',
    ].map(u => ({ url: u, category: 'priority_page' })),
    // Redirect sources
    ...[
      '/pages/contact',
      '/pages/pass-it-along',
      '/pages/how-to-wear',
      '/pages/exchanges-and-returns',
      '/pages/shop-unicorns',
      '/pages/about',
      '/collections/new-arrivals',
      '/collections/form-fitting-clothing',
      '/collections/the-most-comfortable-underwear-for-trans-women',
      '/collections/everyday',
      '/collections/adults',
      '/collections/swimwear',
      '/collections/shop-all',
      '/collections/the-most-comfortable-swimwear-for-trans-girls-and-adults',
      '/collections/shaping-products',
      '/products/form-fitting-bikini-bottom',
      '/products/no-tuck-shaping-underwear',
    ].map(u => ({ url: u, category: 'redirect_source' })),
  ];

  const { error: e2 } = await supabase
    .from('seo_tracked_urls')
    .upsert(urlRows, { onConflict: 'url,category' });

  if (e2) {
    console.error('Failed to seed tracked URLs:', e2.message);
    process.exit(1);
  }
  console.log(`Seeded ${urlRows.length} tracked URLs`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
