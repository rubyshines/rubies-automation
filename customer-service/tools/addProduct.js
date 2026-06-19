#!/usr/bin/env node
/**
 * Product Management CLI
 *
 * Add, activate, deactivate, and push products to Shopify.
 * CS-exchange config lives in Supabase (product_cs_config table).
 * Shopify owns product data (title, price, variants, metafields).
 *
 * Usage:
 *   npm run cs-manage-product                              # Interactive add
 *   npm run cs-manage-product -- --activate <handle>       # Activate (config + Shopify + KB)
 *   npm run cs-manage-product -- --deactivate <handle>     # Deactivate (config + Shopify)
 *   npm run cs-manage-product -- --create-shopify <handle> # Push config entry to Shopify
 *   npm run cs-manage-product -- --list                    # List all products
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch {}
}

const fs = require('fs');
const readline = require('readline');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const SIZING_GUIDE_PATH = path.join(__dirname, '..', 'knowledge', 'sizing-guide.md');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  'underwear_bottom', 'underwear_top', 'swim_bottom', 'swim_top',
  'onepiece', 'chest_pads', 'accessory',
];

const CATEGORY_DEFAULTS = {
  underwear_bottom: { sizes: ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], deltaWording: 'bottom', productType: 'Underwear' },
  underwear_top:    { sizes: ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], deltaWording: 'bra', productType: 'Bra' },
  swim_bottom:      { sizes: ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], deltaWording: 'bottom', productType: 'Swimwear' },
  swim_top:         { sizes: ['XXS', 'XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], deltaWording: 'bikini_top', productType: 'Swimwear' },
  onepiece:         { sizes: ['XXS', 'XXS+', 'XS', 'XS+', 'S', 'M', 'L', '1X', '2X', '3X', '4X'], deltaWording: 'bottom', productType: 'Swimwear' },
  chest_pads:       { sizes: ['S', 'M', 'L'], deltaWording: null, productType: 'Accessories' },
  accessory:        { sizes: [], deltaWording: null, productType: 'Accessories' },
};

const COLLECTION_SUGGESTIONS = {
  underwear_bottom: ['Underwear', 'Shaping', 'New Arrivals'],
  underwear_top:    ['Bras', 'Shaping', 'New Arrivals'],
  swim_bottom:      ['Swimwear', 'Shaping', 'New Arrivals'],
  swim_top:         ['Swimwear', 'Shaping', 'New Arrivals'],
  onepiece:         ['Swimwear', 'Shaping', 'New Arrivals'],
  chest_pads:       ['Accessories'],
  accessory:        ['Accessories'],
};

const STANDARD_COLORS = [
  { name: 'Black', code: 'BLK' },
  { name: 'Nude', code: 'NDE' },
  { name: 'Pink', code: 'PNK' },
];

const DELTA_WORDING_OPTIONS = ['bottom', 'bra', 'bikini_top', 'top'];

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function loadAllConfigs() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('product_cs_config')
    .select('*')
    .order('nickname');
  if (error) throw new Error(`Failed to load configs: ${error.message}`);
  return data || [];
}

async function getConfig(handle) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('product_cs_config')
    .select('*')
    .eq('product_handle', handle)
    .single();
  if (error) return null;
  return data;
}

async function upsertConfig(row) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('product_cs_config')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'product_handle' });
  if (error) throw new Error(`Failed to save config: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function pickOption(rl, prompt, options) {
  console.log(`\n${prompt}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  while (true) {
    const answer = await ask(rl, `Choice (1-${options.length}): `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    console.log('  Invalid choice, try again.');
  }
}

async function askYesNo(rl, question) {
  const answer = await ask(rl, `${question} (y/n): `);
  return answer.trim().toLowerCase().startsWith('y');
}

// ---------------------------------------------------------------------------
// Shopify operations
// ---------------------------------------------------------------------------

function generateVariants(sizes, colors, skuPrefix, price) {
  const variants = [];
  for (const color of colors) {
    for (const size of sizes) {
      variants.push({
        optionValues: [
          { name: size, optionName: 'Size' },
          { name: color.name, optionName: 'Color' },
        ],
        price: String(price),
        sku: `${skuPrefix}-${color.code}-${size}`,
      });
    }
  }
  return variants;
}

function buildMetafields(entry) {
  const mf = [];
  const add = (key, value) => {
    if (value && (Array.isArray(value) ? value.length > 0 : true)) {
      mf.push({
        namespace: 'custom',
        key,
        type: Array.isArray(value) ? 'list.single_line_text_field' : 'single_line_text_field',
        value: Array.isArray(value) ? JSON.stringify(value) : String(value),
      });
    }
  };
  add('categories', [entry.category]);
  add('age_groups', entry.ageGroups || ['adult']);
  if (entry.sizes) add('adult_sizes', entry.sizes);
  if (entry.colors) {
    const colorNames = entry.colors.map(c => c.name);
    add('adult_colors', colorNames);
  }
  if (entry.collections) add('collections', entry.collections);
  return mf;
}

async function createInShopify(shopifyData) {
  const { createShopifyProduct, createProductVariants } = require('../lib/shopify');

  const handle = shopifyData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tags = [shopifyData.category.replace('_', ' '), ...(shopifyData.ageGroups || ['adult'])];

  console.log('\n  Creating product in Shopify (DRAFT)...');
  const product = await createShopifyProduct({
    title: shopifyData.title,
    handle,
    productType: shopifyData.productType || 'Underwear',
    vendor: 'RUBIES',
    status: 'DRAFT',
    tags,
    descriptionHtml: shopifyData.description || `<p>${shopifyData.title} — coming soon.</p>`,
    metafields: buildMetafields(shopifyData),
  });

  console.log(`  Product created: ${product.title} (${product.id})`);

  if (shopifyData.sizes?.length && shopifyData.colors?.length) {
    const variants = generateVariants(shopifyData.sizes, shopifyData.colors, shopifyData.skuPrefix, shopifyData.price);
    console.log(`  Creating ${variants.length} variants...`);
    const created = await createProductVariants(product.id, variants);
    console.log(`  ${created.length} variants created.`);
  }

  const { getAdminUrl } = require('../lib/shopify');
  console.log(`  Admin: ${getAdminUrl(product.id)}`);

  return product.id;
}

async function syncToSupabase() {
  console.log('  Syncing products to Supabase...');
  const { run: syncProducts } = require('../sync/syncProducts');
  await syncProducts();
  console.log('  Sync complete.');
}

// ---------------------------------------------------------------------------
// Interactive add
// ---------------------------------------------------------------------------

async function interactiveAdd() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n━━━ RUBIES Product Management ━━━\n');

  // Template?
  const existing = await loadAllConfigs();
  let template = null;
  if (existing.length > 0) {
    const useTemplate = await askYesNo(rl, 'Use an existing product as a template?');
    if (useTemplate) {
      const names = existing.map(p => `${p.nickname} (${p.product_handle})`);
      const chosen = await pickOption(rl, 'Which product?', names);
      template = existing[names.indexOf(chosen)];
      console.log(`  Using "${template.nickname}" as template.`);
    }
  }

  // Title
  const title = (await ask(rl, '\nFull Shopify title: ')).trim();
  if (!title) { console.log('Title is required.'); rl.close(); return; }

  // Nickname
  const defaultNick = title.match(/^THE\s+(\w+)\s/i)?.[1];
  const nickPrompt = defaultNick ? `Nickname [${defaultNick}]: ` : 'Nickname: ';
  const nickname = (await ask(rl, nickPrompt)).trim() || defaultNick || '';
  if (!nickname) { console.log('Nickname is required.'); rl.close(); return; }

  // Handle
  const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Check if exists
  const existingEntry = await getConfig(handle);
  if (existingEntry) {
    console.log(`  Product "${handle}" already exists. Use --activate/--deactivate to manage.`);
    rl.close(); return;
  }

  // Category
  const category = await pickOption(rl, 'Category:', CATEGORIES);
  const catDefaults = CATEGORY_DEFAULTS[category] || {};

  // Keywords
  const defaultKws = [nickname.toLowerCase()];
  const kwInput = await ask(rl, `Match keywords (comma-separated) [${defaultKws.join(', ')}]: `);
  const keywords = kwInput.trim()
    ? kwInput.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    : defaultKws;

  // Age groups
  const ageGroups = [];
  if (category !== 'accessory' && category !== 'chest_pads') {
    if (await askYesNo(rl, 'Available in youth sizes?')) ageGroups.push('youth');
    if (await askYesNo(rl, 'Available in adult sizes?')) ageGroups.push('adult');
    if (ageGroups.length === 0) ageGroups.push('adult');
  }

  // Sizes
  const defaultSizes = catDefaults.sizes || [];
  console.log(`\nDefault sizes for ${category}: ${defaultSizes.join(', ') || 'none'}`);
  const customSizes = await askYesNo(rl, 'Use a custom size range instead?');
  const sizes = customSizes
    ? (await ask(rl, 'Enter sizes (comma-separated): ')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : defaultSizes;

  // Is this a non-standard range? (needs override)
  const isCustomRange = JSON.stringify(sizes) !== JSON.stringify(defaultSizes);
  const sizesOverride = isCustomRange ? sizes : null;

  // Delta wording
  const deltaWording = catDefaults.deltaWording
    ? (await ask(rl, `Delta wording [${catDefaults.deltaWording}] (${DELTA_WORDING_OPTIONS.join('/')}): `)).trim() || catDefaults.deltaWording
    : await pickOption(rl, 'Fabric delta wording:', DELTA_WORDING_OPTIONS);

  // Style switch
  let styleSwitch = null;
  if (category === 'underwear_bottom' || category === 'swim_bottom') {
    if (await askYesNo(rl, 'Recommend for tight legs (style switch)?')) {
      const note = (await ask(rl, 'Why? ')).trim() || '';
      styleSwitch = { isTarget: true, forCategories: [category], note };
    }
  }

  // ── Save CS config to Supabase ──
  await upsertConfig({
    product_handle: handle,
    nickname,
    category,
    keywords,
    delta_wording: deltaWording,
    sizes_override: sizesOverride,
    style_switch: styleSwitch,
    status: 'draft',
  });
  console.log(`\n  Saved CS config for "${nickname}" (status: draft)`);

  // ── Optionally create in Shopify ──
  if (await askYesNo(rl, 'Create product in Shopify as DRAFT?')) {
    // Need Shopify-specific fields
    const skuPrefix = (await ask(rl, `SKU prefix [${nickname.substring(0, 3).toUpperCase()}]: `)).trim().toUpperCase()
      || nickname.substring(0, 3).toUpperCase();
    const price = parseFloat(await ask(rl, 'Price: ')) || 0;

    console.log(`\nStandard colors: ${STANDARD_COLORS.map(c => `${c.name} (${c.code})`).join(', ')}`);
    const useStd = await askYesNo(rl, 'Use standard colors?');
    let colors = useStd ? [...STANDARD_COLORS] : [];
    if (!useStd) {
      const input = await ask(rl, 'Colors (Name:CODE, e.g. Black:BLK, Nude:NDE): ');
      colors = input.split(',').map(s => s.trim()).filter(Boolean).map(p => {
        const [name, code] = p.split(':').map(s => s.trim());
        return { name, code: (code || name.substring(0, 3)).toUpperCase() };
      });
    }

    const suggestedColl = COLLECTION_SUGGESTIONS[category] || [];
    console.log(`\nSuggested collections: ${suggestedColl.join(', ')}`);
    const collections = (await askYesNo(rl, 'Use these?')) ? [...suggestedColl]
      : (await ask(rl, 'Collections: ')).split(',').map(s => s.trim()).filter(Boolean);

    const description = (await ask(rl, 'Description (HTML, optional): ')).trim() || '';

    try {
      const shopifyId = await createInShopify({
        title: title.toUpperCase(), category, ageGroups, sizes, skuPrefix, price,
        colors, collections, description, productType: catDefaults.productType,
      });
      // Store Shopify ID in CS config for later activate/deactivate
      await upsertConfig({
        product_handle: handle, nickname, category, keywords,
        delta_wording: deltaWording, sizes_override: sizesOverride,
        style_switch: styleSwitch, status: 'draft',
      });
      await syncToSupabase();
    } catch (err) {
      console.error(`  Shopify creation failed: ${err.message}`);
    }
  }

  console.log(`\n  To activate: npm run cs-manage-product -- --activate ${handle}`);
  rl.close();
}

// ---------------------------------------------------------------------------
// Activate / Deactivate
// ---------------------------------------------------------------------------

async function activateProduct(handle) {
  const config = await getConfig(handle);
  if (!config) { console.error(`Product "${handle}" not found.`); process.exit(1); }
  if (config.status === 'active') { console.log(`"${config.nickname}" is already active.`); return; }

  await upsertConfig({ ...config, status: 'active' });

  console.log(`\n  Activated "${config.nickname}"`);
  console.log(`    - Category: ${config.category}`);
  console.log(`    - Keywords: ${config.keywords.join(', ')}`);
  if (config.sizes_override) console.log(`    - Size override: ${config.sizes_override.join(', ')}`);
  if (config.style_switch?.isTarget) console.log(`    - Style switch target`);

  // Activate in Shopify if possible
  try {
    // Find Shopify product by handle
    const supabase = getSupabaseClient();
    const { data: product } = await supabase
      .from('products')
      .select('shopify_product_id')
      .eq('handle', handle)
      .single();
    if (product?.shopify_product_id) {
      const { updateProductStatus } = require('../lib/shopify');
      await updateProductStatus(product.shopify_product_id, 'ACTIVE');
      console.log(`    - Shopify: DRAFT → ACTIVE`);
      await syncToSupabase();
    }
  } catch (err) {
    console.error(`    - Shopify activation failed: ${err.message}`);
  }

  updateSizingGuide(await loadAllConfigs());
  console.log(`    - Sizing guide KB: updated`);
  console.log(`\n  Run tests: npm run test:decision-tree`);
}

async function deactivateProduct(handle) {
  const config = await getConfig(handle);
  if (!config) { console.error(`Product "${handle}" not found.`); process.exit(1); }

  await upsertConfig({ ...config, status: 'draft' });

  try {
    const supabase = getSupabaseClient();
    const { data: product } = await supabase
      .from('products')
      .select('shopify_product_id')
      .eq('handle', handle)
      .single();
    if (product?.shopify_product_id) {
      const { updateProductStatus } = require('../lib/shopify');
      await updateProductStatus(product.shopify_product_id, 'DRAFT');
      console.log(`  Shopify: ACTIVE → DRAFT`);
      await syncToSupabase();
    }
  } catch (err) {
    console.error(`  Shopify deactivation failed: ${err.message}`);
  }

  updateSizingGuide(await loadAllConfigs());
  console.log(`  Deactivated "${config.nickname}" (back to draft).`);
}

// ---------------------------------------------------------------------------
// Create in Shopify (for existing config entries)
// ---------------------------------------------------------------------------

async function pushToShopify(handle) {
  const config = await getConfig(handle);
  if (!config) { console.error(`Product "${handle}" not found.`); process.exit(1); }

  // Check if already in Shopify (via products table)
  const supabase = getSupabaseClient();
  const { data: existing } = await supabase
    .from('products')
    .select('shopify_product_id')
    .eq('handle', handle)
    .single();
  if (existing) {
    console.log(`"${config.nickname}" already exists in Shopify.`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const catDefaults = CATEGORY_DEFAULTS[config.category] || {};

  console.log(`\n  Pushing "${config.nickname}" to Shopify. Need a few details:\n`);

  const title = (await ask(rl, 'Full Shopify title: ')).trim();
  if (!title) { console.log('Title is required.'); rl.close(); return; }

  const skuPrefix = (await ask(rl, `SKU prefix [${config.nickname.substring(0, 3).toUpperCase()}]: `)).trim().toUpperCase()
    || config.nickname.substring(0, 3).toUpperCase();
  const price = parseFloat(await ask(rl, 'Price: ')) || 0;
  const sizes = config.sizes_override || catDefaults.sizes || [];

  console.log(`\nStandard colors: ${STANDARD_COLORS.map(c => `${c.name} (${c.code})`).join(', ')}`);
  const useStd = await askYesNo(rl, 'Use standard colors?');
  const colors = useStd ? [...STANDARD_COLORS]
    : (await ask(rl, 'Colors (Name:CODE): ')).split(',').map(s => {
        const [name, code] = s.trim().split(':').map(s => s.trim());
        return { name, code: (code || name.substring(0, 3)).toUpperCase() };
      }).filter(c => c.name);

  const suggestedColl = COLLECTION_SUGGESTIONS[config.category] || [];
  console.log(`\nSuggested collections: ${suggestedColl.join(', ')}`);
  const collections = (await askYesNo(rl, 'Use these?')) ? [...suggestedColl]
    : (await ask(rl, 'Collections: ')).split(',').map(s => s.trim()).filter(Boolean);

  rl.close();

  try {
    await createInShopify({
      title: title.toUpperCase(), category: config.category, ageGroups: ['adult'],
      sizes, skuPrefix, price, colors, collections, productType: catDefaults.productType,
    });
    await syncToSupabase();
    console.log('  Product now visible in catalog.');
  } catch (err) {
    console.error(`  Shopify creation failed: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sizing guide update
// ---------------------------------------------------------------------------

function updateSizingGuide(configs) {
  if (!fs.existsSync(SIZING_GUIDE_PATH)) return;
  let guide = fs.readFileSync(SIZING_GUIDE_PATH, 'utf8');

  const active = configs.filter(p => p.status === 'active');
  const youthAdult = ['AJ', 'Charlie', 'Brooke', 'Ruby'];
  const adultOnly = ['Ava', 'Cheeky', 'Sassy'];

  for (const p of active) {
    // Skip products already in the base lists
    if ([...youthAdult, ...adultOnly].includes(p.nickname)) continue;
    if (p.category === 'accessory' || p.category === 'chest_pads') continue;

    const sizeNote = p.sizes_override?.length ? ` (${p.sizes_override[0]}–${p.sizes_override[p.sizes_override.length - 1]} only)` : '';
    adultOnly.push(p.nickname + sizeNote);
  }

  const newSection = `### Products by Sizing Type\n- **Youth + Adult sizing:** ${youthAdult.join(', ')} (available in both)\n- **Adult sizing only:** ${adultOnly.join(', ')}`;

  guide = guide.replace(
    /### Products by Sizing Type\n- \*\*Youth \+ Adult sizing:\*\*.*\n- \*\*Adult sizing only:\*\*.*/,
    newSection,
  );
  fs.writeFileSync(SIZING_GUIDE_PATH, guide);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function listProducts() {
  const configs = await loadAllConfigs();
  if (configs.length === 0) { console.log('No products in product_cs_config.'); return; }

  console.log('\n  Products in product_cs_config:\n');
  const header = '  HANDLE'.padEnd(50) + 'STATUS'.padEnd(10) + 'NAME'.padEnd(14) + 'CATEGORY'.padEnd(18) + 'SIZES OVERRIDE';
  console.log(header);
  console.log('  ' + '─'.repeat(95));
  for (const p of configs) {
    const status = p.status === 'active' ? '\x1b[32mactive\x1b[0m' : '\x1b[33mdraft\x1b[0m';
    const sizes = p.sizes_override?.length ? p.sizes_override.join(',') : '—';
    console.log(`  ${p.product_handle.padEnd(48)} ${status.padEnd(20)} ${p.nickname.padEnd(14)} ${p.category.padEnd(18)} ${sizes}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args[0] === '--activate' && args[1]) {
  activateProduct(args[1]).catch(console.error);
} else if (args[0] === '--deactivate' && args[1]) {
  deactivateProduct(args[1]).catch(console.error);
} else if (args[0] === '--create-shopify' && args[1]) {
  pushToShopify(args[1]).catch(console.error);
} else if (args[0] === '--list') {
  listProducts().catch(console.error);
} else if (args.length === 0) {
  interactiveAdd().catch(console.error);
} else {
  console.log('Usage:');
  console.log('  cs-manage-product                           # Interactive add');
  console.log('  cs-manage-product -- --activate <handle>    # Activate config + Shopify + KB');
  console.log('  cs-manage-product -- --deactivate <handle>  # Deactivate config + Shopify');
  console.log('  cs-manage-product -- --create-shopify <handle>  # Push to Shopify');
  console.log('  cs-manage-product -- --list                 # List all products');
}
