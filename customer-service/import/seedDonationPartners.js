#!/usr/bin/env node

/**
 * Seed Donation Partners
 *
 * Scrapes the 13 partner organizations from the RUBIES donation page
 * and inserts them into the donation_partners table in Supabase.
 *
 * Usage:
 *   node customer-service/import/seedDonationPartners.js
 *   node customer-service/import/seedDonationPartners.js --refresh  # clear + re-seed
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Hardcoded partner data (scraped from rubyshines.com/pages/donate-your-pre-loved-rubies-clothing)
// Hardcoding avoids runtime scraping fragility — re-run this script when partners change.
// ---------------------------------------------------------------------------

const PARTNERS = [
  {
    name: 'Trans* Open Wardrobe',
    country_code: 'CH',
    region: 'Bern',
    city: 'Bern',
    address: 'c/o dazwischen, Mattenhofstrasse 5, 3007 Bern',
    description: 'Provides gender-affirming items for free in Switzerland for trans, non-binary and gender-diverse people.',
  },
  {
    name: 'LGBT Center of Raleigh',
    country_code: 'US',
    region: 'North Carolina',
    city: 'Raleigh',
    address: '128 East Cabarrus Street, Raleigh, NC 27601',
    description: 'Operates a free gender affirming clothing closet.',
  },
  {
    name: 'TransPonder',
    country_code: 'US',
    region: 'Oregon',
    city: 'Eugene',
    address: '440 Maxwell Rd, Eugene, OR 97404',
    description: "Runs Sylvia's Closet, providing free new and used binders, bras, wigs, lashes, breast forms, packers.",
  },
  {
    name: 'Valid USA',
    country_code: 'US',
    region: 'Arizona',
    city: 'Tucson',
    address: 'PO Box 14061, Tucson, AZ 85732',
    description: 'Provides free gender-affirming undergarments such as chest binders, packers, shaping underwear.',
  },
  {
    name: 'OUT MetroWest',
    country_code: 'US',
    region: 'Massachusetts',
    city: 'Framingham',
    address: '160 Hollis St, Framingham, MA 01702',
    description: 'Maintains bins with various gender affirming care items.',
  },
  {
    name: 'Rainbow Youth Center',
    country_code: 'US',
    region: 'Colorado',
    city: 'Durango',
    address: '701 S Camino Del Rio, Suite 108, Durango, CO 81301',
    description: 'Hosts a queer closet with free gender-affirming products.',
  },
  {
    name: 'Oasis Youth Center',
    country_code: 'US',
    region: 'Washington',
    city: 'Tacoma',
    address: '2215 Pacific Ave, Tacoma, WA 98402',
    description: 'Provides supportive services including gender affirming supports.',
  },
  {
    name: 'BAGLY',
    country_code: 'US',
    region: 'Massachusetts',
    city: 'Boston',
    address: '28 Court Square, Boston, MA 02108',
    description: 'Offers clothing and sizing help for gender-affirming wear.',
  },
  {
    name: 'Massachusetts Transgender Political Coalition',
    country_code: 'US',
    region: 'Massachusetts',
    city: 'Boston',
    address: 'PO Box 960784, Boston, MA 02196',
    description: 'Runs G.E.A.R. program providing trans and non-binary people with access to products at no cost.',
  },
  {
    name: 'Skipping Stone',
    country_code: 'CA',
    region: 'Alberta',
    city: 'Calgary',
    address: '407 2 St SW, Unit 1250, Calgary, AB T2P 2Y3',
    description: 'Provides high-quality gender affirming gear including binders, breast forms, gaffs, and packers.',
  },
  {
    name: 'McMinnville Trans Network',
    country_code: 'US',
    region: 'Oregon',
    city: 'McMinnville',
    address: '624 NE 3rd St, McMinnville, OR 97128',
    description: 'Operates a free community closet for gender-affirming products.',
  },
  {
    name: 'Transformation Closet with Sexual Health Nova Scotia',
    country_code: 'CA',
    region: 'Nova Scotia',
    city: 'Halifax',
    address: '7071 Bayers Rd., Suite 302, Halifax, NS B3L 2C1',
    description: 'Provides free, low barrier access to gender-affirming gear.',
  },
  {
    name: 'Yellow House Student Centre for Equity and Inclusion',
    country_code: 'CA',
    region: 'Ontario',
    city: 'Kingston',
    address: '207 Stuart Street, Rideau Building 3rd Floor, Kingston, ON K7L 2V9',
    description: 'Student centre providing gender-affirming resources and support.',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const supabase = getSupabaseClient();

  if (refresh) {
    console.log('Clearing existing donation partners...');
    const { error: delErr } = await supabase
      .from('donation_partners')
      .delete()
      .neq('id', 0); // delete all
    if (delErr) {
      console.error('Failed to clear:', delErr.message);
      process.exit(1);
    }
  }

  console.log(`\nSeeding ${PARTNERS.length} donation partners...\n`);

  let seeded = 0;
  for (const partner of PARTNERS) {
    const { data, error } = await supabase
      .from('donation_partners')
      .upsert({
        ...partner,
        active: true,
        donations_routed: 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'name' }) // name is practically unique
      .select();

    if (error) {
      // If upsert on name fails (no unique constraint), try insert
      const { error: insertErr } = await supabase
        .from('donation_partners')
        .insert({
          ...partner,
          active: true,
          donations_routed: 0,
        });

      if (insertErr) {
        console.error(`  [Error] ${partner.name}: ${insertErr.message}`);
        continue;
      }
    }

    seeded++;
    console.log(`  ✓ ${partner.name} (${partner.city}, ${partner.country_code})`);
  }

  console.log(`\n========================================`);
  console.log(`Seeded ${seeded}/${PARTNERS.length} donation partners`);
  console.log(`========================================`);

  // Verify
  const { data: count } = await supabase
    .from('donation_partners')
    .select('id', { count: 'exact', head: true });

  console.log(`\nTotal partners in DB: ${count?.length ?? 'unknown'}`);

  // Show country breakdown
  const { data: partners } = await supabase
    .from('donation_partners')
    .select('country_code')
    .eq('active', true);

  if (partners) {
    const byCountry = {};
    for (const p of partners) {
      byCountry[p.country_code] = (byCountry[p.country_code] || 0) + 1;
    }
    console.log('By country:', byCountry);
  }
}

main().catch(err => {
  console.error('[seedDonationPartners] Fatal error:', err);
  process.exit(1);
});
