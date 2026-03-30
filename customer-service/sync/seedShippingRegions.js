#!/usr/bin/env node

/**
 * Seed shipping_regions table with US/CA region mapping + international fallback.
 *
 * Idempotent — upserts all rows. Run once, or re-run safely after changes.
 *
 * Usage:
 *   node customer-service/sync/seedShippingRegions.js
 *   npm run cs-seed-shipping-regions
 */

if (!process.env.SUPABASE_URL) require('dotenv').config();

const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// US regions (5) — grouped by proximity / shipping corridor
// ---------------------------------------------------------------------------
const US_REGIONS = {
  west_coast: {
    label: 'West Coast',
    states: ['WA', 'OR', 'CA', 'NV', 'AZ', 'HI', 'AK'],
  },
  mountain: {
    label: 'Mountain',
    states: ['MT', 'ID', 'WY', 'CO', 'UT', 'NM'],
  },
  midwest: {
    label: 'Midwest',
    states: ['ND', 'SD', 'NE', 'KS', 'MN', 'IA', 'MO', 'WI', 'IL', 'MI', 'IN', 'OH'],
  },
  south: {
    label: 'South',
    states: ['TX', 'OK', 'AR', 'LA', 'MS', 'AL', 'TN', 'KY', 'WV', 'VA', 'NC', 'SC', 'GA', 'FL'],
  },
  northeast: {
    label: 'Northeast',
    states: ['PA', 'NJ', 'NY', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME', 'MD', 'DE', 'DC'],
  },
};

// ---------------------------------------------------------------------------
// Canada regions (4)
// ---------------------------------------------------------------------------
const CA_REGIONS = {
  western_ca: {
    label: 'Western Canada',
    provinces: ['BC', 'AB'],
  },
  central_ca: {
    label: 'Central Canada',
    provinces: ['SK', 'MB', 'ON'],
  },
  eastern_ca: {
    label: 'Eastern Canada',
    provinces: ['QC'],
  },
  atlantic_ca: {
    label: 'Atlantic Canada',
    provinces: ['NB', 'NS', 'PE', 'NL', 'YT', 'NT', 'NU'],
  },
};

async function seed() {
  const supabase = getSupabaseClient();
  const rows = [];

  // US
  for (const [region, { label, states }] of Object.entries(US_REGIONS)) {
    for (const state of states) {
      rows.push({
        country_code: 'US',
        province_code: state,
        region,
        region_label: label,
      });
    }
  }

  // Canada
  for (const [region, { label, provinces }] of Object.entries(CA_REGIONS)) {
    for (const prov of provinces) {
      rows.push({
        country_code: 'CA',
        province_code: prov,
        region,
        region_label: label,
      });
    }
  }

  // International — pull countries from shipping_zones, one row per country with '*'
  const { data: zones } = await supabase
    .from('shipping_zones')
    .select('country_code, country_name, zone')
    .not('country_code', 'in', '("US","CA")');

  if (zones) {
    for (const z of zones) {
      rows.push({
        country_code: z.country_code,
        province_code: '*',
        region: z.zone,                // 'ddp' or 'ddu'
        region_label: z.country_name,  // e.g. 'Australia', 'United Kingdom'
      });
    }
  }

  // Upsert
  const { error } = await supabase
    .from('shipping_regions')
    .upsert(rows, { onConflict: 'country_code,province_code' });

  if (error) throw new Error(`Upsert failed: ${error.message}`);

  console.log(`Seeded ${rows.length} shipping regions`);
  console.log(`  US: ${Object.values(US_REGIONS).reduce((s, r) => s + r.states.length, 0)} states in ${Object.keys(US_REGIONS).length} regions`);
  console.log(`  CA: ${Object.values(CA_REGIONS).reduce((s, r) => s + r.provinces.length, 0)} provinces in ${Object.keys(CA_REGIONS).length} regions`);
  console.log(`  International: ${(zones || []).length} countries`);

  return rows.length;
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { seed };
