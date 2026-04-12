require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

async function main() {
  const client = getSupabaseClient();

  // Get all place_ids from already-researched records
  const researched = [];
  let page = 0;
  const PAGE = 1000;
  while (true) {
    const { data } = await client
      .from('retailer_prospects')
      .select('google_place_id')
      .not('status', 'eq', 'found')
      .not('google_place_id', 'is', null)
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (!data || data.length === 0) break;
    researched.push(...data.map(r => r.google_place_id));
    if (data.length < PAGE) break;
    page++;
  }
  const donePlaceIds = new Set(researched);
  console.log('Already-researched place_ids:', donePlaceIds.size);

  // Get all found records with place_ids, in pages
  const toDelete = [];
  page = 0;
  while (true) {
    const { data } = await client
      .from('retailer_prospects')
      .select('id, company_name, google_place_id')
      .eq('status', 'found')
      .not('google_place_id', 'is', null)
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (donePlaceIds.has(r.google_place_id)) toDelete.push(r);
    }
    if (data.length < PAGE) break;
    page++;
  }

  console.log('Stuck duplicate found records:', toDelete.length);

  // Delete in batches of 100
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 100) {
    const batch = toDelete.slice(i, i + 100).map(r => r.id);
    const { error } = await client.from('retailer_prospects').delete().in('id', batch);
    if (error) { console.log('Error:', error.message); continue; }
    deleted += batch.length;
  }

  console.log('Deleted:', deleted, 'duplicate found records');

  // Final counts
  const { count: foundCount } = await client
    .from('retailer_prospects')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'found');
  console.log('Remaining found:', foundCount);
}

main().catch(e => console.log(e.message));
