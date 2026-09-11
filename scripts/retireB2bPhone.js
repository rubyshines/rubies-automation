#!/usr/bin/env node
/**
 * retireB2bPhone.js — empty `b2b_companies.phone`.
 *
 * The column was 242 junk values out of 286: `2147483647` (INT32_MAX) on nine
 * companies, `3333333333` on five, one number on fourteen unrelated businesses.
 * The cause was the discovery scraper matching a bare ten-digit run anywhere in
 * raw HTML, so asset hashes, build ids and numbers inside shared third-party
 * scripts all read as phone numbers.
 *
 * The first plan was to clean it. The better answer was Jamie's: we never phone
 * a retailer. Every route we actually use is email or their contact form
 * (`contact_method` has only ever been email / form / none), the store locator
 * publishes its own `locator_display_address` and no phone, and wholesale
 * orders never read one. A field nobody uses cannot be worth the cost of
 * keeping it honest — so it is not cleaned, it is retired.
 *
 * Nothing writes it any more: the page scrape is gone from `contactFinder`,
 * `importProspects` no longer carries one into the book, and the signature
 * harvest no longer asks for one. The column stays in the schema, empty, the
 * same way `b2b_contacts.role` was retired.
 *
 * What is lost: around 90 of the values were real shop numbers. They are on the
 * retailer's own website, one click from the company's `website` on the panel,
 * so this is recoverable by hand for the one company where it ever matters.
 *
 * Usage: node scripts/retireB2bPhone.js [--live]   (print-only by default)
 */
require('dotenv').config();
const { getSupabaseClient } = require('../shared/supabaseClient');

async function main() {
  const live = process.argv.includes('--live');
  const sb = getSupabaseClient();

  const { data: rows, error } = await sb.from('b2b_companies')
    .select('id, name, phone').not('phone', 'is', null);
  if (error) throw new Error(error.message);

  console.log(`${rows.length} companies carry a phone number.`);
  for (const r of rows.slice(0, 10)) console.log(`  ${String(r.name).slice(0, 40).padEnd(42)} ${r.phone}`);
  if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);

  if (!live) {
    console.log('\nRe-run with --live to clear them.');
    return;
  }
  for (const r of rows) {
    const { error: uErr } = await sb.from('b2b_companies')
      .update({ phone: null, updated_at: new Date().toISOString() }).eq('id', r.id);
    if (uErr) throw new Error(`${r.id}: ${uErr.message}`);
  }
  console.log(`\nCleared ${rows.length} phone numbers.`);
}

main().catch(err => { console.error(err); process.exit(1); });
