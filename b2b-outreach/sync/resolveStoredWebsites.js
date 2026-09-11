/**
 * resolveStoredWebsites.js — look behind every stored shortener or link-in-bio
 * URL in b2b_companies and donation_partners, and store what is actually there.
 *
 * A row whose `website` identifies nobody is invisible to every domain join we
 * have: partner matching, inbound correlation, duplicate detection at intake.
 * The denylist has always known these values are unusable; nothing ever went
 * and looked behind one. addProspect now resolves at intake, so this is the
 * catch-up for rows that predate it, and the sweep for values that change.
 *
 * Print-only by default. Writes only where there is a real domain behind the
 * link: a bio page whose only destinations are social profiles is REPORTED and
 * left alone, because that org genuinely has no website and writing
 * `instagram.com` into the column would fuse every such org into one company.
 *
 *   node b2b-outreach/sync/resolveStoredWebsites.js          # print only
 *   node b2b-outreach/sync/resolveStoredWebsites.js --write  # apply
 */
require('dotenv').config();
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { resolveWebsite, needsResolving } = require('../lib/resolveWebsite');

const TABLES = [
  { table: 'b2b_companies', column: 'website', label: 'company' },
  { table: 'donation_partners', column: 'website_url', label: 'partner' },
];

async function run({ write = false, sb = getSupabaseClient() } = {}) {
  const resolved = [];
  const deadEnds = [];
  const errors = [];

  for (const { table, column, label } of TABLES) {
    const rows = await fetchAllPaginated(() =>
      sb.from(table).select(`id, name, ${column}`).not(column, 'is', null).order('id'));

    for (const row of rows) {
      const value = row[column];
      if (!needsResolving(value)) continue;

      const r = await resolveWebsite(value);
      if (r.via === 'error') {
        errors.push({ label, id: row.id, name: row.name, value, error: r.error });
        continue;
      }
      if (!r.domain) {
        // Not a failure — a finding. Reported every run so it stays visible that
        // this org cannot be matched on domain by anyone.
        deadEnds.push({ label, id: row.id, name: row.name, value, socials: r.socials });
        continue;
      }
      if (write) {
        const { error } = await sb.from(table).update({ [column]: r.url }).eq('id', row.id);
        if (error) { errors.push({ label, id: row.id, name: row.name, value, error: error.message }); continue; }
      }
      resolved.push({ label, id: row.id, name: row.name, from: value, to: r.url, via: r.via });
    }
  }

  return { resolved, deadEnds, errors, write };
}

module.exports = { run };

if (require.main === module) {
  const write = process.argv.includes('--write');
  run({ write }).then(r => {
    console.log(`${write ? 'WROTE' : 'DRY RUN'} — ${r.resolved.length} resolved, ${r.deadEnds.length} with nothing behind them, ${r.errors.length} lookup failures`);
    for (const x of r.resolved) console.log(`  ${x.label} ${x.id}: ${x.from} → ${x.to} (${x.via})`);
    if (r.deadEnds.length) {
      console.log('\nNo real website behind these — they cannot be matched on domain by anything:');
      for (const x of r.deadEnds) console.log(`  ${x.label} ${x.id} (${x.name}): ${x.value}${x.socials.length ? ` — only ${x.socials.join(', ')}` : ''}`);
    }
    if (r.errors.length) {
      console.log('\nLookup failed (left alone):');
      for (const x of r.errors) console.log(`  ${x.label} ${x.id}: ${x.value} — ${x.error}`);
    }
    if (!write && r.resolved.length) console.log('\nRe-run with --write to apply.');
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
