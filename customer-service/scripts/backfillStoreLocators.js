#!/usr/bin/env node

/**
 * One-time backfill: populate store locator fields on existing b2b_companies
 * rows from the data previously hand-authored in assets/store-locators.json
 * on the feature/store-locator branch of rubies-ecom-v4.
 *
 * After this runs, b2b_companies becomes the SSOT and the JSON is regenerated
 * by store_locator_publish / publishStoreLocators.js.
 *
 * Usage:
 *   node customer-service/scripts/backfillStoreLocators.js          # dry run (print matches)
 *   node customer-service/scripts/backfillStoreLocators.js --save   # write to DB
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');

function normalizeDomain(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/^www\./, '');
  return s;
}

// Data from feature/store-locator:assets/store-locators.json (commit 498c1915)
// Empty imageUrl strings are stored as null in the DB.
const ENTRIES = [
  {
    storeUrl: 'https://sockdrawerheroes.com',
    locator_display_name: null,
    locator_display_address: 'Physical location currently closed as they are in transition',
    locator_description: "Sock Drawer Heroes is Australia's leading gender expression store, stocking binding and tucking gear, swimwear, and gender-affirming wear. Founded by a trans and gender diverse team, they prioritize community support and discreet shipping.",
    locator_hours: null,
    locator_products: ['swimwear', 'underwear'],
    locator_logo_url: null,
    latitude: -33.8883,
    longitude: 151.1579,
  },
  {
    storeUrl: 'https://illusionslingerie.com.au',
    locator_display_name: 'Illusions Lingerie',
    locator_display_address: '22 Puckle Street\nMoonee Ponds VIC 3039\nAustralia',
    locator_description: "A Melbourne lingerie boutique that has specialized in expert bra fitting since 1983, with extensive sizing for all bodies. Walk-ins are always welcome, and fittings need no appointment.",
    locator_hours: 'Mon-Fri 9am-4pm, Sat 9am-4pm, Sun Closed',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: -37.7669,
    longitude: 144.924,
  },
  {
    storeUrl: 'https://early2bed.com',
    locator_display_name: null,
    locator_display_address: '5138 N Clark St\nChicago, IL 60640',
    locator_description: "Early to Bed is a feminist and inclusive sex shop in Chicago that has served the community for over twenty years. The shop offers a thoughtfully curated selection of body-safe products and gender-affirming items in a welcoming, judgment-free space.",
    locator_hours: 'Mon-Thu 11am-7pm, Fri-Sat 11am-8pm, Sun 11am-7pm',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: 41.9755,
    longitude: -87.6685,
  },
  {
    storeUrl: 'https://underdare.me',
    locator_display_name: null,
    locator_display_address: 'Minneapolis, MN',
    locator_description: "Underdare is the Twin Cities' first in-person shopping experience for gender-affirming undergarments, offering a private appointment-only setting where customers can try on and purchase items from multiple brands in inclusive sizing.",
    locator_hours: 'By appointment only, book via underdare.me',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: 44.9778,
    longitude: -93.265,
  },
  {
    storeUrl: 'https://sheboptheshop.com',
    locator_display_name: null,
    locator_display_address: '909 N Beech Street, Suite A\nPortland, OR 97227',
    locator_description: "She Bop is a Portland-based adult boutique founded in 2009 that specializes in body-safe toys, books, and sensuality products. Beyond retail, they offer sex education classes, workshops, and resources for a diverse community, creating a welcoming and inclusive environment.",
    locator_hours: 'Sun 12-8pm, Mon-Wed 12-7pm, Thu 12-8pm, Fri 12-9pm, Sat 12-9pm',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: 45.5497,
    longitude: -122.676,
  },
  {
    storeUrl: 'https://transting.dk',
    locator_display_name: null,
    locator_display_address: 'Buens Bogcafe\nAalborg, Denmark',
    locator_description: "Transting is a Danish webshop specializing in gender-affirming wear. You can try products in person at Buens Bogcafe in Aalborg, Denmark's oldest LGBT+ bookstore, where you can also make purchases and enjoy coffee.",
    locator_hours: 'Mon-Thu 7pm-8pm (phone hours)',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: 57.0502,
    longitude: 9.9216,
  },
  {
    storeUrl: 'https://toolshedtoys.com',
    locator_display_name: null,
    locator_display_address: '2427 N Murray Ave\nMilwaukee, WI 53211\nUnited States',
    locator_description: "The Tool Shed is an erotic boutique serving Milwaukee since 2004, offering a curated selection of toys, wellness products, gender-affirming items, and educational resources. The store provides helpful guides, classes, and customer support to help customers make informed choices.",
    locator_hours: 'Mon-Sat 12-8pm, Sun 12-5pm',
    locator_products: ['underwear'],
    locator_logo_url: null,
    latitude: 43.062,
    longitude: -87.8858,
  },
];

async function main() {
  const save = process.argv.includes('--save');
  const supabase = getSupabaseClient();

  // Fetch all b2b_companies for domain matching.
  const { data: companies, error } = await supabase
    .from('b2b_companies')
    .select('id, name, website')
    .limit(5000);
  if (error) {
    console.error('Failed to fetch b2b_companies:', error.message);
    process.exit(1);
  }

  // Step 0: rename Transitting → Transting
  const transitting = companies.find(c => normalizeDomain(c.website) === 'transting.dk');
  if (transitting && transitting.name !== 'Transting') {
    if (save) {
      const { error: renameErr } = await supabase
        .from('b2b_companies')
        .update({ name: 'Transting', updated_at: new Date().toISOString() })
        .eq('id', transitting.id);
      if (renameErr) {
        console.error(`  ✗ Failed to rename "${transitting.name}" → "Transting": ${renameErr.message}`);
      } else {
        console.log(`  ✓ Renamed "${transitting.name}" → "Transting" (${transitting.id})`);
        transitting.name = 'Transting';
      }
    } else {
      console.log(`  [dry run] Would rename "${transitting.name}" → "Transting" (${transitting.id})`);
    }
  }

  let matched = 0;
  let failed = 0;

  for (const entry of ENTRIES) {
    const domain = normalizeDomain(entry.storeUrl);
    const row = companies.find(c => normalizeDomain(c.website) === domain);

    if (!row) {
      console.log(`  ✗ No b2b_companies row for domain "${domain}" (${entry.storeUrl})`);
      failed++;
      continue;
    }

    const patch = {
      on_store_locator: true,
      locator_display_name: entry.locator_display_name,
      locator_display_address: entry.locator_display_address,
      locator_description: entry.locator_description,
      locator_hours: entry.locator_hours,
      locator_products: entry.locator_products,
      locator_logo_url: entry.locator_logo_url,
      latitude: entry.latitude,
      longitude: entry.longitude,
      updated_at: new Date().toISOString(),
    };

    if (save) {
      const { error: updateErr } = await supabase
        .from('b2b_companies')
        .update(patch)
        .eq('id', row.id);
      if (updateErr) {
        console.log(`  ✗ ${row.name} (${row.id}): ${updateErr.message}`);
        failed++;
      } else {
        console.log(`  ✓ ${row.name} (${row.id}) → on_store_locator=true${entry.locator_display_name ? ` display="${entry.locator_display_name}"` : ''}`);
        matched++;
      }
    } else {
      console.log(`  [dry run] ${row.name} (${row.id}) ← ${domain}${entry.locator_display_name ? ` (display: "${entry.locator_display_name}")` : ''}`);
      matched++;
    }
  }

  console.log('');
  console.log(`${save ? 'Saved' : 'Matched'}: ${matched}/${ENTRIES.length}${failed ? `  Failed: ${failed}` : ''}`);
  if (!save) {
    console.log('');
    console.log('Run with --save to write to the database.');
  } else {
    console.log('');
    console.log('Verify: node scripts/sb.js "sb.from(\'b2b_companies\').select(\'id,name,on_store_locator\').eq(\'on_store_locator\', true)"');
  }
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
