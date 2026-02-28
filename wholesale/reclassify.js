require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

async function main() {
  const client = getSupabaseClient();

  const { data } = await client
    .from('retailer_prospects')
    .select('id, company_name, subcategory, status, raw_profile')
    .not('status', 'eq', 'found');

  const BOOKSTORE = /\b(bookstore|bookshop|books|book shop|library shop)\b/i;
  const VINTAGE = /\b(vintage|thrift|consignment|secondhand|second-hand|resale|used clothing)\b/i;
  const COMMUNITY = /\b(pflag|pride center|resource center|community center|lgbtq center|trans closet|free closet|clothing bank|shelter|clinic|hospital|medical center|health center)\b/i;
  const COLLECTIVE = /\b(collective|maker space|multi-designer|pop-up market|artisan market)\b/i;

  let bookstores = 0, vintage = 0, community = 0, collectives = 0;

  for (const p of data) {
    const text = (p.company_name + ' ' + (p.raw_profile || '')).toLowerCase();
    let newSubcat = null;
    let newStatus = null;

    if (BOOKSTORE.test(text) && p.subcategory !== 'bookstore') {
      newSubcat = 'bookstore'; newStatus = 'dismissed'; bookstores++;
    } else if (VINTAGE.test(text) && p.subcategory !== 'vintage-thrift') {
      newSubcat = 'vintage-thrift'; newStatus = 'dismissed'; vintage++;
    } else if (COMMUNITY.test(text) && p.subcategory !== 'community-org') {
      newSubcat = 'community-org'; newStatus = 'community-partner'; community++;
    } else if (COLLECTIVE.test(text) && p.subcategory !== 'collective') {
      newSubcat = 'collective'; collectives++;
    }

    if (newSubcat) {
      const update = { subcategory: newSubcat };
      if (newStatus) update.status = newStatus;
      await client.from('retailer_prospects').update(update).eq('id', p.id);
    }
  }

  console.log('Updated:');
  console.log(' bookstore:', bookstores);
  console.log(' vintage-thrift:', vintage);
  console.log(' community-org → community-partner:', community);
  console.log(' collective:', collectives);
}

main().catch(e => console.log(e.message));
