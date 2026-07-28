/**
 * Backfill donation_partners.description_short for partners that don't have
 * one yet (CS advisor emails use the short version; the website keeps the
 * full org-written description).
 *
 * Usage (from project root):
 *   node scripts/backfillDonationShortDescriptions.js           # preview only
 *   node scripts/backfillDonationShortDescriptions.js --save    # write to Supabase
 *   node scripts/backfillDonationShortDescriptions.js --all     # regenerate even if already set
 */

require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');
const { generateShortDescription } = require('../customer-service/lib/donationDescriptionShort');

const SAVE = process.argv.includes('--save');
const ALL = process.argv.includes('--all');

async function main() {
  const supabase = getSupabaseClient();
  let { data: partners, error } = await supabase
    .from('donation_partners')
    .select('id, name, country_code, description, description_short')
    .eq('active', true)
    .order('country_code')
    .order('name');
  // Preview still works before the schema migration has been applied — treat
  // every partner as missing description_short. Saving requires the column.
  let columnMissing = false;
  if (error && /description_short/.test(error.message)) {
    columnMissing = true;
    if (SAVE) throw new Error('description_short column does not exist yet — run the ALTER in customer-service/donation-partners-schema.sql (Supabase SQL Editor) before --save.');
    console.log('NOTE: description_short column not applied yet — previewing as if all partners need one.\n');
    ({ data: partners, error } = await supabase
      .from('donation_partners')
      .select('id, name, country_code, description')
      .eq('active', true)
      .order('country_code')
      .order('name'));
  }
  if (error) throw new Error(error.message);

  const targets = (partners || []).filter(p =>
    (p.description || '').trim() && (ALL || !(p.description_short || '').trim()));

  console.log(`${partners.length} active partners; ${targets.length} to ${ALL ? 'regenerate' : 'backfill'}.${SAVE ? '' : ' (preview — pass --save to write)'}\n`);

  for (const p of targets) {
    let short;
    try {
      short = await generateShortDescription({ name: p.name, description: p.description });
    } catch (e) {
      console.log(`✗ ${p.name} (#${p.id}) — generation failed: ${e.message}\n`);
      continue;
    }
    if (!short) {
      console.log(`✗ ${p.name} (#${p.id}) — empty result, skipped\n`);
      continue;
    }

    console.log(`— ${p.name} (#${p.id}, ${p.country_code})`);
    console.log(`  full  (${p.description.trim().length} chars): ${p.description.trim().slice(0, 140).replace(/\n/g, ' ')}...`);
    console.log(`  short (${short.length} chars): ${short}`);

    if (SAVE) {
      const { error: upErr } = await supabase
        .from('donation_partners')
        .update({ description_short: short, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      console.log(upErr ? `  SAVE FAILED: ${upErr.message}` : '  saved ✓');
    }
    console.log('');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
